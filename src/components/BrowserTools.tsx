/** Side browser extras: computer mode stage, dev drawer and design mode (element picker). */
import { useEffect, useRef, useState } from "react";
import { browser } from "../browser/bridge";
import { DevStore, failed, filterLogs, formatLogs, formatNet } from "../browser/devlog";
import { designMarkdown, PICK_OFF, PICK_TAKE, pickerScript, pickName, type Pick } from "../browser/picker";
import { cropRect, fitViewport, parseSize, type Size } from "../browser/viewport";
import { invoke, isDesktop } from "../lib/desktop";
import { Icon } from "./Icon";

const ZOOMS = [{ v: 0, label: "Fit to window" }, { v: 0.5, label: "50%" }, { v: 0.75, label: "75%" }, { v: 1, label: "100%" }];

/** Computer mode, inside the side panel: a desktop-size page scaled into the panel, framed and centered.
 *  The native view follows `stage` and is zoomed so its CSS viewport is exactly `vp`. */
export function ComputerStage({ vp, onSize, stage }: { vp: Size; onSize: (s: Size) => void; stage: React.RefObject<HTMLDivElement | null> }) {
  const area = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [w, setW] = useState(String(vp.width)), [h, setH] = useState(String(vp.height));
  useEffect(() => { setW(String(vp.width)); setH(String(vp.height)); }, [vp.width, vp.height]);
  const desktop = isDesktop();
  // The native view can't scroll inside the panel, so on desktop a fixed zoom is capped to what fits.
  const f = fitViewport(vp, { x: 0, y: 0, ...box }, 12, zoom, desktop);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    addEventListener("resize", measure);
    return () => { ro.disconnect(); removeEventListener("resize", measure); };
  }, []);
  useEffect(() => {
    const r = area.current?.getBoundingClientRect();
    if (!r || !box.width) return;
    const b = { x: Math.round(r.left + f.x + 1), y: Math.round(r.top + f.y + 1), width: f.width, height: f.height };
    void browser.setBounds(b).then(() => browser.setZoom(f.scale));
  }, [f.x, f.y, f.width, f.height, f.scale, box.width]);
  const commit = () => {
    const s = parseSize(`${w}x${h}`);
    if (!s) { setW(String(vp.width)); setH(String(vp.height)); }
    else if (s.width !== vp.width || s.height !== vp.height) onSize(s);
  };
  const num = (v: string, set: (x: string) => void, label: string) => (
    <input inputMode="numeric" aria-label={label} value={v} onChange={(e) => set(e.target.value.replace(/\D/g, "").slice(0, 4))} onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) commit(); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
  );
  return (
    <div className="bm-computer" data-testid="computer-mode">
      <div className="bm-bar">
        {num(w, setW, "Viewport width")}<span>×</span>{num(h, setH, "Viewport height")}
        <span className="muted small" data-testid="computer-zoom">{Math.round(f.scale * 100)}%</span>
        <select aria-label="Zoom" value={zoom} onChange={(e) => setZoom(+e.target.value)}>
          {ZOOMS.map((z) => <option key={z.v} value={z.v}>{z.label}</option>)}
        </select>
      </div>
      <div className="bm-area" ref={area} style={{ overflow: desktop ? "hidden" : "auto" }}>
        <div style={{ width: f.x + f.width + 14, height: f.y + f.height + 14, pointerEvents: "none" }} />
        <div ref={stage} className="bm-stage" style={{ left: f.x, top: f.y, width: f.width, height: f.height }}>
          {!desktop && <iframe title="browser" src={browser.url} style={{ width: vp.width, height: vp.height, transform: `scale(${f.scale})`, transformOrigin: "0 0", border: 0 }} />}
        </div>
      </div>
    </div>
  );
}

