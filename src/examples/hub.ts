import {Async, asyncCatchAll, asyncFlatMap, asyncSync} from "../core/types/asyncEffect";
import {makeHub} from "../core/stream/hub";
import {fork, unsafeRunAsync} from "../core/runtime/runtime";
import {QueueClosed} from "../core/stream/queue";

const log = (msg: string): Async<unknown, any, void> =>
    asyncSync(() => console.log(msg));


const isQueueClosed = (e: unknown): e is QueueClosed =>
    typeof e === "object" && e !== null && (e as any)._tag === "QueueClosed";

const consumer = <A>(
    name: string,
    sub: { take: () => Async<unknown, any, A> }
) => {
    const loop = (): Async<unknown, any, void> =>
        asyncCatchAll(
            asyncFlatMap(sub.take(), (a) =>
                asyncFlatMap(log(`[${name}] got ${String(a)}`), () => loop())
            ),
            (e) =>
                isQueueClosed(e)
                    ? log(`[${name}] closed`)
                    : log(`[${name}] ERROR ${String(e)}`)
        );

    return loop();
};

const hub = makeHub<number>(8, "Dropping"); // para broadcast suele ir mejor Dropping/Sliding

const program =
    asyncFlatMap(hub.subscribe(), (sub1) =>
        asyncFlatMap(hub.subscribe(), (sub2) =>
            asyncSync(() => {
                const f1 = fork(consumer("sub-1", sub1), {});
                const f2 = fork(consumer("sub-2", sub2), {});

                // Publicar algunos eventos
                unsafeRunAsync(
                    asyncFlatMap(log("[main] publish 1..5"), () =>
                        hub.publishAll([1, 2, 3, 4, 5])
                    ),
                    {},
                    () => {
                        // Cerramos el hub => ambas colas se apagan => ambos consumers terminan
                        unsafeRunAsync(hub.shutdown(), {}, () => {
                            f1.join(() => console.log("[main] joined sub-1"));
                            f2.join(() => console.log("[main] joined sub-2"));
                        });
                    }
                );
            })
        )
    );

unsafeRunAsync(program, {}, (exit) => {
    console.log("[main] done:", exit);
});
