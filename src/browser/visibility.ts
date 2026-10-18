/**
 * When may the native side browser be shown?
 *
 * The side browser is a native view drawn above the whole app UI, so anything
 * the app draws in its area (full-screen screens, modals, popovers) would be
 * covered by it. One rule decides: the browser is shown only when the panel is
 * on its Browser tab, is big enough, and nothing overlaps it.
 */
import { useEffect, useState } from "react";
import type { Bounds } from "./bridge";

/** Smallest slot (px) worth showing a page in; narrower windows hide it. */
export const MIN_W = 160;
export const MIN_H = 120;

/** Full-screen or modal UI: always hides the browser while present. */
export const BLOCKING_SELECTOR = ".cli-setup, .modal-bg, .palette-bg, [aria-modal='true'], [data-hides-browser]";
/** Popovers, menus and the fixed update banner: hide the browser only if they overlap it. */
export const POPOVER_SELECTOR = ".update-banner, [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

export type Rect = { x: number; y: number; width: number; height: number };

export type VisibilityInput = {
  tab: string;
  picker: boolean;
  /** Explicit overlays registered with `useBrowserOverlay`. */
  overlays: number;
  /** Blocking elements found in the document. */
  blocking: number;
  /** Popover rectangles found in the document (outside the panel). */
  popovers: Rect[];
  bounds: Bounds | null;
};

export const intersects = (a: Rect, b: Rect) =>
  a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export function browserVisible(i: VisibilityInput): boolean {
  if (i.tab !== "browser" || i.picker) return false;
  if (i.overlays > 0 || i.blocking > 0) return false;
  const b = i.bounds;
  if (!b || b.width < MIN_W || b.height < MIN_H) return false;
  return !i.popovers.some((p) => intersects(p, b));
}

// --- explicit overlay registry --------------------------------------------
let count = 0;
const subs = new Set<(n: number) => void>();
const emit = () => subs.forEach((f) => f(count));

export const overlayCount = () => count;
/** Register an overlay; returns its release function (idempotent). */
export function pushOverlay(): () => void {
  count++;
  emit();
  let done = false;
  return () => { if (done) return; done = true; count--; emit(); };
}
export function subscribeOverlays(f: (n: number) => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}
/** Hide the side browser while `active` is true. */
export function useBrowserOverlay(active: boolean) {
  useEffect(() => (active ? pushOverlay() : undefined), [active]);
}
export function useOverlayCount() {
  const [n, setN] = useState(count);
  useEffect(() => { setN(count); return subscribeOverlays(setN); }, []);
  return n;
}

/** Scan the document for blocking UI and popovers outside `panel`. */
export function scanDocument(doc: Document, panel: Element | null): { blocking: number; popovers: Rect[] } {
  const outside = (e: Element) => !panel || !panel.contains(e);
  const blocking = [...doc.querySelectorAll(BLOCKING_SELECTOR)].filter(outside).length;
  const popovers = [...doc.querySelectorAll(POPOVER_SELECTOR)].filter((e) => outside(e) && !e.closest(BLOCKING_SELECTOR)).map((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  return { blocking, popovers };
}
