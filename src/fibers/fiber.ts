// src/fiber.ts
import {Exit} from "../types/effect";
import {Async, asyncSync} from "../types/asyncEffect";
import {globalScheduler, Scheduler} from "../scheduler/scheduler";
import { asyncSucceed, asyncFlatMap } from "../types/asyncEffect";

export type FiberId = number;
export type FiberStatus = "Running" | "Done" | "Interrupted";
export type Interrupted = { readonly _tag: "Interrupted" };

export type Fiber<E, A> = {
    readonly id: FiberId;
    readonly status: () => FiberStatus;
    readonly join: (cb: (exit: Exit<E | Interrupted, A>) => void) => void;
    readonly interrupt: () => void;
    readonly addFinalizer: (f: (exit: Exit<E | Interrupted, A>) => void) => void;
};



let nextId: FiberId = 1;

export type BrassError =
    | { _tag: "Abort" }
    | { _tag: "PromiseRejected"; reason: unknown };


class RuntimeFiber<R, E, A> implements Fiber<E, A> {
    readonly id: FiberId;

    private closing: Exit<E | Interrupted, A> | null = null;
    private finishing = false;
    private statusValue: FiberStatus = "Running";
    private interrupted = false;

    private result: Exit<E | Interrupted, A> | null = null;
    private readonly joiners: Array<(exit: Exit<E | Interrupted, A>) => void> = [];

    // estado de evaluación
    private current: Async<R, E, any>;
    private readonly env: R;
    private readonly stack: (
        | { _tag: "SuccessCont"; k: (a: any) => Async<R, E, any> }
        | { _tag: "FoldCont"; onFailure: (e: any) => Async<R, E, any>; onSuccess: (a: any) => Async<R, E, any> }
        )[] = [];

    private readonly fiberFinalizers: Array<(exit: Exit<E | Interrupted, A>) => void> = [];


    private scheduled = false;
    private finalizersDrained = false;

    private blockedOnAsync = false;

    constructor(effect: Async<R, E, A>, env: R, private readonly scheduler: Scheduler) {
        this.id = nextId++;
        this.current = effect;
        this.env = env;
    }

    addFinalizer(f: (exit: Exit<E | Interrupted, A>) => void): void {
        this.fiberFinalizers.push(f);
    }



    status(): FiberStatus {
        return this.statusValue;
    }

    join(cb: (exit: Exit<E | Interrupted, A>) => void): void {
        if (this.result != null) cb(this.result);
        else this.joiners.push(cb);
    }

    interrupt(): void {
        if (this.result != null) return;
        if (this.interrupted) return;
        this.interrupted = true;
        this.blockedOnAsync = false;
        this.schedule("interrupt-step");
    }


    schedule(tag: string = "step"): void {
        if (this.result != null) return;
        if (this.scheduled) return;

        this.scheduled = true;

        this.scheduler.schedule(() => {
            this.scheduled = false;
            this.step();
        }, `fiber#${this.id}.${tag}`);
    }

    private runFinalizersOnce(exit: Exit<E | Interrupted, A>): void {
        if (this.finalizersDrained) return;
        this.finalizersDrained = true;

        while (this.fiberFinalizers.length > 0) {
            const fin = this.fiberFinalizers.pop()!;
            try { fin(exit); } catch {}
        }
    }


    private notify(exit: Exit<E | Interrupted, A>): void {
        if (this.result != null) return;
        if (this.closing != null) return;

        this.finishing = true;
        this.closing = exit;

        // ✅ ejecutar finalizers YA (garantiza clearInterval)
        this.runFinalizersOnce(exit);

        // completar
        this.statusValue = this.interrupted ? "Interrupted" : "Done";
        this.result = exit;

        for (const j of this.joiners) j(exit);
        this.joiners.length = 0;
    }




    private onSuccess(value: any): void {
        const frame = this.stack.pop();
        if (!frame) {
            this.notify({ _tag: "Success", value } as any);
            return;
        }
        this.current = frame._tag === "SuccessCont" ? frame.k(value) : frame.onSuccess(value);
    }

    private onFailure(error: any): void {
        while (this.stack.length > 0) {
            const frame = this.stack.pop()!;
            if (frame._tag === "FoldCont") {
                this.current = frame.onFailure(error);
                return;
            }
        }
        this.notify({ _tag: "Failure", error } as any);
    }

    step(): void {
        if (this.result != null) return;

        if (this.blockedOnAsync) return;

        if (this.interrupted && this.closing == null) {
            this.notify({ _tag: "Failure", error: { _tag: "Interrupted" } as any } as any);
            return;
        }

        const current = this.current;

        switch (current._tag) {
            case "Succeed":
                this.onSuccess(current.value);
                return;

            case "Fail":
                this.onFailure(current.error);
                return;

            case "Sync":
                try {
                    const v = current.thunk(this.env);
                    this.onSuccess(v);
                } catch (e) {
                    this.onFailure(e);
                }
                return;

            case "FlatMap":
                this.stack.push({ _tag: "SuccessCont", k: current.andThen });
                this.current = current.first;
                return;

            case "Fold":
                this.stack.push({ _tag: "FoldCont", onFailure: current.onFailure, onSuccess: current.onSuccess });
                this.current = current.first;
                return;


            case "Async": {
                if (this.finishing) return;

                this.blockedOnAsync = true;

                let pending: Exit<any, any> | null = null;
                let completedSync = false;

                const resume = () => {
                    if (!pending) return;
                    const exit = pending;
                    pending = null;

                    this.blockedOnAsync = false;

                    if (this.result != null || this.closing != null) return;

                    if (this.interrupted) {
                        this.onFailure({ _tag: "Interrupted" } as Interrupted);
                        return;
                    }

                    if (exit._tag === "Success") this.onSuccess(exit.value);
                    else this.onFailure(exit.error);

                    this.schedule("async-resume");
                };

                const canceler = current.register(this.env, (exit) => {
                    // guardamos el resultado, pero NO ejecutamos todavía
                    pending = exit;
                    completedSync = true;
                    // no llamamos resume acá
                });

                if (typeof canceler === "function") {
                    this.addFinalizer((_exit) => {
                        try { canceler(); } catch {}
                    });
                }

                if (completedSync) {
                    this.scheduler.schedule(resume, `fiber#${this.id}.async-sync-resume`);
                }

                return;
            }


        }
    }
}



export function fork<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    scheduler: Scheduler = globalScheduler
): Fiber<E, A> {
    const fiber = new RuntimeFiber(effect, env, scheduler);
    fiber.schedule("initial-step");
    return fiber;
}


// “correr” un Async como antes, pero apoyado en fibras + scheduler
export function unsafeRunAsync<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    cb: (exit: Exit<E | Interrupted, A>) => void
): void {
    const fiber = fork(effect, env);
    fiber.join(cb);
}
