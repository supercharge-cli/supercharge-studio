import { useEffect, useRef, useState } from "react";
import { cliInstall, type CliStatus, listen } from "../lib/desktop";
import { Icon } from "./Icon";
import "./cli-setup.css";

type Progress = { step: string; pct: number | null; msg: string };

/**
 * Full-screen first-run setup: installs (or updates) the Supercharge CLI from the official
 * release with checksum verification, then hands back to the app, which starts
 * `supercharge agent serve` and continues with provider setup.
 */
export default function CliSetup({ status, onDone, onSkip, mode }: { status: CliStatus | null; mode: "missing" | "outdated" | "update"; onDone: () => void; onSkip?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Progress[]>([]);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const logEl = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<Progress>("cli://progress", (p) => {
      if (p.step === "download") setPct(p.pct ?? null);
      setLog((l) => (p.step === "download" && l.at(-1)?.step === "download" ? [...l.slice(0, -1), p] : [...l, p]));
    }).then((u) => (off = u));
    return () => off?.();
  }, []);
  useEffect(() => { logEl.current?.scrollTo(0, 1e9); }, [log]);
  async function run() {
    setBusy(true); setErr(""); setLog([]); setPct(null);
    try { setDone(await cliInstall()); } catch (e: any) { setErr(String(e?.message ?? e)); }
    setBusy(false);
  }
  const title = mode === "missing" ? "Set up Supercharge" : mode === "outdated" ? "Update the Supercharge CLI" : "A Supercharge CLI update is available";
  const why = mode === "missing"
    ? "Supercharge Studio runs the Supercharge CLI on this computer. It isn't installed yet, so let's install it. It goes in your user folder and doesn't need an admin password."
    : mode === "outdated"
      ? `This app needs Supercharge CLI ${status?.min} or newer; you have ${status?.version}.`
      : `You have ${status?.version}; ${status?.latest} is available.`;
  return (
    <div className="cli-setup" data-testid="cli-setup">
      <div className="cli-card">
        <div className="cli-head"><span className="logo big"><Icon name="bolt" size={22} /></span><div><h2>{title}</h2><p className="muted">{why}</p></div></div>
        <ol className="cli-steps">
          <li className={done ? "ok" : busy ? "on" : ""}><b>Install the CLI</b> <span className="muted small">{status?.latest ? `version ${status.latest}` : "latest release"} · checksum verified · {status?.install_dir}</span></li>
          <li><b>Add a model provider</b> <span className="muted small">your endpoint and API key, next</span></li>
          <li><b>Start the agent</b> <span className="muted small">Supercharge Studio runs <code>supercharge agent serve</code> for you</span></li>
        </ol>
        {(busy || log.length > 0) && (
          <>
            <div className="bar" data-testid="cli-progress"><i style={{ width: `${done ? 100 : pct ?? (busy ? 8 : 0)}%` }} /></div>
            <pre ref={logEl} className="cli-log mono small" data-testid="cli-log">{log.map((l) => `${l.step === "error" ? "✗" : l.step === "done" ? "✓" : "•"} ${l.msg}`).join("\n")}</pre>
          </>
        )}
        {err && <div className="error-text" data-testid="cli-error">{err}</div>}
        <div className="row">
          {done ? (
            <button data-testid="cli-continue" onClick={onDone}>Continue <Icon name="chevronRight" size={14} /></button>
          ) : (
            <button data-testid="cli-install" disabled={busy} onClick={() => void run()}>{busy ? "Installing…" : err ? "Retry" : mode === "missing" ? "Install Supercharge CLI" : "Update now"}</button>
          )}
          {onSkip && !busy && !done && <button className="ghost" data-testid="cli-skip" onClick={onSkip}>{mode === "update" ? "Later" : "I'll install it myself"}</button>}
        </div>
        {(err || mode !== "update") && status?.fallback && (
          <details className="cli-manual" open={!!err}>
            <summary className="small">Install manually instead</summary>
            <p className="muted small">Run this in a terminal, then come back and click Retry:</p>
            <div className="row"><code className="mono small grow">{status.fallback}</code><button className="ghost" onClick={() => void navigator.clipboard?.writeText(status.fallback)}>Copy</button></div>
            <p className="muted small">Already installed somewhere else? Set <code>SUPERCHARGE_BIN</code> to its path and restart the app.</p>
          </details>
        )}
      </div>
    </div>
  );
}
