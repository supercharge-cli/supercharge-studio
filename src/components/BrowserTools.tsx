/** Side browser extras: computer mode stage, dev drawer and design mode (element picker). */
import { useEffect, useRef, useState } from "react";
import { browser } from "../browser/bridge";
import { DevStore, failed, filterLogs, formatLogs, formatNet } from "../browser/devlog";
import { designMarkdown, PICK_OFF, PICK_TAKE, pickerScript, pickName, type Pick } from "../browser/picker";
import { cropRect, fitViewport, parseSize, PRESETS, type Size } from "../browser/viewport";
import { invoke, isDesktop } from "../lib/desktop";
import { Icon } from "./Icon";

const screenSize = (): Size => ({ width: Math.round(window.screen?.width || 1920), height: Math.round(window.screen?.height || 1080) });

/** Computer mode: a desktop-size page centered over the app, scaled to fit. The native view follows `stage`. */
export function ComputerStage({ vp, onSize, onExit, stage }: { vp: Size; onSize: (s: Size) => void; onExit: () => void; stage: React.RefObject<HTMLDivElement | null> }) {
  const area = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(() => fitViewport(vp, { x: 0, y: 0, width: innerWidth, height: innerHeight - 48 }));
  const [custom, setCustom] = useState("");
  useEffect(() => {
    const place = () => {
      const r = area.current?.getBoundingClientRect();
      if (!r) return;
      const f = fitViewport(vp, { x: r.left, y: r.top, width: r.width, height: r.height });
      setFit(f);
      void browser.setBounds({ x: f.x, y: f.y, width: f.width, height: f.height }).then(() => browser.setZoom(f.scale));
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [vp.width, vp.height]);
  const scr = screenSize();
  const opts = [scr, ...PRESETS.filter((p) => p.width !== scr.width || p.height !== scr.height)];
  const key = (s: Size) => `${s.width}x${s.height}`;
  return (
    <div className="bm-computer" data-testid="computer-mode">
      <div className="bm-bar">
        <Icon name="monitor" size={14} />
        <select aria-label="Viewport size" value={opts.some((o) => key(o) === key(vp)) ? key(vp) : "custom"} onChange={(e) => { const s = parseSize(e.target.value); if (s) onSize(s); }}>
          {opts.map((o, i) => <option key={key(o)} value={key(o)}>{o.width} × {o.height}{i === 0 ? " (your screen)" : ""}</option>)}
          {!opts.some((o) => key(o) === key(vp)) && <option value="custom">{vp.width} × {vp.height}</option>}
        </select>
        <form onSubmit={(e) => { e.preventDefault(); const s = parseSize(custom); if (s) { onSize(s); setCustom(""); } }}>
          <input className="bm-custom" placeholder="Custom, e.g. 1600x900" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Custom size" />
        </form>
        <span className="muted small" data-testid="computer-zoom">{Math.round(fit.scale * 100)}%</span>
        <div style={{ flex: 1 }} />
        <span className="muted small">You and the agent see this {vp.width}×{vp.height} page</span>
        <button className="ghost sm" data-testid="computer-exit" onClick={onExit}>Back to panel</button>
      </div>
      <div className="bm-area" ref={area}>
        <div ref={stage} className="bm-stage" style={{ left: fit.x, top: fit.y, width: fit.width, height: fit.height, position: "fixed" }}>
          {!isDesktop() && <iframe title="browser" src={browser.url} style={{ width: vp.width, height: vp.height, transform: `scale(${fit.scale})`, transformOrigin: "0 0", border: 0 }} />}
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
