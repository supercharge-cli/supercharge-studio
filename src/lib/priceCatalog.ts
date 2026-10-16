/**
 * Public model price catalog (USD per 1M tokens), fetched on demand from a free,
 * key-less JSON endpoint and cached locally. Prices the user typed always win.
 */
import type { Price, Pricing } from "./usage";

export const CATALOG_URL = "https://models.dev/api.json";
const KEY = "supercharge-studio/price-catalog/v1";
const MAX_AGE = 7 * 864e5;
export type Catalog = { ts: number; prices: Record<string, Price> };

/** Lowercase, drop any "vendor/" path and trailing date/version tags, unify separators. */
export const normModel = (id: string) =>
  id.toLowerCase().split("/").pop()!.replace(/[:@].*$/, "").replace(/[-_.](\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/, "").replace(/[\s_.]+/g, "-");

/** Flatten the provider → models document to normalized id → price (first seen wins). */
export function parseCatalog(doc: any): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const prov of Object.values<any>(doc ?? {})) for (const [id, m] of Object.entries<any>(prov?.models ?? {})) {
    const c = m?.cost;
    if (!c || typeof c.input !== "number" || typeof c.output !== "number") continue;
    const k = normModel(m.id ?? id);
    if (!out[k]) out[k] = { input: c.input, output: c.output, ...(typeof c.cache_read === "number" ? { cached: c.cache_read } : {}) };
  }
  return out;
}

export function cachedCatalog(): Catalog | null {
  try { const c = JSON.parse(localStorage.getItem(KEY) ?? "null"); return c?.prices ? c : null; } catch { return null; }
}
export const isStale = (c: Catalog | null, now = Date.now()) => !c || now - c.ts > MAX_AGE;

export async function fetchCatalog(fetcher: typeof fetch = fetch): Promise<Catalog> {
  const r = await fetcher(CATALOG_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const c = { ts: Date.now(), prices: parseCatalog(await r.json()) };
  if (!Object.keys(c.prices).length) throw new Error("empty catalog");
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* quota: keep in memory */ }
  return c;
}

/** Loose match: exact normalized id, else the longest catalog id that prefixes it or that it prefixes. */
export function matchPrice(model: string, prices: Record<string, Price>): Price | undefined {
  const n = normModel(model);
  if (prices[n]) return prices[n];
  let best = "";
  for (const k of Object.keys(prices)) if ((n.startsWith(k + "-") || k.startsWith(n + "-")) && (best === "" || Math.abs(k.length - n.length) < Math.abs(best.length - n.length))) best = k;
  return best ? prices[best] : undefined;
}

/** User prices override catalog prices model by model. */
export function effectivePricing(models: string[], user: Pricing, prices: Record<string, Price> | undefined): { pricing: Pricing; auto: Set<string> } {
  const pricing: Pricing = { ...user };
  const auto = new Set<string>();
  if (prices) for (const m of models) if (!user[m]) { const p = matchPrice(m, prices); if (p) { pricing[m] = p; auto.add(m); } }
  return { pricing, auto };
}
