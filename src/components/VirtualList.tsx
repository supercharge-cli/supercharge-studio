import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Windowed list with measured row heights and stick-to-bottom behaviour.
 * Short lists render fully; long ones render only rows near the viewport.
 */
export function VirtualList<T>({ items, render, keyOf, threshold = 80, estimate = 72, overscan = 900, footer, header, className }: {
  items: T[];
  render: (item: T, index: number) => ReactNode;
  keyOf: (item: T, index: number) => string | number;
  threshold?: number;
  estimate?: number;
  overscan?: number;
  footer?: ReactNode;
  header?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string | number, number>());
  const stick = useRef(true);
  const [, force] = useState(0);
  const [view, setView] = useState({ top: 0, h: 800 });
  const virtual = items.length > threshold;

  const onScroll = useCallback(() => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (virtual) setView({ top: el.scrollTop, h: el.clientHeight });
  }, [virtual]);

  // Keep pinned to the bottom while content grows (streaming), unless the user scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el.firstElementChild as Element);
    return () => ro.disconnect();
  }, []);

  const measure = useCallback((k: string | number) => (node: HTMLDivElement | null) => {
    if (!node) return;
    const h = node.offsetHeight;
    if (h && heights.current.get(k) !== h) {
      heights.current.set(k, h);
      if (virtual) force((x) => x + 1);
    }
  }, [virtual]);

  let start = 0, end = items.length, padTop = 0, padBottom = 0;
  if (virtual) {
    const hs = items.map((it, i) => heights.current.get(keyOf(it, i)) ?? estimate);
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

  return (
    <div className={className} ref={ref} onScroll={onScroll} data-virtual={virtual || undefined}>
      <div className="thread">
        {header}
        {padTop > 0 && <div style={{ height: padTop }} aria-hidden />}
        {items.slice(start, end).map((it, j) => {
          const i = start + j;
          const k = keyOf(it, i);
          return <div key={k} ref={measure(k)} className="row-wrap">{render(it, i)}</div>;
        })}
        {padBottom > 0 && <div style={{ height: padBottom }} aria-hidden />}
        {footer}
      </div>
    </div>
  );
}
