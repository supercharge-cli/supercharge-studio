import { describe, expect, it } from "vitest";
import { effectivePricing, matchPrice, normModel, parseCatalog } from "../src/lib/priceCatalog";

const doc = { a: { models: { "x/gpt-6-luna": { id: "gpt-6-luna", cost: { input: 2, output: 8, cache_read: 0.5 } }, free: { id: "free-model" } } }, b: { models: { m: { id: "sol-mini", cost: { input: 0.1, output: 0.4 } } } } };

describe("price catalog", () => {
  it("normalizes ids", () => {
    expect(normModel("Vendor/GPT-6-Luna-20260101")).toBe("gpt-6-luna");
    expect(normModel("sol_mini:latest")).toBe("sol-mini");
  });
  it("parses costs and skips unpriced models", () => {
    const p = parseCatalog(doc);
    expect(p["gpt-6-luna"]).toEqual({ input: 2, output: 8, cached: 0.5 });
    expect(p["free-model"]).toBeUndefined();
  });
  it("matches loosely", () => {
    const p = parseCatalog(doc);
    expect(matchPrice("studio/gpt-6-luna", p)?.input).toBe(2);
    expect(matchPrice("sol-mini-fast", p)?.input).toBe(0.1);
    expect(matchPrice("unknown", p)).toBeUndefined();
  });
  it("user prices win", () => {
    const r = effectivePricing(["gpt-6-luna", "sol-mini"], { "gpt-6-luna": { input: 9, output: 9 } }, parseCatalog(doc));
    expect(r.pricing["gpt-6-luna"].input).toBe(9);
    expect(r.auto.has("sol-mini")).toBe(true);
    expect(r.auto.has("gpt-6-luna")).toBe(false);
  });
});
