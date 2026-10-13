import { flushSync } from "react-dom";

// WebKitGTK (the Linux desktop shell) can crash its web process in startViewTransition when
// accelerated compositing is off, so view transitions are never used there; plain CSS
// transitions are used instead. The `wk-safe` class also drops compositing-only effects.
const isLinuxShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
// View transitions are only used in regular browsers, never inside the desktop/mobile shells
// (WebKitGTK crashed in startViewTransition; plain CSS animations look the same and are safe).
const inShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const vt = typeof document !== "undefined" && "startViewTransition" in document && !isLinuxShell && !inShell;
if (typeof document !== "undefined" && !vt) document.documentElement.classList.add("no-vt");
if (typeof document !== "undefined" && isLinuxShell) document.documentElement.classList.add("wk-safe");

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
