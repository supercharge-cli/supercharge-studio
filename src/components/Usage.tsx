import { useEffect, useMemo, useState } from "react";
import { cachedCatalog, type Catalog, effectivePricing, fetchCatalog, isStale } from "../lib/priceCatalog";
import { aggregate, bucketRange, clearUsage, fmtTokens, fmtUsd, parsePrice, Period, Pricing, UsageRecord } from "../lib/usage";
import { Icon } from "./Icon";

const RANGE: Record<Period, number> = { day: 30, month: 12, year: 5 };
const SERIES = [
  { k: "input", label: "Input", c: "var(--c1)" },
  { k: "cached", label: "Cached", c: "var(--c2)" },
  { k: "output", label: "Output", c: "var(--c3)" },
  { k: "reasoning", label: "Reasoning", c: "var(--c4)" },
] as const;

/** Stacked bar chart, hand-rolled SVG. Input bars show fresh (uncached) input. */
function Chart({ buckets, metric }: { buckets: any[]; metric: "tokens" | "cost" }) {
  const W = 720, H = 200, pad = 28;
  const val = (b: any) => (metric === "cost" ? b.cost : Math.max(0, b.input - b.cached) + b.cached + b.output);
  const max = Math.max(1e-9, ...buckets.map(val));
  const bw = (W - pad) / buckets.length;
  const [hover, setHover] = useState<number | null>(null);
  const h = hover != null ? buckets[hover] : null;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label="Usage chart" onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={pad} x2={W} y1={H - f * (H - 10)} y2={H - f * (H - 10)} className="grid" />
            <text x={0} y={H - f * (H - 10) + 4} className="axis">{metric === "cost" ? fmtUsd(max * f) : fmtTokens(Math.round(max * f))}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = pad + i * bw + bw * 0.15;
          const w = bw * 0.7;
          let y = H;
          const parts =
            metric === "cost"
              ? [{ v: b.cost, c: "var(--acc)" }]
              : [
                  { v: Math.max(0, b.input - b.cached), c: SERIES[0].c },
                  { v: b.cached, c: SERIES[1].c },
                  { v: b.output, c: SERIES[2].c },
                ];
          return (
            <g key={b.key} onMouseEnter={() => setHover(i)} className={hover === i ? "bar on" : "bar"}>
              <rect x={pad + i * bw} y={0} width={bw} height={H} fill="transparent" />
              {parts.map((p, j) => {
                const ph = (p.v / max) * (H - 10);
                y -= ph;
                return <rect key={j} x={x} y={y} width={w} height={Math.max(0, ph)} rx={2} fill={p.c} />;
              })}
              {(buckets.length <= 12 || i % Math.ceil(buckets.length / 10) === 0) && (
                <text x={x + w / 2} y={H + 16} textAnchor="middle" className="axis">{b.key.slice(b.key.length > 7 ? 5 : b.key.length > 4 ? 2 : 0)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-tip">
        {h ? (
          <>
            <b>{h.key}</b> · in {fmtTokens(h.input)} · cached {fmtTokens(h.cached)} · out {fmtTokens(h.output)} · reasoning {fmtTokens(h.reasoning)} · {fmtUsd(h.cost)}
          </>
        ) : (
          <span className="legend">{(metric === "cost" ? [{ label: "Estimated cost", c: "var(--acc)" }] : SERIES.slice(0, 3)).map((s) => <span key={s.label}><i style={{ background: s.c }} />{s.label}</span>)}</span>
        )}
      </div>
    </div>
  );
}

function Table({ title, rows }: { title: string; rows: [string, any][] }) {
  return (
    <div className="card">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="muted">No usage in this range.</p>
      ) : (
        <table className="tbl">
          <thead><tr><th>{title.replace("By ", "")}</th><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Calls</th><th>Cost</th></tr></thead>
          <tbody>
            {rows.sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output)).map(([k, a]) => (
              <tr key={k}><td>{k}</td><td>{fmtTokens(a.input)}</td><td>{fmtTokens(a.cached)}</td><td>{fmtTokens(a.output)}</td><td>{fmtTokens(a.reasoning)}</td><td>{a.calls}</td><td>{fmtUsd(a.cost)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function UsageScreen({ records, pricing, onPricing, onClear, onClose }: { records: UsageRecord[]; pricing: Pricing; onPricing: (p: Pricing) => void; onClear: () => void; onClose: () => void }) {
  const [period, setPeriod] = useState<Period>("day");
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const keys = useMemo(() => bucketRange(period, RANGE[period]), [period]);
  const models = useMemo(() => [...new Set(records.map((r) => r.model))].sort(), [records]);
  const [catalog, setCatalog] = useState<Catalog | null>(cachedCatalog);
  const [priceNote, setPriceNote] = useState("");
  const refresh = () => { setPriceNote("Updating prices…"); fetchCatalog().then((c) => { setCatalog(c); setPriceNote(""); }).catch(() => setPriceNote("Couldn't reach the price list. Using saved prices.")); };
  useEffect(() => { if (models.length && isStale(catalog)) refresh(); }, [models.length > 0]);
  const eff = useMemo(() => effectivePricing(models, pricing, catalog?.prices), [models, pricing, catalog]);
  const agg = useMemo(() => aggregate(records, eff.pricing, period, keys), [records, eff, period, keys]);
  const t = agg.total;
  return (
    <div className="screen" data-testid="usage-screen">
      <header className="screen-head">
        <h2>Usage</h2>
        <div className="spacer" />
        <div className="seg sm">
          {(["day", "month", "year"] as Period[]).map((p) => (
            <button key={p} className={period === p ? "on" : ""} data-testid={`period-${p}`} onClick={() => setPeriod(p)}>{p === "day" ? "Daily" : p === "month" ? "Monthly" : "Yearly"}</button>
          ))}
        </div>
        <div className="seg sm">
          <button className={metric === "tokens" ? "on" : ""} onClick={() => setMetric("tokens")}>Tokens</button>
          <button className={metric === "cost" ? "on" : ""} onClick={() => setMetric("cost")}>Cost</button>
        </div>
        <button className="icon" title="Close (Esc)" onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className="screen-body">
        <div className="stats">
          <div className="stat"><span>Input</span><b data-testid="stat-input">{fmtTokens(t.input)}</b></div>
          <div className="stat"><span>Cached</span><b>{fmtTokens(t.cached)}</b></div>
          <div className="stat"><span>Output</span><b data-testid="stat-output">{fmtTokens(t.output)}</b></div>
          <div className="stat"><span>Reasoning</span><b>{fmtTokens(t.reasoning)}</b></div>
          <div className="stat"><span>Est. cost</span><b data-testid="stat-cost">{fmtUsd(t.cost)}</b></div>
        </div>
        <div className="card"><Chart buckets={agg.buckets} metric={metric} /></div>
        <div className="grid2">
          <Table title="By model" rows={agg.byModel} />
          <Table title="By provider" rows={agg.byProvider} />
        </div>
        <div className="card">
          <div className="row between"><h4>Pricing (USD per 1M tokens)</h4><button className="ghost compact" data-testid="refresh-prices" onClick={refresh}><Icon name="refresh" size={13} /> Refresh prices</button></div>
          {priceNote && <p className="muted small" data-testid="price-note">{priceNote}</p>}
          {models.length === 0 && <p className="muted">Models appear here after the agent reports usage for them.</p>}
          {models.map((m) => {
            const p = eff.pricing[m] ?? { input: 0, output: 0 };
            const set = (k: "input" | "output" | "cached", v: number | undefined) => onPricing({ ...pricing, [m]: { ...p, [k]: v } });
            const isAuto = eff.auto.has(m);
            return (
              <div className="price-row" key={m} data-testid="price-row">
                <span className="mono">{m}{isAuto ? <span className="badge muted" title="Filled from the public price list. Type a price to override it."> auto</span> : pricing[m] ? <button className="ghost compact" title="Use the public price list again" onClick={() => { const { [m]: _, ...rest } = pricing; onPricing(rest); }}>reset</button> : null}</span>
                <label>Input<PriceInput value={p.input} testId="price-input" onCommit={(v) => set("input", v ?? 0)} /></label>
                <label>Cached<PriceInput value={p.cached} placeholder="= input" onCommit={(v) => set("cached", v)} /></label>
                <label>Output<PriceInput value={p.output} testId="price-output" onCommit={(v) => set("output", v ?? 0)} /></label>
              </div>
            );
          })}
          <div className="row between">
            <span className="muted">Usage is read from the agent's turn reports and stored only on this device.</span>
            <button className="ghost danger-text" onClick={() => { clearUsage(); onClear(); }}><Icon name="trash" /> Clear history</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Text price field: keeps what you type ("0.", ".5"), saves each valid value, settles on blur or Enter. */
function PriceInput({ value, placeholder, testId, onCommit }: { value?: number; placeholder?: string; testId?: string; onCommit: (v: number | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = parsePrice(draft);
    if (draft.trim() === "") onCommit(undefined);
    else if (n !== null && n !== value) onCommit(n);
    setDraft(null);
  };
  return (
    <input type="text" inputMode="decimal" placeholder={placeholder} data-testid={testId} className={draft !== null && draft.trim() !== "" && parsePrice(draft) === null ? "bad" : ""}
      value={draft ?? (value === undefined ? "" : String(value))}
      onChange={(e) => { const t = e.target.value; if (!/^[0-9.,]*$/.test(t)) return; setDraft(t); const n = parsePrice(t); if (n !== null && n !== value) onCommit(n); }}
      onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setDraft(null); }} />
  );
}
