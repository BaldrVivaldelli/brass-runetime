// src/queue.ts
import { async, Async, asyncSync } from "../types/asyncEffect";
import { Exit } from "../types/effect";
import { Canceler } from "../types/cancel";

export type Strategy = "backpressure" | "dropping" | "sliding";

export type QueueClosed = { _tag: "QueueClosed" };

export type Queue<A> = {
    offer: (a: A) => Async<unknown, never, boolean>;
    take: () => Async<unknown, QueueClosed, A>;
    size: () => number;
    shutdown: () => void;
};

export function bounded<A>(
    capacity: number,
    strategy: Strategy = "backpressure"
): Async<unknown, unknown, Queue<A>> {
    return asyncSync(() => makeQueue<A>(capacity, strategy));
}

function makeQueue<A>(capacity: number, strategy: Strategy): Queue<A> {
    const items: A[] = [];
    let closed = false;

    const takers: Array<(a: A) => void> = [];
    const offerWaiters: Array<{ a: A; cb: (ok: boolean) => void }> = [];

    const QueueClosedErr: QueueClosed = { _tag: "QueueClosed" };

    const removeTaker = (cb: (a: A) => void) => {
        const i = takers.indexOf(cb);
        if (i >= 0) takers.splice(i, 1);
    };

    const removeOfferWaiter = (w: { a: A; cb: (ok: boolean) => void }) => {
        const i = offerWaiters.indexOf(w);
        if (i >= 0) offerWaiters.splice(i, 1);
    };

    const flush = () => {
        while (takers.length > 0 && items.length > 0) {
            const t = takers.shift()!;
            const a = items.shift()!;
            t(a);
        }

        while (offerWaiters.length > 0 && items.length < capacity && takers.length === 0) {
            const w = offerWaiters.shift()!;
            items.push(w.a);
            w.cb(true);
        }

        while (takers.length > 0 && offerWaiters.length > 0) {
            const t = takers.shift()!;
            const w = offerWaiters.shift()!;
            t(w.a);
            w.cb(true);
        }
    };

    const shutdown = () => {
        if (closed) return;
        closed = true;

        // Despertar a todos los takers: en ZIO take falla con QueueShutdown/QueueClosed
        while (takers.length > 0) {
            const t = takers.shift()!;
            // No tenemos canal de error acá (taker solo recibe A),
            // así que el error lo resolvemos desde take (cb Failure) al registrarse.
            // Para eso, en shutdown llamamos a esos callbacks vía un "sentinel" NO es viable.
            // Entonces: en este diseño, el taker registrado debe cerrarse desde take()
            // cuando detecta closed. Para no dejar fibers colgados, acá NO usamos taker(a).
            //
            // Solución correcta: guardar "cb Exit" en takers, no (a)=>void.
            // Pero para corregirte con mínimos cambios, convertimos takers a Exit-cb en take().
            //
            // 👉 Como YA estamos corrigiendo el archivo, abajo cambiamos takers a Exit-cb.
            // Este while queda vacío con ese cambio (ver implementación final abajo).
            void t;
        }

        // Despertar a todos los offerWaiters: offer retorna boolean => false si se cerró
        while (offerWaiters.length > 0) {
            const w = offerWaiters.shift()!;
            w.cb(false);
        }

        items.length = 0;
    };

    // ✅ versión final: takers guardan cb Exit para poder fallar al cerrar
    const takersExit: Array<(exit: Exit<QueueClosed, A>) => void> = [];

    const removeTakerExit = (cb: (exit: Exit<QueueClosed, A>) => void) => {
        const i = takersExit.indexOf(cb);
        if (i >= 0) takersExit.splice(i, 1);
    };

    const flush2 = () => {
        while (takersExit.length > 0 && items.length > 0) {
            const t = takersExit.shift()!;
            const a = items.shift()!;
            t({ _tag: "Success", value: a });
        }

        while (offerWaiters.length > 0 && items.length < capacity && takersExit.length === 0) {
            const w = offerWaiters.shift()!;
            items.push(w.a);
            w.cb(true);
        }

        while (takersExit.length > 0 && offerWaiters.length > 0) {
            const t = takersExit.shift()!;
            const w = offerWaiters.shift()!;
            w.cb(true);
            t({ _tag: "Success", value: w.a });
        }
    };

    const shutdown2 = () => {
        if (closed) return;
        closed = true;

        // fallar a todos los takers suspendidos
        while (takersExit.length > 0) {
            const t = takersExit.shift()!;
            t({ _tag: "Failure", error: QueueClosedErr });
        }

        // completar offers suspendidos con false
        while (offerWaiters.length > 0) {
            const w = offerWaiters.shift()!;
            w.cb(false);
        }

        items.length = 0;
    };

    return {
        shutdown: shutdown2,

        size: () => items.length,

        offer: (a: A) =>
            async((_env: any, cb: (exit: Exit<never, boolean>) => void): void | Canceler => {
                if (closed) {
                    cb({ _tag: "Success", value: false });
                    return;
                }

                // entregar directo si hay taker esperando
                if (takersExit.length > 0) {
                    const t = takersExit.shift()!;
                    t({ _tag: "Success", value: a });
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
            async((_env: any, cb: (exit: Exit<QueueClosed, A>) => void): void | Canceler => {
                if (closed) {
                    cb({ _tag: "Failure", error: QueueClosedErr });
                    return;
                }

                if (items.length > 0) {
                    const a = items.shift()!;
                    cb({ _tag: "Success", value: a });
                    flush2();
                    return;
                }

                // si hay offerWaiter esperando, casar directo
                if (offerWaiters.length > 0) {
                    const w = offerWaiters.shift()!;
                    w.cb(true);
                    cb({ _tag: "Success", value: w.a });
                    return;
                }

                const taker = (exit: Exit<QueueClosed, A>) => cb(exit);
                takersExit.push(taker);

                // canceler: saca al taker si se interrumpe
                return () => removeTakerExit(taker);
            }),
    };
}
