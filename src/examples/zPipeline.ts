// tests/pipeline.spec.ts (o scripts/pipeline.test.ts)

import {
    andThen,
    compose,
    identity,
    via,
    mapP,
    filterP,
    filterMapP,
    takeP,
    dropP,
    mapEffectP,
    tapEffectP,
    groupedP,
    bufferP,
} from "../core/stream/pipeline";

import {
    collectStream,
    fromArray,
    // si tenés emit/succeedStream etc podés sumarlos
} from "../core/stream/stream";

import { toPromise } from "../core/runtime/runtime";
import { asyncSync, asyncFail } from "../core/types/asyncEffect";

// ------------------------
// helpers de aserción
// ------------------------
function assert(cond: unknown, msg: string) {
    if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function deepEqual(a: any, b: any) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function assertDeepEqual(actual: unknown, expected: unknown, msg: string) {
    if (!deepEqual(actual, expected)) {
        console.error("Expected:", expected);
        console.error("Actual  :", actual);
        throw new Error(`ASSERT FAIL: ${msg}`);
    }
}

async function run(name: string, f: () => Promise<void>) {
    try {
        await f();
        console.log(`✅ ${name}`);
    } catch (e) {
        console.error(`❌ ${name}`);
        throw e;
    }
}

// ------------------------
// tests
// ------------------------
async function test_identity_via() {
    const s = via(fromArray([1, 2, 3]), identity<number>());
    const out = await toPromise(collectStream(s), {});
    assertDeepEqual(out, [1, 2, 3], "identity should not change elements");
}

async function test_map_filter_take_drop() {
    // ((n*2) |> filter even multiples of 4 |> drop 1 |> take 2)
    const p = andThen(
        mapP((n: number) => n * 2),
        andThen(
            filterP((n) => n % 4 === 0),
            andThen(dropP<number>(1), takeP<number>(2))
        )
    );

    // input: 1..10
    // map*2: 2,4,6,8,10,12,14,16,18,20
    // filter %4==0: 4,8,12,16,20
    // drop1: 8,12,16,20
    // take2: 8,12
    const s = via(fromArray([1,2,3,4,5,6,7,8,9,10]), p);
    const out = await toPromise(collectStream(s), {});
    assertDeepEqual(out, [8, 12], "map/filter/drop/take composition");
}

async function test_grouped() {
    const p = groupedP<number>(3);
    const s = via(fromArray([1,2,3,4,5,6,7]), p);
    const out = await toPromise(collectStream(s), {});
    // groupedP devuelve arrays (chunks) de tamaño 3, último puede ser menor
    assertDeepEqual(out, [[1,2,3],[4,5,6],[7]], "grouped(3) should chunk");
}

async function test_buffer_preserves_order() {
    const p = bufferP<number>(8, "backpressure");
    const s = via(fromArray([1,2,3,4,5,6,7,8,9,10]), p);
    const out = await toPromise(collectStream(s), {});
    assertDeepEqual(out, [1,2,3,4,5,6,7,8,9,10], "buffer should preserve order");
}

async function test_andThen_vs_compose_equivalence() {
    const p1 = mapP((n: number) => n + 1);
    const p2 = mapP((n: number) => n * 10);

    const a = andThen(p1, p2);     // (n+1) then (*10)
    const b = compose(p2, p1);     // same meaning

    const s1 = via(fromArray([1,2,3]), a);
    const s2 = via(fromArray([1,2,3]), b);

    const o1 = await toPromise(collectStream(s1), {});
    const o2 = await toPromise(collectStream(s2), {});
    assertDeepEqual(o1, o2, "andThen(p1,p2) should equal compose(p2,p1)");
    assertDeepEqual(o1, [20, 30, 40], "sanity check for composition");
}

async function test_mapEffect_sequential_and_error() {
    // mapEffect: si encuentra 4 falla
    const p = mapEffectP((n: number) => {
        if (n === 4) return asyncFail("boom" as any); // ajustá el tipo de error si querés
        return asyncSync(() => n * 2);
    });

    const s = via(fromArray([1,2,3,4,5]), p);

    let failed = false;
    try {
        await toPromise(collectStream(s), {});
    } catch (e) {
        failed = true;
    }
    assert(failed, "mapEffect should fail the stream on effect failure");
}

async function test_tapEffect_observes_without_changing() {
    const seen: number[] = [];

    const p = tapEffectP((n: number) =>
        asyncSync(() => {
            seen.push(n);
        })
    );

    const s = via(fromArray([1,2,3]), p);
    const out = await toPromise(collectStream(s), {});
    assertDeepEqual(out, [1,2,3], "tapEffect should not change elements");
    assertDeepEqual(seen, [1,2,3], "tapEffect should observe all elements in order");
}

// Un test más “integrador” (como tu ejemplo)
async function test_big_pipeline_like_example() {
    const p =
        andThen(
            mapP((n: number) => n * 2),
            andThen(
                filterP((n) => n % 3 === 0),
                andThen(
                    bufferP<number>(64, "backpressure"),
                    groupedP<number>(5)
                )
            )
        );

    const s = via(fromArray([1,2,3,4,5,6,7,8,9,10]), p);

    const out = await toPromise(collectStream(s), {});
    // map*2: 2..20
    // filter %3==0: 6,12,18
    // grouped(5): [[6,12,18]]
    assertDeepEqual(out, [[6,12,18]], "example pipeline should match expected output");
}

// ------------------------
// runner
// ------------------------
(async () => {
    await run("identity + via", test_identity_via);
    await run("map/filter/take/drop", test_map_filter_take_drop);
    await run("grouped", test_grouped);
    await run("buffer preserves order", test_buffer_preserves_order);
    await run("andThen vs compose", test_andThen_vs_compose_equivalence);
    await run("mapEffect error", test_mapEffect_sequential_and_error);
    await run("tapEffect observe", test_tapEffect_observes_without_changing);
    await run("big pipeline example", test_big_pipeline_like_example);

    console.log("\nAll pipeline tests passed ✅");
})();
