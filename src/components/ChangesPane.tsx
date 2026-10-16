import "./changes.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commitMessageHook, git, type GitFile, type GitStatus } from "../lib/git";
import { fileStats, heuristicMessage, highlight, hunkPatch, parseUnifiedDiff, sideBySide, type GFile, type GLine } from "../lib/gitDiff";
import { listen } from "../lib/desktop";
import { Icon } from "./Icon";

const label = (f: GitFile) => (f.y === "?" ? "U" : f.x === "A" ? "A" : f.y === "D" || f.x === "D" ? "D" : f.x === "R" ? "R" : "M");
const staged = (f: GitFile) => f.x !== " " && f.x !== "?";

function Code({ l }: { l?: GLine }) {
  if (!l) return <span className="cd-empty" />;
  return <span className={`cd-l cd-${l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx"}`}>{highlight(l.s).map(([t, c], i) => (c ? <span key={i} className={c}>{t}</span> : t))}</span>;
}

/** Project working-tree changes vs HEAD with per-file / per-hunk keep or reject, plus Git controls. */
export function ChangesPane({ cwd, onCount }: { cwd?: string; onCount?: (n: number) => void }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [sel, setSel] = useState<string>("");
  const [diff, setDiff] = useState<GFile | null>(null);
  const [split, setSplit] = useState(() => localStorage.getItem("sc-diff-split") === "1");
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const root = st?.root ?? cwd ?? "";
  const selRef = useRef(sel);
  selRef.current = sel;

  const refresh = useCallback(async () => {
    if (!cwd) return;
    try {
      const s = await git.status(cwd);
      setSt(s); setErr("");
      onCount?.(s.repo ? s.files.length : 0);
      if (s.repo && (!selRef.current || !s.files.some((f) => f.path === selRef.current))) setSel(s.files[0]?.path ?? "");
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }, [cwd, onCount]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener("sc-changes-refresh", on);
    window.addEventListener("focus", on);
    const t = setInterval(on, 5000);
    let un: (() => void) | undefined;
    void listen("fs-changed", on).then((u) => (un = u));
    return () => { window.removeEventListener("sc-changes-refresh", on); window.removeEventListener("focus", on); clearInterval(t); un?.(); };
  }, [refresh]);

  const loadDiff = useCallback(async () => {
    if (!root || !sel) { setDiff(null); return; }
    try { setDiff(parseUnifiedDiff(await git.diffFile(root, sel))[0] ?? null); } catch (e: any) { setErr(String(e?.message ?? e)); }
  }, [root, sel]);
  const statusKey = useMemo(() => JSON.stringify(st?.files ?? []), [st]);
  useEffect(() => { void loadDiff(); }, [loadDiff, statusKey]);

  const run = async (what: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(what); setNote("");
    try { const r = await f(); if (ok) setNote(ok.replace("$", String(r ?? ""))); } catch (e: any) { setNote(String(e?.message ?? e)); }
    setBusy(""); await refresh(); void loadDiff();
  };

  if (!cwd) return <div className="changes-empty muted">Open a project to see its changes.</div>;
  if (err && !st) return <div className="changes-empty muted">{err}</div>;
  if (st && !st.repo) return <div className="changes-empty muted" data-testid="changes-norepo">This folder is not a git repository.</div>;

  const files = st?.files ?? [];
  const cur = files.find((f) => f.path === sel);
  const generate = async () => {
    setBusy("gen");
    try {
      const d = await git.diffAll(root, 40000).catch(() => "");
      const ai = commitMessageHook.ask ? await commitMessageHook.ask(d).catch(() => null) : null;
      setMsg((ai && ai.trim()) || heuristicMessage(files, parseUnifiedDiff(d)));
    } finally { setBusy(""); }
  };
  const newBranch = async () => {
    const { askName, branchError } = await import("../lib/askName");
    const n = await askName({ title: "New branch", label: `Created from ${st?.branch ?? "HEAD"} and checked out`, placeholder: "feature/my-change", validate: (v) => branchError(v) ?? (branches.includes(v.trim()) ? "A branch with that name exists" : null) });
    if (n) void run("branch", () => git.checkout(root, n, true), `Switched to ${n}`);
  };

  return (
    <div className="changes" data-testid="changes-pane">
      <div className="git-bar">
        <Icon name="code" size={13} />
        <select
          data-testid="git-branch"
          value={st?.branch ?? ""}
          onFocus={() => void git.branches(root).then(setBranches).catch(() => {})}
          onChange={(e) => { if (e.target.value === "__new") void newBranch(); else void run("switch", () => git.checkout(root, e.target.value, false), `Switched to ${e.target.value}`); }}
        >
          {[...new Set([st?.branch ?? "", ...branches])].filter(Boolean).map((b) => <option key={b} value={b}>{b}</option>)}
          <option value="__new">+ New branch…</option>
        </select>
        <span className="muted small" data-testid="git-ab" title={st?.upstream ? `vs ${st.upstream}` : "No upstream"}>↑{st?.ahead ?? 0} ↓{st?.behind ?? 0}</span>
        <div style={{ flex: 1 }} />
        <button className="icon sm" title="Refresh" onClick={() => void refresh()}><Icon name="refresh" size={13} /></button>
        <button className="ghost compact" data-testid="git-push" disabled={!!busy} onClick={() => void run("push", () => git.push(root), "Pushed")}>Push</button>
        <button className="ghost compact" data-testid="git-pr" disabled={!!busy} onClick={() => void run("pr", () => git.openPr(root), "Opened $")}>Open PR</button>
      </div>
      {note && <div className="git-note small" data-testid="git-note">{note}</div>}
      <div className="changes-files" data-testid="changes-files">
        {!files.length && <div className="muted small changes-none">No changes. The working tree matches HEAD.</div>}
        {files.map((f) => (
          <div key={f.path} className={`ch-row${sel === f.path ? " on" : ""}${kept.has(f.path) ? " kept" : ""}`} data-testid="change-file">
            <input type="checkbox" title={staged(f) ? "Unstage" : "Stage"} checked={staged(f)} onChange={() => void run("stage", () => git.stage(root, [f.path], !staged(f)))} />
            <button className="ch-name" onClick={() => setSel(f.path)} title={f.path}>
              <span className={`ch-st ch-${label(f)}`}>{label(f)}</span>
              <span className="ch-base">{f.path.split("/").pop()}</span>
              <span className="muted small ch-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
            </button>
          </div>
        ))}
      </div>
      {cur && (
        <div className="diff-view" data-testid="diff-view">
          <div className="diff-head">
            <strong className="small">{cur.path}</strong>
            {diff && (() => { const s = fileStats(diff); return <span className="small"><span className="d-add">+{s.add}</span> <span className="d-del">−{s.del}</span></span>; })()}
            <div style={{ flex: 1 }} />
            <button className="ghost compact" data-testid="diff-mode" onClick={() => { localStorage.setItem("sc-diff-split", split ? "0" : "1"); setSplit(!split); }}>{split ? "Unified" : "Split"}</button>
            <button className="ghost compact" data-testid="file-keep" onClick={() => { setKept((k) => new Set(k).add(cur.path)); void run("stage", () => git.stage(root, [cur.path], true), "Kept and staged"); }}><Icon name="check" size={12} /> Keep</button>
            <button className="ghost compact reject" data-testid="file-reject" onClick={() => { if (confirm(`Discard all changes to ${cur.path}?`)) void run("restore", () => git.restoreFile(root, cur.path), "Reverted file"); }}><Icon name="x" size={12} /> Reject</button>
          </div>
          {diff?.binary && <div className="muted small">Binary file</div>}
          {diff?.hunks.map((h, i) => (
            <div className="hunk" key={`${h.header}-${i}`} data-testid="hunk">
              <div className="hunk-head">
                <code className="muted small">{h.header.replace(/^(@@[^@]*@@).*/, "$1")}</code>
                <div style={{ flex: 1 }} />
                <button className="ghost compact" title="Keep this change" onClick={() => setKept((k) => new Set(k).add(`${cur.path}#${h.header}`))}>{kept.has(`${cur.path}#${h.header}`) ? "Kept" : "Keep"}</button>
                <button className="ghost compact reject" data-testid="hunk-reject" title="Revert this change" onClick={() => void run("hunk", () => git.revertHunk(root, hunkPatch(diff, i)), "Reverted change")}>Reject</button>
              </div>
              {split ? (
                <div className="cd-split">
                  {sideBySide(h).map((r, j) => (
                    <div className="cd-row" key={j}>
                      <span className="cd-n">{r.l?.a ?? ""}</span><Code l={r.l} />
                      <span className="cd-n">{r.r?.b ?? ""}</span><Code l={r.r} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="cd-uni">
                  {h.lines.filter((l) => l.t !== "\\").map((l, j) => (
                    <div className="cd-row" key={j}><span className="cd-n">{l.a ?? ""}</span><span className="cd-n">{l.b ?? ""}</span><span className={`cd-sign cd-${l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx"}`}>{l.t}</span><Code l={l} /></div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="commit-box">
        <textarea data-testid="commit-msg" rows={2} placeholder="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)} />
        <div className="row">
          <button className="ghost compact" data-testid="commit-gen" disabled={!files.length || !!busy} onClick={() => void generate()}><Icon name="bolt" size={12} /> {busy === "gen" ? "Generating…" : "Generate message"}</button>
          <div style={{ flex: 1 }} />
          <button className="primary compact" data-testid="commit-btn" disabled={!msg.trim() || !files.length || !!busy}
            onClick={() => void run("commit", async () => { const h = await git.commit(root, msg, !files.some(staged)); setMsg(""); setKept(new Set()); return h; }, "Committed $")}>
            Commit{files.some(staged) ? " staged" : " all"}
          </button>
        </div>
      </div>
    </div>
  );
}
