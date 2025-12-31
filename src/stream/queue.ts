// src/queue.ts
import {async, Async, asyncSync} from "../types/asyncEffect";
import {Exit} from "../types/effect";
import {Canceler} from "../types/cancel";

export type Strategy = "backpressure" | "dropping" | "sliding";

export type Queue<A> = {
    offer: (a: A) => Async<unknown, never, boolean>;
    take: () => Async<unknown, never, A>;
    size: () => number;
};

export function bounded<A>(
    capacity: number,
    strategy: Strategy = "backpressure"
): Async<unknown, unknown, Queue<A>> {
    return asyncSync(() => makeQueue<A>(capacity, strategy));
}

function makeQueue<A>(capacity: number, strategy: Strategy): Queue<A> {
    const items: A[] = [];
    const takers: Array<(a: A) => void> = [];
    const offerWaiters: Array<{ a: A; cb: (ok: boolean) => void }> = [];

    const removeTaker = (cb: (a: A) => void) => {
        const i = takers.indexOf(cb);
        if (i >= 0) takers.splice(i, 1);
    };

    const removeOfferWaiter = (w: { a: A; cb: (ok: boolean) => void }) => {
        const i = offerWaiters.indexOf(w);
        if (i >= 0) offerWaiters.splice(i, 1);
    };

    const flush = () => {
        // casar items -> takers
        while (takers.length > 0 && items.length > 0) {
            const t = takers.shift()!;
            const a = items.shift()!;
            t(a);
        }
        // si hay espacio, liberar offerWaiters (backpressure)
        while (offerWaiters.length > 0 && items.length < capacity && takers.length === 0) {
            const w = offerWaiters.shift()!;
            items.push(w.a);
            w.cb(true);
        }
        // casar directo offerWaiters -> takers
        while (takers.length > 0 && offerWaiters.length > 0) {
            const t = takers.shift()!;
            const w = offerWaiters.shift()!;
            t(w.a);
            w.cb(true);
        }
    };

    return {
        size: () => items.length,

        offer: (a: A) =>
            async((_env: any, cb: (exit: Exit<never, boolean>) => void): void | Canceler => {
                // entregar directo si hay taker esperando
                if (takers.length > 0) {
                    const t = takers.shift()!;
                    t(a);
                    cb({ _tag: "Success", value: true });
                    return;
                }

                // hay espacio -> encolar
                if (items.length < capacity) {
                    items.push(a);
                    cb({ _tag: "Success", value: true });
                    return;
                }

                // lleno -> estrategia
                if (strategy === "dropping") {
                    cb({ _tag: "Success", value: false });
                    return;
                }

                if (strategy === "sliding") {
                    items.shift();
                    items.push(a);
                    cb({ _tag: "Success", value: true });
                    return;
                }

                // backpressure: suspender
                const waiter = { a, cb: (ok: boolean) => cb({ _tag: "Success", value: ok }) };
                offerWaiters.push(waiter);

                // canceler: saca al waiter si se interrumpe
                return () => removeOfferWaiter(waiter);
            }),

        take: () =>
            async((_env: any, cb: (exit: Exit<never, A>) => void): void | Canceler => {
                if (items.length > 0) {
                    const a = items.shift()!;
                    cb({ _tag: "Success", value: a });
                    flush();
                    return;
                }

                // si hay offerWaiter esperando, casar directo
                if (offerWaiters.length > 0) {
                    const w = offerWaiters.shift()!;
                    w.cb(true);
                    cb({ _tag: "Success", value: w.a });
                    return;
                }

                const taker = (a: A) => cb({ _tag: "Success", value: a });
                takers.push(taker);

                // canceler: saca al taker si se interrumpe
                return () => removeTaker(taker);
            }),
    };
}