/** Dev drawer: console and network captured from the page. */
export function DevDrawer() {
  const [, tick] = useState(0);
  const [view, setView] = useState<"console" | "network">("console");
  const [level, setLevel] = useState("all");
  const [allow, setAllow] = useState(browser.allowEval);
  const [copied, setCopied] = useState(false);
  const store = browser.dev ?? (browser.dev = new DevStore());
  useEffect(() => {
    const t = setInterval(() => void browser.pullDev().then((c) => c && tick((n) => n + 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const logs = filterLogs(store.logs, level);
  const net = level === "error" || level === "warn" ? store.net.filter(failed) : store.net;
  const errs = store.logs.filter((e) => e.level === "error").length;
  const copy = () => { void navigator.clipboard?.writeText(view === "console" ? formatLogs(logs) : formatNet(net)); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <div className="bm-dev" data-testid="dev-drawer">
      <div className="bm-dev-bar">
        <button className={view === "console" ? "on" : ""} onClick={() => setView("console")}>Console{errs ? <b className="bm-err"> {errs}</b> : null}</button>
        <button className={view === "network" ? "on" : ""} onClick={() => setView("network")}>Network ({store.net.length})</button>
        <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="all">All</option><option value="error">Errors</option><option value="warn">Warnings+</option><option value="log">Logs</option><option value="info">Info</option><option value="debug">Debug</option>
        </select>
        <div style={{ flex: 1 }} />
        <label className="small muted" title="Let the agent run JavaScript in this page (browser_eval)"><input type="checkbox" checked={allow} onChange={(e) => { browser.setAllowEval(e.target.checked); setAllow(e.target.checked); }} /> Agent JS</label>
        <button className="ghost sm" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        <button className="ghost sm" onClick={() => { store.clear(); tick((n) => n + 1); }}>Clear</button>
      </div>
      <div className="bm-dev-list">
        {view === "console"
          ? logs.length ? logs.slice(-300).map((e, i) => <div key={i} className={`bm-log ${e.level}`}><span>{e.level}</span><code>{e.text}{e.source ? ` (${e.source})` : ""}</code></div>) : <p className="muted small">No console messages yet.</p>
          : net.length ? net.slice(-300).map((e, i) => <div key={i} className={`bm-log ${failed(e) ? "error" : ""}`}><span>{e.method}</span><span>{e.status || (e.error ? "ERR" : "…")}</span><code title={e.url}>{e.url}</code><span>{e.ms != null ? `${e.ms} ms` : ""}</span></div>) : <p className="muted small">No requests yet.</p>}
      </div>
    </div>
  );
}

/** Crop a base64 PNG to `box` (CSS px of a viewport `cssWidth` wide). */
async function cropPng(png: string, box: Pick["box"], cssWidth: number): Promise<Blob | null> {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const r = cropRect(box, cssWidth, { width: img.naturalWidth, height: img.naturalHeight });
  if (!r) return null;
  const k = Math.min(1, 800 / Math.max(r.width, r.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(r.width * k));
  c.height = Math.max(1, Math.round(r.height * k));
  c.getContext("2d")!.drawImage(img, r.x, r.y, r.width, r.height, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/png"));
}

/** Design mode: picker in the page until the returned stop() is called; picks become composer attachments. */
export function startDesign(setOn: (v: boolean) => void) {
  let alive = true, busy = false;
  const poll = async () => {
    if (busy || !browser.bounds) return;
    busy = true;
    try {
      const r = await browser.evaluate(PICK_TAKE).catch(() => null);
      if (!alive || !r) return;
      if (r.missing) { await browser.evaluate(pickerScript()).catch(() => {}); return; }
      if (r.picks?.length) await deliver(r.picks as Pick[]);
      if (r.exit) setOn(false);
    } finally { busy = false; }
  };
  void browser.evaluate(pickerScript()).catch(() => {});
  const t = setInterval(() => void poll(), 300);
  return () => { alive = false; clearInterval(t); void browser.evaluate(PICK_OFF).catch(() => {}); };
}

async function deliver(picks: Pick[]) {
  const files: File[] = [new File([designMarkdown(picks)], picks.length > 1 ? `${picks.length}-elements.md` : pickName(picks[0], ".md"), { type: "text/markdown" })];
  try {
    await browser.evaluate("(window.__scPick.hide(true), true)");
    await new Promise((r) => setTimeout(r, 60));
    const png = await invoke<string>("browser_screenshot");
    for (const p of picks.slice(0, 4)) {
      const b = await cropPng(png, p.box, p.page.width).catch(() => null);
      if (b) files.push(new File([b], pickName(p, ".png"), { type: "image/png" }));
    }
  } catch { /* screenshots unavailable: send the text context only */ }
  await browser.evaluate("(window.__scPick.hide(false), true)").catch(() => {});
  browser.onDesignPick?.(files);
}
