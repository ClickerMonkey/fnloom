/** Runs async tasks one at a time, in the order they were given; a failing task doesn't stop the ones after it. */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
