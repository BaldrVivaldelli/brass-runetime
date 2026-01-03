// src/fiber.ts
import { Exit } from "../types/effect";
import { Async } from "../types/asyncEffect";
import { globalScheduler, Scheduler } from "./scheduler";

export type FiberId = number;
export type Interrupted = { readonly _tag: "Interrupted" };

export type FiberStatus = "Running" | "Done" | "Interrupted";

type StepDecision = "Continue" | "Suspend" | "Done";

type RunState = "Queued" | "Running" | "Suspended" | "Done";

const STEP = {
    CONTINUE: "Continue",
    SUSPEND: "Suspend",
    DONE: "Done",
} as const satisfies Record<string, StepDecision>;

const RUN = {
    QUEUED: "Queued",
    RUNNING: "Running",
    SUSPENDED: "Suspended",
    DONE: "Done",
} as const satisfies Record<string, RunState>;

export type Fiber<E, A> = {
    readonly id: FiberId;
    readonly status: () => FiberStatus;
    readonly join: (cb: (exit: Exit<E | Interrupted, A>) => void) => void;
    readonly interrupt: () => void;
    readonly addFinalizer: (f: (exit: Exit<E | Interrupted, A>) => void) => void;
};

let nextId: FiberId = 1;

// cuántos opcodes sync procesamos antes de ceder al scheduler
const DEFAULT_BUDGET = 1024;

// evita que un flatMap "left-associated" empuje N frames antes de correr
function reassociateFlatMap<R, E, A>(
    cur: Async<R, E, A>
): Async<R, E, A> {
    // Rotación: FlatMap(FlatMap(x,f), g) => FlatMap(x, a => FlatMap(f(a), g))
    let current = cur;
    while (current._tag === "FlatMap" && current.first._tag === "FlatMap") {
        const inner = current.first;
        const g = current.andThen;

        current = {
            _tag: "FlatMap",
            first: inner.first,
            andThen: (a: any) => ({
                _tag: "FlatMap",
                first: inner.andThen(a),
                andThen: g,
            }),
        } as any;
    }
    return current;
}

export class RuntimeFiber<R, E, A> implements Fiber<E, A> {
    readonly id: FiberId;

    private closing: Exit<E | Interrupted, A> | null = null;
    private finishing = false;

    private runState: RunState = RUN.RUNNING;

    private interrupted = false;
    private result: Exit<E | Interrupted, A> | null = null;

    private readonly joiners: Array<(exit: Exit<E | Interrupted, A>) => void> = [];

    // estado de evaluación
    private current: Async<R, E, any>;
    private readonly env: R;
    private readonly stack: (
        | { _tag: "SuccessCont"; k: (a: any) => Async<R, E, any> }
        | {
        _tag: "FoldCont";
        onFailure: (e: any) => Async<R, E, any>;
        onSuccess: (a: any) => Async<R, E, any>;
    }
        )[] = [];

    private readonly fiberFinalizers: Array<(exit: Exit<E | Interrupted, A>) => void> = [];
    private finalizersDrained = false;

    constructor(effect: Async<R, E, A>, env: R, private readonly scheduler: Scheduler) {
        this.id = nextId++;
        this.current = effect;
        this.env = env;
    }


    addFinalizer(f: (exit: Exit<E | Interrupted, A>) => void): void {
        this.fiberFinalizers.push(f);
    }

    status(): FiberStatus {
        if (this.result == null) return "Running";
        return this.interrupted ? "Interrupted" : "Done";
    }

    join(cb: (exit: Exit<E | Interrupted, A>) => void): void {
        if (this.result != null) cb(this.result);
        else this.joiners.push(cb);
    }

    interrupt(): void {
        if (this.result != null) return;
        if (this.interrupted) return;
        this.interrupted = true;
        this.schedule("interrupt-step");
    }

