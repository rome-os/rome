// Promise-based queue: the streaming input of the SDK's
// `query({ prompt: queue.iter() })`, and the events a session hands its reader.

export class AsyncMessageQueue<T> {
  private values: T[] = [];
  private resolvers: Array<(item: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    if (this.done) {
      throw new Error("AsyncMessageQueue is closed");
    }
    if (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  iter(): AsyncIterable<T> {
    const next = async (): Promise<IteratorResult<T>> => {
      if (this.values.length > 0) {
        const value = this.values.shift()!;
        return { value, done: false };
      }
      if (this.done) {
        return { value: undefined as unknown as T, done: true };
      }
      return await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
    };
    return {
      [Symbol.asyncIterator]() {
        return { next };
      },
    };
  }
}
