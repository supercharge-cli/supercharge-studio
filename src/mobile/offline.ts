/** Rejections that only mean the link to the computer is down (or dropped mid-request). */
export const offline = (e: unknown) => /^(Not connected|Connection (closed|lost))/.test(String((e as Error)?.message ?? e));

/**
 * One action to finish after reconnecting. `run` does `fn` now when the link is open; when it
 * is down, or drops while `fn` runs, it keeps `fn` (the latest wins) and resolves false
 * instead of rejecting. Other errors still reject. `flush` runs the kept action once.
 */
export class AfterReconnect {
  private fn: (() => Promise<unknown>) | null = null;
  async run(open: boolean, fn: () => Promise<unknown>): Promise<boolean> {
    if (open) {
      try { await fn(); return true; } catch (e) { if (!offline(e)) throw e; }
    }
    this.fn = fn;
    return false;
  }
  flush(): Promise<unknown> {
    const f = this.fn;
    this.fn = null;
    return f ? f() : Promise.resolve();
  }
}
