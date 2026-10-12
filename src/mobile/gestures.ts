import { useEffect, useRef } from "react";

/**
 * Edge swipe-back: drag from the left edge moves `el` with the finger (transform only)
 * and calls onBack past 30% width or a fast flick. Passive listeners; one write per frame.
 */
export function useSwipeBack(el: React.RefObject<HTMLElement | null>, enabled: boolean, onBack: () => void) {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    // Listeners live on the document and resolve the element per gesture, so a re-mounted
    // view never loses them.
    let n = el.current as HTMLElement;
    let x0 = 0, y0 = 0, t0 = 0, dx = 0, active = false, raf = 0;
    const paint = () => { raf = 0; n.style.transform = dx > 0 ? `translate3d(${dx}px,0,0)` : ""; };
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t.clientX > 24 || !el.current) return;
      n = el.current;
      active = true; x0 = t.clientX; y0 = t.clientY; t0 = performance.now(); dx = 0;
      n.style.transition = "none";
    };
    const move = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      if (Math.abs(t.clientY - y0) > 40 && dx < 10) { active = false; dx = 0; paint(); return; }
      dx = Math.max(0, t.clientX - x0);
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const end = () => {
      if (!active) return;
      active = false;
      const v = dx / Math.max(1, performance.now() - t0);
      const go = dx > n.clientWidth * 0.3 || v > 0.6;
      n.style.transition = "transform .28s var(--spring-soft)";
      n.style.transform = go ? `translate3d(${n.clientWidth}px,0,0)` : "";
      const done = () => { n.removeEventListener("transitionend", done); n.style.transition = ""; n.style.transform = ""; if (go) cb.current(); };
      if (dx > 0) n.addEventListener("transitionend", done); else done();
    };
    const d = document;
    d.addEventListener("touchstart", start, { passive: true });
    d.addEventListener("touchmove", move, { passive: true });
    d.addEventListener("touchend", end);
    d.addEventListener("touchcancel", end);
    return () => { d.removeEventListener("touchstart", start); d.removeEventListener("touchmove", move); d.removeEventListener("touchend", end); d.removeEventListener("touchcancel", end); cancelAnimationFrame(raf); };
  }, [el, enabled]);
}

/** Pull-to-refresh on a scroll container; reveals `indicator` via transform/opacity only. */
export function usePullToRefresh(el: React.RefObject<HTMLElement | null>, indicator: React.RefObject<HTMLElement | null>, enabled: boolean, onRefresh: () => Promise<unknown>) {
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    const n = el.current, ind = indicator.current;
    if (!n || !ind || !enabled) return;
    const MAX = 80, TRIGGER = 60;
    let y0 = 0, dy = 0, active = false, busy = false, raf = 0;
    const paint = () => {
      raf = 0;
      const p = Math.min(dy, MAX);
      n.style.transform = p ? `translate3d(0,${p * 0.6}px,0)` : "";
      ind.style.opacity = String(Math.min(1, p / TRIGGER));
      ind.style.transform = `translate3d(-50%,${p * 0.6 - 36}px,0) rotate(${p * 4}deg)`;
    };
    const start = (e: TouchEvent) => { if (busy || n.scrollTop > 0) return; active = true; y0 = e.touches[0].clientY; dy = 0; n.style.transition = ind.style.transition = "none"; };
    const move = (e: TouchEvent) => { if (!active) return; dy = Math.max(0, (e.touches[0].clientY - y0) * 0.55); if (!raf) raf = requestAnimationFrame(paint); };
    const end = async () => {
      if (!active) return;
      active = false;
      n.style.transition = "transform .32s var(--spring-soft)";
      ind.style.transition = "opacity .2s, transform .32s var(--spring-soft)";
      if (dy >= TRIGGER) {
        busy = true; dy = TRIGGER; paint(); ind.classList.add("spin");
        try { await cb.current(); } finally { ind.classList.remove("spin"); busy = false; dy = 0; paint(); }
      } else { dy = 0; paint(); }
    };
    n.addEventListener("touchstart", start, { passive: true });
    n.addEventListener("touchmove", move, { passive: true });
    n.addEventListener("touchend", end);
    return () => { n.removeEventListener("touchstart", start); n.removeEventListener("touchmove", move); n.removeEventListener("touchend", end); cancelAnimationFrame(raf); };
  }, [el, indicator, enabled]);
}
