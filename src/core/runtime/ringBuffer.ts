// ringBuffer.ts
export class RingBuffer<T> {
    private buf: (T | undefined)[];
    private head = 0; // index de lectura
    private tail = 0; // index de escritura
    private size_ = 0;

    constructor(initialCapacity: number = 1024) {
        const cap = Math.max(2, this.nextPow2(initialCapacity));
        this.buf = new Array<T | undefined>(cap);
    }

    get length(): number {
        return this.size_;
    }

    get capacity(): number {
        return this.buf.length;
    }

    isEmpty(): boolean {
        return this.size_ === 0;
    }

    push(value: T): void {
        if (this.size_ === this.buf.length) {
            this.grow();
        }
        this.buf[this.tail] = value;
        this.tail = (this.tail + 1) & (this.buf.length - 1);
        this.size_++;
    }

    shift(): T | undefined {
        if (this.size_ === 0) return undefined;
        const value = this.buf[this.head];
        this.buf[this.head] = undefined; // ayuda al GC
        this.head = (this.head + 1) & (this.buf.length - 1);
        this.size_--;
        return value;
    }

    clear(): void {
        // Limpieza simple
        this.buf.fill(undefined);
        this.head = 0;
        this.tail = 0;
        this.size_ = 0;
    }

    private grow(): void {
        const old = this.buf;
        const newBuf = new Array<T | undefined>(old.length * 2);

        // Copiamos en orden lógico (head -> tail)
        for (let i = 0; i < this.size_; i++) {
            newBuf[i] = old[(this.head + i) & (old.length - 1)];
        }

        this.buf = newBuf;
        this.head = 0;
        this.tail = this.size_;
    }

    private nextPow2(n: number): number {
        // Redondea hacia arriba a potencia de 2 (para usar & mask)
        let x = 1;
        while (x < n) x <<= 1;
        return x;
    }
}
