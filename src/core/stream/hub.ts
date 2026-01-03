// src/hub.ts
import {
    Async,
    asyncSucceed,
    asyncFlatMap,
    asyncTotal,
    asyncSync
} from "../types/asyncEffect";
import { bounded, Queue, Strategy } from "./queue";

export type HubStrategy = "BackPressure" | "Dropping" | "Sliding";

export type HubClosed = { _tag: "HubClosed" };

export type Subscription<A> = Queue<A> & {
    unsubscribe: () => void;
};

export type Hub<A> = {
    publish: (a: A) => Async<unknown, never, boolean>;
    publishAll: (as: Iterable<A>) => Async<unknown, never, boolean>;
    subscribe: () => Async<unknown, HubClosed, Subscription<A>>;
    shutdown: () => Async<unknown, any, void>;
};

const toQueueStrategy = (s: HubStrategy): Strategy =>
    s === "BackPressure"
        ? "backpressure"
        : s === "Dropping"
            ? "dropping"
            : "sliding";

export function makeHub<A>(
    capacity: number,
    strategy: HubStrategy = "BackPressure"
): Hub<A> {
    const queues = new Set<Queue<A>>();
    let closed = false;

    const publish = (a: A): Async<unknown, never, boolean> => {
        if (closed) return asyncSucceed(false);

        const snapshot = Array.from(queues);

        let eff: Async<unknown, never, boolean> = asyncSucceed(true);
        snapshot.forEach((q) => {
            eff = asyncFlatMap(eff, (okSoFar) =>
                asyncFlatMap(q.offer(a), (ok) => asyncSucceed(okSoFar && ok))
            );
        });

        return eff;
    };


    const publishAll = (as: Iterable<A>): Async<unknown, never, boolean> => {
        let eff = asyncSucceed(true);

        const it = as[Symbol.iterator]();
        while (true) {
            const n = it.next();
            if (n.done) break;

            const a = n.value;
            eff = asyncFlatMap(eff, (okSoFar) =>
                asyncFlatMap(publish(a), (ok) => asyncSucceed(okSoFar && ok))
            );
        }

        return eff;
    };



    const subscribe = (): Async<unknown, any, any> => {
        if (closed) {
            return asyncTotal(() => {
                throw { _tag: "HubClosed" } satisfies HubClosed;
            });
        }

        return asyncFlatMap(
            bounded<A>(capacity, toQueueStrategy(strategy)),
            (q) =>
                asyncSync(() => {
                    queues.add(q);

                    return {
                        ...q,
                        unsubscribe: () => {
                            if (!queues.has(q)) return;
                            queues.delete(q);
                            q.shutdown();
                        },
                    } satisfies Subscription<A>;
                })
        );
    };


    const shutdown = (): Async<unknown, any, void> =>
        asyncSync(() => {
            if (closed) return;
            closed = true;
            Array.from(queues).forEach((q) => q.shutdown());
            queues.clear();
        });


    return {
        publish,
        publishAll,
        subscribe,
        shutdown,
    };
}
