/**
 * Stick-to-bottom for chat threads. Being near the end (re)attaches; only a scroll up detaches,
 * so content growing or re-measuring under a pinned view (streaming, lazily painted rows) never
 * leaves it stranded part-way down.
 */
export const follows = (stuck: boolean, prevTop: number, top: number, near: boolean): boolean => near || (stuck && top >= prevTop - 1);

/** Keep `el` pinned to its end whenever `content` changes size and `stuck()` holds. Returns a cleanup. */
export function pinToEnd(el: HTMLElement, content: Element, stuck: () => boolean): () => void {
  const ro = new ResizeObserver(() => { if (stuck()) el.scrollTop = el.scrollHeight; });
  ro.observe(content);
  return () => ro.disconnect();
}
