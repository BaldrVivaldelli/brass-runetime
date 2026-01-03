// scheduler.ts
import { RingBuffer } from "./ringBuffer";

export type Task = () => void;

type TaggedTask = { tag: string; task: Task };

// Tunables
const FLUSH_BUDGET = 2048;      // max tasks por flush
const MICRO_THRESHOLD = 4096;   // si backlog supera esto, preferí macro

const scheduleMacro = (() => {
    // Node
    if (typeof (globalThis as any).setImmediate === "function") {
        return (f: () => void) => (globalThis as any).setImmediate(f);
    }
    // Browser/Node
    if (typeof (globalThis as any).MessageChannel === "function") {
        const ch = new (globalThis as any).MessageChannel();
        let cb: null | (() => void) = null;
        ch.port1.onmessage = () => { const f = cb; cb = null; f?.(); };
        return (f: () => void) => { cb = f; ch.port2.postMessage(0); };
    }
    return (f: () => void) => setTimeout(f, 0);
})();

export class Scheduler {
    private queue = new RingBuffer<TaggedTask>(1024);

    private flushing = false;
    private scheduled = false; // hay un flush ya programado

    schedule(task: Task, tag: string = "anonymous"): void {
        if (typeof task !== "function") return;

        this.queue.push({ tag, task });

        // si estamos adentro de flush, no programes más: el loop ya está drenando
        if (this.flushing) return;

        if (!this.scheduled) {
            this.scheduled = true;
            const kind = this.queue.length > MICRO_THRESHOLD ? "macro" : "micro";
            this.requestFlush(kind);
        }
    }

    private requestFlush(kind: "micro" | "macro"): void {
        if (kind === "micro") queueMicrotask(() => this.flush());
        else scheduleMacro(() => this.flush());
    }

    private flush(): void {
        if (this.flushing) return;

        this.flushing = true;
        this.scheduled = false;

        let ran = 0;

        try {
            while (ran < FLUSH_BUDGET) {
                const item = this.queue.shift();
                if (!item) break;
                ran++;
                try { item.task(); }
                catch (e) { console.error(`[Scheduler] task threw (tag=${item.tag})`, e); }
            }
        } finally {
            this.flushing = false;

            if (this.queue.length > 0 && !this.scheduled) {
                this.scheduled = true;

                // si agotamos budget o hay backlog => yield al event loop
                const kind =
                    ran >= FLUSH_BUDGET || this.queue.length > MICRO_THRESHOLD
                        ? "macro"
                        : "micro";

                this.requestFlush(kind);
            }
        }
    }
}

export const globalScheduler = new Scheduler();
