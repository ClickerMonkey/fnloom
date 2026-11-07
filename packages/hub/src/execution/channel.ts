/**
 * A one-reader async channel: a producer pushes items (and ends it once), the reader iterates them as they come. It
 * lets a task that runs inside a doer stream its results to a caller outside it.
 */
export class Channel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#notify();
  }

  close(): void {
    this.#closed = true;
    this.#notify();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => { this.#wake = resolve; });
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
