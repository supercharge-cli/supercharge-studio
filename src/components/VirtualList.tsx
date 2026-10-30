import { memo, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { follows, pinToEnd } from "../lib/follow";

/**
 * Windowed list with measured row heights and stick-to-bottom behaviour.
 * Short lists render fully; long ones render only rows near the viewport.
 */
export function VirtualList<T>({ items, render, keyOf, threshold = 80, estimate = 72, overscan = 900, footer, header, className, scrollTo }: {
  items: T[];
  render: (item: T, index: number) => ReactNode;
  keyOf: (item: T, index: number) => string | number;
  threshold?: number;
  estimate?: number;
  overscan?: number;
  footer?: ReactNode;
  header?: ReactNode;
  className?: string;
  /** Scroll a row into view and flash it (n changes per request). */
  scrollTo?: { index: number; n: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  // Rows added after the first render get a one-time enter animation.
  const base = useRef(items.length);
  const seen = useRef(new Set<string | number>());
  const [, force] = useState(0);
  const [view, setView] = useState({ top: 0, h: 800 });
  const virtual = items.length > threshold;

  // Scroll handling is coalesced to one read + one state update per frame.
  const frame = useRef(0);
  const lastTop = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = ref.current;
      if (!el) return;
      stick.current = follows(stick.current, lastTop.current, el.scrollTop, el.scrollHeight - el.scrollTop - el.clientHeight < 60);
      lastTop.current = el.scrollTop;
      setAway(!stick.current);
      if (virtual) setView((v) => (Math.abs(v.top - el.scrollTop) < 40 && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight }));
    });
  }, [virtual]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Keep pinned to the bottom while content grows (streaming), unless the user scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return pinToEnd(el, el.firstElementChild as Element, () => stick.current);
  }, []);

  // Row heights come from one ResizeObserver (batched, no forced synchronous layout).
  const virtualRef = useRef(virtual);
  virtualRef.current = virtual;
  const rows = useRef<ResizeObserver | null>(null);
  if (!rows.current && typeof ResizeObserver !== "undefined")
    rows.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const k = (e.target as HTMLElement).dataset.k!;
        const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight);
        if (h && heights.current.get(k) !== h) { heights.current.set(k, h); changed = true; }
      }
      if (changed && virtualRef.current) force((x) => x + 1);
    });
  useEffect(() => () => rows.current?.disconnect(), []);


  let start = 0, end = items.length, padTop = 0, padBottom = 0;
  if (virtual) {
    const hs = items.map((it, i) => heights.current.get(String(keyOf(it, i))) ?? estimate);
    let y = 0;
    start = -1;
    for (let i = 0; i < items.length; i++) {
      if (start < 0 && y + hs[i] >= view.top - overscan) { start = i; padTop = y; }
      y += hs[i];
      if (y > view.top + view.h + overscan) { end = i + 1; break; }
    }
    if (start < 0) start = 0;
    padBottom = hs.slice(end).reduce((a, b) => a + b, 0);
  }

  // Search results: jump to a message (estimate first if virtualised, then refine on the real row).
  const [flash, setFlash] = useState(-1);
  useEffect(() => {
    const el = ref.current;
    if (!scrollTo || !el || scrollTo.index < 0 || scrollTo.index >= items.length) return;
    stick.current = false;
    setAway(true);
    if (virtual) {
      let y = 0;
      for (let i = 0; i < scrollTo.index; i++) y += heights.current.get(String(keyOf(items[i], i))) ?? estimate;
      el.scrollTop = Math.max(0, y - 80);
      setView({ top: el.scrollTop, h: el.clientHeight });
    }
    setFlash(scrollTo.index);
    let tries = 0;
    const t = setInterval(() => {
      const row = el.querySelector(`[data-vi="${scrollTo.index}"]`) as HTMLElement | null;
      if (row) { row.scrollIntoView({ block: "center" }); clearInterval(t); }
      else if (++tries > 20) clearInterval(t);
    }, 50);
    const f = setTimeout(() => setFlash(-1), 2200);
    return () => { clearInterval(t); clearTimeout(f); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTo?.n, items.length > 0]);

  // A user's scroll-up detaches at once: the coalesced scroll read lands a frame later, and a
  // streaming render in between would otherwise snap the view back to the bottom.
  const up = () => { stick.current = false; };
  const onKey = (e: { key: string }) => { if (/^(ArrowUp|PageUp|Home)$/.test(e.key)) up(); };
  const jump = () => { const el = ref.current; if (!el) return; stick.current = true; setAway(false); el.scrollTop = el.scrollHeight; };
  return (
    <div className="vlist-wrap">
    <div className={className} ref={ref} onScroll={onScroll} onWheel={(e) => { if (e.deltaY < 0) up(); }} onKeyDown={onKey} data-virtual={virtual || undefined}>
      <div className="thread">
        {header}
        {padTop > 0 && <div style={{ height: padTop }} aria-hidden />}
        {items.slice(start, end).map((it, j) => {
          const i = start + j;
          const k = keyOf(it, i);
          const enter = i >= base.current && !seen.current.has(k);
          if (enter) seen.current.add(k);
          return <Row key={k} k={k} ro={rows.current} item={it} index={i} enter={enter} render={render as (x: unknown, i: number) => ReactNode} flash={i === flash} />;
        })}
        {padBottom > 0 && <div style={{ height: padBottom }} aria-hidden />}
        {footer}
      </div>
    </div>
    {away && items.length > 0 && <button className="jump-latest" data-testid="jump-latest" onClick={jump} aria-label="Jump to latest">↓ Latest</button>}
    </div>
  );
}

/** Memoised row: unchanged items (same object) skip re-render while the last one streams. */
const Row = memo(function Row({ k, ro, item, index, render, enter, flash }: { flash?: boolean; k: string | number; ro: ResizeObserver | null; item: unknown; index: number; enter?: boolean; render: (x: unknown, i: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const n = ref.current;
    if (!n || !ro) return;
    ro.observe(n);
    return () => ro.unobserve(n);
  }, [ro]);
  return <div ref={ref} data-k={k} data-vi={index} className={`row-wrap${enter ? " enter" : ""}${flash ? " search-flash" : ""}`}>{render(item, index)}</div>;
});
