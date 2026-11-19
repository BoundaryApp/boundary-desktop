/** A set of change listeners: `add` returns a function that removes the listener. */
export class Listeners {
  private set = new Set<() => void>();

  add(listener: () => void): () => void {
    this.set.add(listener);
    return () => this.set.delete(listener);
  }

  emit(): void {
    for (const listener of [...this.set]) listener();
  }
}
