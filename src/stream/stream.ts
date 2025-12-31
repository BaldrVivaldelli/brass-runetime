// ----- ADT de Stream -----

import {
    catchAll,
    fail,
    flatMap,
    map,
    mapError,
    orElseOptional,
    succeed,
    ZIO,
} from "../types/effect.js";
import { none, Option, some } from "../types/option.js";
import {Async, asyncFail, asyncFlatMap, asyncFold, asyncMapError, asyncSucceed} from "../types/asyncEffect";


export type Empty<R, E, A> = { readonly _tag: "Empty" };

export type Emit<R, E, A> = {
    readonly _tag: "Emit";
    readonly value: ZIO<R, E, A>;
};

export type Concat<R, E, A> = {
    readonly _tag: "Concat";
    readonly left: ZStream<R, E, A>;
    readonly right: ZStream<R, E, A>;
};

export type Flatten<R, E, A> = {
    readonly _tag: "Flatten";
    readonly stream: ZStream<R, E, ZStream<R, E, A>>;
};

export type FromPull<R, E, A> = {
    readonly _tag: "FromPull";
    readonly pull: ZIO<R, Option<E>, [A, ZStream<R, E, A>]>;
};

export type ZStream<R, E, A> =
    | Empty<R, E, A>
    | Emit<R, E, A>
    | Concat<R, E, A>
    | FromPull<R, E, A>
    | Flatten<R, E, A>;

const widenOpt = <E1, E2>(opt: Option<E1>): Option<E1 | E2> =>
    opt._tag === "None" ? none : some(opt.value as E1 | E2);

export const fromPull = <R, E, A>(
    pull: ZIO<R, Option<E>, [A, ZStream<R, E, A>]>
): ZStream<R, E, A> => ({
    _tag: "FromPull",
    pull,
});

export const emptyStream = <R, E, A>(): ZStream<R, E, A> => ({
    _tag: "Empty",
});

export const emitStream = <R, E, A>(value: ZIO<R, E, A>): ZStream<R, E, A> => ({
    _tag: "Emit",
    value,
});

export const concatStream = <R, E, A>(
    left: ZStream<R, E, A>,
    right: ZStream<R, E, A>
): ZStream<R, E, A> => ({
    _tag: "Concat",
    left,
    right,
});

export const flattenStream = <R, E, A>(
    stream: ZStream<R, E, ZStream<R, E, A>>
): ZStream<R, E, A> => ({
    _tag: "Flatten",
    stream,
});

// ----- uncons: ZIO[R, Option[E], (A, ZStream)] -----

export function uncons<R, E, A>(
    self: ZStream<R, E, A>
): ZIO<R, Option<E>, [A, ZStream<R, E, A>]> {
    switch (self._tag) {
        case "Empty":
            return fail<Option<E>>(none);

        case "Emit":
            return map(
                mapError<R, E, Option<E>, A>(self.value, (e) => some<E>(e)),
                (a: A): [A, ZStream<R, E, A>] => [a, emptyStream<R, E, A>()]
            );

        case "FromPull":
            return self.pull;

        case "Concat":
            return orElseOptional(
                map(
                    uncons(self.left),
                    ([a, tail]): [A, ZStream<R, E, A>] => [a, concatStream<R, E, A>(tail, self.right)]
                ),
                () => uncons(self.right)
            );

        case "Flatten":
            return flatMap(uncons(self.stream), ([head, tail]) =>
                orElseOptional(
                    map(
                        uncons(head),
                        ([a, as]): [A, ZStream<R, E, A>] => [
                            a,
                            concatStream<R, E, A>(as, flattenStream<R, E, A>(tail)),
                        ]
                    ),
                    () => uncons(flattenStream<R, E, A>(tail))
                )
            );
    }
}


// ---------- combinadores extra opcionales ----------

export function mapStream<R, E, A, B>(
    self: ZStream<R, E, A>,
    f: (a: A) => B
): ZStream<R, E, B> {
    switch (self._tag) {
        case "Empty":
            return emptyStream<R, E, B>();

        case "Emit":
            return emitStream<R, E, B>(map(self.value, f));

        case "FromPull":
            return fromPull(
                map(self.pull, ([a, tail]): [B, ZStream<R, E, B>] => [
                    f(a),
                    mapStream(tail, f),
                ])
            );

        case "Concat":
            return concatStream<R, E, B>(
                mapStream(self.left, f),
                mapStream(self.right, f)
            );

        case "Flatten": {
            const mappedOuter: ZStream<R, E, ZStream<R, E, B>> = mapStream(
                self.stream,
                (inner) => mapStream(inner, f)
            );
            return flattenStream<R, E, B>(mappedOuter);
        }
    }
}

