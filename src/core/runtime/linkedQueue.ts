// linkedQueue.ts
export type Node<T> = {
    value: T;
    next: Node<T> | null;
    prev: Node<T> | null;
    removed: boolean;
};

export class LinkedQueue<T> {
    private head: Node<T> | null = null;
    private tail: Node<T> | null = null;
    private len = 0;

    get length(): number {
        return this.len;
    }

    isEmpty(): boolean {
        return this.len === 0;
    }

    push(value: T): Node<T> {
        const node: Node<T> = { value, next: null, prev: this.tail, removed: false };
        if (this.tail) this.tail.next = node;
        else this.head = node;
        this.tail = node;
        this.len++;
        return node;
    }

    shift(): T | undefined {
        const h = this.head;
        if (!h) return undefined;
        this.unlink(h);
        return h.value;
    }

    remove(node: Node<T>): void {
        if (node.removed) return;
        this.unlink(node);
    }

    private unlink(node: Node<T>): void {
        node.removed = true;

        const { prev, next } = node;

        if (prev) prev.next = next;
        else this.head = next;

        if (next) next.prev = prev;
        else this.tail = prev;

        node.next = null;
        node.prev = null;

        this.len--;
    }
}
