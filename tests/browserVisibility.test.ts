import { describe, expect, it } from "vitest";
import { browserVisible, intersects, overlayCount, pushOverlay, subscribeOverlays, MIN_W, POPOVER_SELECTOR } from "../src/browser/visibility";

const bounds = { x: 800, y: 40, width: 400, height: 600 };
const base = { tab: "browser", picker: false, overlays: 0, blocking: 0, popovers: [], bounds };

describe("side browser visibility rule", () => {
  it("shows only on the Browser tab with nothing covering it", () => {
    expect(browserVisible(base)).toBe(true);
    expect(browserVisible({ ...base, tab: "plan" })).toBe(false);
    expect(browserVisible({ ...base, tab: "terminal" })).toBe(false);
    expect(browserVisible({ ...base, picker: true })).toBe(false);
  });
  it("hides for registered overlays and blocking screens (update card, modals, palette)", () => {
    expect(browserVisible({ ...base, overlays: 1 })).toBe(false);
    expect(browserVisible({ ...base, blocking: 1 })).toBe(false);
  });
  it("hides when the panel is collapsed or the window is too narrow", () => {
    expect(browserVisible({ ...base, bounds: null })).toBe(false);
    expect(browserVisible({ ...base, bounds: { ...bounds, width: MIN_W - 1 } })).toBe(false);
    expect(browserVisible({ ...base, bounds: { ...bounds, height: 10 } })).toBe(false);
  });
  it("treats the fixed update banner as a popover (hidden where it overlaps)", () => {
    expect(POPOVER_SELECTOR).toContain(".update-banner");
    expect(browserVisible({ ...base, popovers: [{ x: 0, y: 0, width: 1360, height: 44 }] })).toBe(false);
    expect(browserVisible({ ...base, popovers: [{ x: 0, y: 0, width: 1360, height: 30 }] })).toBe(true);
  });
  it("hides only for popovers that overlap its area", () => {
    expect(browserVisible({ ...base, popovers: [{ x: 100, y: 500, width: 300, height: 200 }] })).toBe(true);
    expect(browserVisible({ ...base, popovers: [{ x: 700, y: 500, width: 300, height: 200 }] })).toBe(false);
    expect(intersects({ x: 0, y: 0, width: 0, height: 0 }, bounds)).toBe(false);
  });
  it("counts overlays and releases each one once", () => {
    const seen: number[] = [];
    const off = subscribeOverlays((n) => seen.push(n));
    const a = pushOverlay(), b = pushOverlay();
    expect(overlayCount()).toBe(2);
    a(); a();
    expect(overlayCount()).toBe(1);
    b();
    off();
    expect(overlayCount()).toBe(0);
    expect(seen).toEqual([1, 2, 1, 0]);
  });
});