    schedule(tag: string = "step"): void {
        /*console.log("[fiber.schedule]", {
            fiber: this.id,
            tag,
            runState: this.runState,
            schedulerCtor: this.scheduler?.constructor?.name,
            schedulerScheduleType: typeof (this.scheduler as any)?.schedule,
        });*/

        // ya terminó o ya está en cola: no hacer nada
        if (this.runState === RUN.DONE || this.runState === RUN.QUEUED) return;

        // encolamos
        this.runState = RUN.QUEUED;

        this.scheduler.schedule(() => {
            /*console.log("[fiber.task] running", this.id);*/

            if (this.runState === RUN.DONE) return;
            this.runState = RUN.RUNNING;

            const decision = this.step();

            switch (decision) {
                case STEP.CONTINUE:
                    // seguir cooperativamente
                    this.schedule("continue");
                    return;

                case STEP.SUSPEND:
                    // queda esperando async; el callback re-encola con schedule("async-resume")
                    this.runState = RUN.SUSPENDED;
                    return;

                case STEP.DONE:
                    this.runState = RUN.DONE;
                    return;
            }
        }, `fiber#${this.id}.${tag}`);
    }

    private runFinalizersOnce(exit: Exit<E | Interrupted, A>): void {
        if (this.finalizersDrained) return;
        this.finalizersDrained = true;

        while (this.fiberFinalizers.length > 0) {
            const fin = this.fiberFinalizers.pop()!;
            try {
                fin(exit);
            } catch {}
        }
    }

    private notify(exit: Exit<E | Interrupted, A>): void {
        if (this.result != null) return;
        if (this.closing != null) return;

        this.finishing = true;
        this.closing = exit;

        // ejecutar finalizers YA
        this.runFinalizersOnce(exit);

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

    step(): StepDecision {
        // Si querés, parametrizalo por env/flag/debug.
        let budget = DEFAULT_BUDGET;

        while (budget-- > 0) {
            // ya terminó
            if (this.result != null) return STEP.DONE;

            // interrupción gana si no estamos cerrando
            if (this.interrupted && this.closing == null) {
                this.notify({ _tag: "Failure", error: { _tag: "Interrupted" } as any } as any);
                return STEP.DONE;
            }

            // IMPORTANTE: re-asociar flatMap para stack-safety tipo ZIO
            const current = reassociateFlatMap(this.current);

            switch (current._tag) {
                case "Succeed": {
                    this.onSuccess((current as any).value);
                    break;
                }

                case "Fail": {
                    this.onFailure((current as any).error);
                    break;
                }

                case "Sync": {
                    try {
                        const v = (current as any).thunk(this.env);
                        this.onSuccess(v);
                    } catch (e) {
                        this.onFailure(e);
                    }
                    break;
                }

                case "FlatMap": {
                    // (ya re-asociado arriba)
                    this.stack.push({ _tag: "SuccessCont", k: (current as any).andThen });
                    this.current = (current as any).first;
                    break;
                }

                case "Fold": {
                    this.stack.push({
                        _tag: "FoldCont",
                        onFailure: (current as any).onFailure,
                        onSuccess: (current as any).onSuccess,
                    });
                    this.current = (current as any).first;
                    break;
                }

                case "Async": {
                    // boundary async: acá sí suspendemos
                    if (this.finishing) {
                        // normalmente no vas a llegar acá con finishing=true porque notify pone result,
                        // pero lo mantenemos por compatibilidad con tu lógica.
                        return this.result != null ? STEP.DONE : STEP.CONTINUE;
                    }

                    let done = false;

                    const cb = (exit: Exit<any, any>) => {
                        if (done) return;
                        done = true;

                        if (this.result != null || this.closing != null) return;

                        this.current =
                            exit._tag === "Success"
                                ? ({ _tag: "Succeed", value: exit.value } as any)
                                : ({ _tag: "Fail", error: exit.error } as any);

                        this.schedule("async-resume");
                    };


                    const canceler = (current as any).register(this.env, cb);

                    if (typeof canceler === "function") {
                        this.addFinalizer(() => {
                            done = true;
                            try {
                                canceler();
                            } catch {}
                        });
                    }

                    return STEP.SUSPEND;
                }
            }
        }

        // si llegamos acá, agotamos budget => cedemos cooperativamente
        return this.result != null ? STEP.DONE : STEP.CONTINUE;
    }
}