export function rangeStream(start: number, end: number): ZStream<unknown, never, number> {
    const go = (i: number): ZStream<unknown, never, number> =>
        fromPull(
            i > end
                ? asyncFail(none)
                : asyncSucceed([i, go(i + 1)])
        );

    return go(start);
}



export function zip<R, E1, A, E2, B>(
    left: ZStream<R, E1, A>,
    right: ZStream<R, E2, B>
): ZStream<R, E1 | E2, [A, B]> {
    const pull: Async<
        R,
        Option<E1 | E2>,
        [[A, B], ZStream<R, E1 | E2, [A, B]>]
    > = asyncFold(
        asyncMapError(uncons(left), (opt: Option<E1>) => widenOpt<E1, E2>(opt)),
        // si left termina o falla, el zip termina/falla igual
        (opt: Option<E1 | E2>) => asyncFail(opt),
        ([a, tailL]) =>
            asyncFold(
                asyncMapError(uncons(right), (opt: Option<E2>) => widenOpt<E2, E1>(opt)),
                (opt: Option<E1 | E2>) => asyncFail(opt),
                ([b, tailR]) =>
                    asyncSucceed([
                        [a, b] as [A, B],
                        zip(tailL as any, tailR as any),
                    ] as [[A, B], ZStream<R, E1 | E2, [A, B]>])
            )
    );

    return fromPull(pull);
}


export function foreachStream<R, E, A, R2, E2>(
    stream: ZStream<R, E, A>,
    f: (a: A) => Async<R2, E2, void>
): Async<R & R2, E | E2, void> {
    // loop falla con Option<E|E2> (fin = None, error real = Some(e))
    const loop = (cur: ZStream<R, E, A>): Async<R & R2, Option<E | E2>, void> =>
        asyncFold(
            // uncons: Option<E> -> Option<E|E2>
            asyncMapError(uncons(cur), (opt: Option<E>) => widenOpt<E, E2>(opt)),
            (opt: Option<E | E2>) => {
                // None => fin
                if (opt._tag === "None") return asyncSucceed(undefined);
                // Some(e) => mantener Option en el loop
                return asyncFail(opt);
            },
            ([a, tail]) =>
                asyncFlatMap(
                    // f(a): E2 -> Option<E|E2>
                    asyncMapError(f(a), (e2: E2) => some(e2 as E | E2)),
                    () => loop(tail)
                )
        );

    // salida final: Option<E|E2> -> E|E2 (None no debería llegar como failure)
    return asyncFold(
        loop(stream),
        (opt: Option<E | E2>) => {
            if (opt._tag === "None") return asyncSucceed(undefined) as any;
            return asyncFail(opt.value);
        },
        () => asyncSucceed(undefined)
    ) as Async<R & R2, E | E2, void>;
}

export function fromArray<A>(values: readonly A[]): ZStream<unknown, never, A> {
    let s: ZStream<unknown, never, A> = emptyStream<unknown, never, A>();

    for (let i = values.length - 1; i >= 0; i--) {
        const head = emitStream<unknown, never, A>(succeed(values[i]!));
        s = concatStream<unknown, never, A>(head, s);
    }

    return s;
}

// Consumidor síncrono del stream
export function collectStream<R, E, A>(stream: ZStream<R, E, A>): ZIO<R, E, A[]> {
    const loop = (cur: ZStream<R, E, A>, acc: A[]): ZIO<R, Option<E>, A[]> =>
        asyncFold(
            uncons(cur), // ZIO<R, Option<E>, [A, ZStream<R,E,A>]>
            (opt: Option<E>) => {
                // None => fin del stream
                if (opt._tag === "None") return succeed(acc);
                // Some(e) => error real (mantenemos Option<E>)
                return fail(opt);
            },
            ([a, tail]) => loop(tail, [...acc, a])
        );

    // Convertimos Option<E> -> E (None no debería ocurrir porque se maneja como success arriba)
    return mapError(loop(stream, []), (opt) => {
        if (opt._tag === "Some") return opt.value;
        throw new Error("unreachable: stream end handled as success");
    });
}