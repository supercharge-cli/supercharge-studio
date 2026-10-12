import { flushSync } from "react-dom";

const vt = typeof document !== "undefined" && "startViewTransition" in document;
if (typeof document !== "undefined" && !vt) document.documentElement.classList.add("no-vt");

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Run a state change as a view transition (snapshot cross-fade/slide) when supported. */
export function transition(update: () => void) {
  if (!vt || reduced() || document.visibilityState !== "visible") return update();
  (document as any).startViewTransition(() => flushSync(update));
}

/** Coalesce calls to one per animation frame (latest arguments win). */
export function perFrame<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
  let id = 0, last: A;
  return (...a: A) => {
    last = a;
    if (!id) id = requestAnimationFrame(() => { id = 0; fn(...last); });
  };
}
