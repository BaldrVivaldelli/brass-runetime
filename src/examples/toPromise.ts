import {buffer} from "../core/stream/buffer";
import {collectStream, rangeStream} from "../core/stream/stream";
import {toPromise} from "../core/runtime/runtime";


async function testBuffer() {
    const s = rangeStream(1, 10);
    const sb = buffer(s, 4, "backpressure");

    const out = await toPromise(collectStream(sb), undefined as any);
    console.log(out);
}

testBuffer().catch(console.error);
