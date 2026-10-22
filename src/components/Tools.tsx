import { useEffect, useState } from "react";
import { invoke, isDesktop } from "../lib/desktop";
import type { AppData } from "../lib/store";
import { promptName, type Prompt } from "../lib/prompts";
import type { McpServer } from "../lib/mcpServers";
import type { Schedule } from "../lib/schedules";
import { uid } from "../lib/store";
import { Icon } from "./Icon";

export type ToolsTab = "prompts" | "running" | "rules" | "mcp" | "schedules";
/** A chat that is working or has queued messages. */
export type Run = { chatId: string; title: string; project: string; busy: boolean; queued: { id: string; text: string }[] };
/** What the tools screen needs from the app. */
export type ToolsApp = { cwd?: string; runs: Run[]; stop: (chatId: string) => void; open: (chatId: string) => void; unqueue: (chatId: string, id: string) => void };
type Props = { data: AppData; update: (f: (d: AppData) => AppData) => void; tab?: ToolsTab; onClose: () => void; app: ToolsApp };
const TABS: { id: ToolsTab; label: string; icon: string }[] = [
  { id: "prompts", label: "Prompts", icon: "edit" },
  { id: "running", label: "Running", icon: "bolt" },
  { id: "rules", label: "Rules & memory", icon: "file" },
  { id: "mcp", label: "MCP servers", icon: "server" },
  { id: "schedules", label: "Scheduled runs", icon: "refresh" },
];

/** Editable list of rows; `blank` is a new row, `fields` renders one row's inputs. */
export function Rows<T>({ rows, set, blank, fields, id }: { rows: T[]; set: (r: T[]) => void; blank: T; fields: (r: T, ch: (p: Partial<T>) => void) => any; id: string }) {
  return (
    <>
      {rows.map((r, i) => (
        <div className="card tool-row" key={i} data-testid={`${id}-row`}>
          <div className="grow">{fields(r, (p) => set(rows.map((x, j) => (j === i ? { ...x, ...p } : x))))}</div>
          <button className="ghost icon" aria-label="Remove" onClick={() => set(rows.filter((_, j) => j !== i))}><Icon name="trash" /></button>
        </div>
      ))}
      <button className="secondary" data-testid={`${id}-add`} onClick={() => set([...rows, blank])}><Icon name="plus" /> Add</button>
    </>
  );
}

function Prompts({ data, update }: Props) {
  const set = (prompts: Prompt[]) => update((d) => ({ ...d, prompts }));
  return (
    <>
      <p className="muted small">Each prompt is a slash command: type <code>/name</code> in the composer, here or on your phone. <code>$ARGUMENTS</code> is replaced by what you type after the name.</p>
      <Rows id="prompt" rows={data.prompts ?? []} set={set} blank={{ name: "", text: "" }} fields={(p, ch) => (
        <>
          <label>Command<input data-testid="prompt-name" placeholder="review" value={p.name} onChange={(e) => ch({ name: promptName(e.target.value) })} /></label>
          <label>Prompt<textarea data-testid="prompt-text" rows={3} value={p.text} onChange={(e) => ch({ text: e.target.value })} /></label>
        </>
      )} />
    </>
  );
}

function Running({ app }: Props) {
  if (!app.runs.length) return <p className="muted">Nothing is running. Chats that are working, queued messages and scheduled runs show up here.</p>;
  return app.runs.map((r) => (
    <div className="card" key={r.chatId} data-testid="run-row">
      <div className="row"><i className={`dot ${r.busy ? "ok" : ""}`} /><strong className="grow">{r.title}</strong><span className="muted small">{r.project} · {r.busy ? "working" : "waiting"}</span>
        <button className="secondary compact" onClick={() => app.open(r.chatId)}>Open</button>
        {r.busy && <button className="secondary compact" data-testid="run-stop" onClick={() => app.stop(r.chatId)}><Icon name="stop" /> Stop</button>}
      </div>
      {r.queued.map((q) => <div className="row small" key={q.id}><span className="grow muted">Queued: {q.text}</span><button className="ghost icon" aria-label="Remove from queue" onClick={() => app.unqueue(r.chatId, q.id)}><Icon name="x" /></button></div>)}
    </div>
  ));
}

type RuleFile = { scope: string; name: string; path: string; exists: boolean };
function Rules({ app }: Props) {
  const cwd = app.cwd ?? "";
  const [files, setFiles] = useState<RuleFile[]>([]);
  const [sel, setSel] = useState<RuleFile | null>(null);
  const [text, setText] = useState(""), [saved, setSaved] = useState(""), [err, setErr] = useState(""), [nn, setNn] = useState("");
  const refresh = () => invoke<RuleFile[]>("rules_list", { cwd }).then(setFiles, (e) => setErr(String(e)));
  useEffect(() => { if (isDesktop()) void refresh(); }, [cwd]);
  const open = (f: RuleFile) => { setSel(f); setErr(""); void invoke<string>("rules_read", { cwd, scope: f.scope, name: f.name }).then((t) => { setText(t); setSaved(t); }, (e) => setErr(String(e))); };
  const save = (f = sel!, t = text) => invoke("rules_write", { cwd, scope: f.scope, name: f.name, text: t }).then(() => { setSaved(t); void refresh(); }, (e) => setErr(String(e)));
  if (!isDesktop()) return <p className="muted">Rules files are edited in the desktop app.</p>;
  return (
    <>
      <p className="muted small">The agent reads these at the start of every session: project files from {cwd || "the open project"}, global ones from ~/.supercharge.</p>
      {files.map((f) => (
        <button key={f.path} className={`secondary rule-file ${sel?.path === f.path ? "on" : ""}`} data-testid="rule-file" title={f.path} onClick={() => open(f)}>
          <Icon name="file" /> <span className="grow">{f.scope === "global" ? "~/.supercharge/" : ""}{f.name}</span><span className="muted small">{f.scope}{f.exists ? "" : " · new"}</span>
        </button>
      ))}
      <div className="row">
        <input placeholder="new-rule" value={nn} data-testid="rule-new" onChange={(e) => setNn(e.target.value.replace(/[^\w.-]/g, "-"))} />
        {(["project", "global"] as const).map((scope) => <button key={scope} className="secondary" disabled={!nn} onClick={() => { const f = { scope, name: `rules/${nn.replace(/\.md$/, "")}.md`, path: "", exists: false }; setNn(""); setSel(f); setText(""); setSaved(""); }}><Icon name="plus" /> {scope} rule</button>)}
      </div>
      {sel && (
        <div className="card">
          <strong>{sel.scope === "global" ? "~/.supercharge/" : ""}{sel.name}</strong>
          <textarea rows={14} className="mono" data-testid="rule-text" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row end">
            {sel.name.startsWith("rules/") && sel.exists && <button className="ghost" onClick={() => void save(sel, "").then(() => setSel(null))}><Icon name="trash" /> Delete</button>}
            <button data-testid="rule-save" disabled={text === saved && sel.exists} onClick={() => void save()}>Save</button>
          </div>
        </div>
      )}
      {err && <p className="error-text">{err}</p>}
    </>
  );
}

function Mcp({ data, update }: Props) {
  const set = (mcpServers: McpServer[]) => update((d) => ({ ...d, mcpServers }));
  return (
    <>
      <p className="muted small">Tool servers the agent can use. Enabled servers attach to new chats and to chats you reopen. Leave Command empty and set a URL for an HTTP server.</p>
      <Rows id="mcp" rows={data.mcpServers ?? []} set={set} blank={{ name: "", on: true, command: "" }} fields={(s, ch) => (
        <>
          <div className="row"><input placeholder="Name" data-testid="mcp-name" value={s.name} onChange={(e) => ch({ name: e.target.value })} /><label className="check"><input type="checkbox" checked={s.on} onChange={(e) => ch({ on: e.target.checked })} /> Enabled</label></div>
          <div className="row"><input placeholder="Command (npx, uvx, /path/to/server)" data-testid="mcp-command" value={s.command ?? ""} onChange={(e) => ch({ command: e.target.value })} /><input placeholder="Arguments" value={s.args ?? ""} onChange={(e) => ch({ args: e.target.value })} /></div>
          <input placeholder="or URL (https://…/mcp)" data-testid="mcp-url" value={s.url ?? ""} onChange={(e) => ch({ url: e.target.value })} />
          <textarea rows={2} placeholder={s.url ? "Headers, one per line (Name: value)" : "Environment, one per line (NAME=value)"} value={s.env ?? ""} onChange={(e) => ch({ env: e.target.value })} />
        </>
      )} />
    </>
  );
}

function Schedules({ data, update }: Props) {
  const projects = data.groups.flatMap((g) => g.projects);
  // Edits clear `next` so the app recomputes it from the new timing.
  const set = (schedules: Schedule[]) => update((d) => ({ ...d, schedules: schedules.map((s, i) => (JSON.stringify(s) === JSON.stringify(d.schedules?.[i]) ? s : { ...s, next: undefined })) }));
  return (
    <>
      <p className="muted small">Each run starts a new chat in its project and sends the prompt. Runs happen while Studio is open (keep it running in the background from Settings → Devices).</p>
      <Rows id="sched" rows={data.schedules ?? []} set={set} blank={{ id: uid(), projectId: data.activeProjectId ?? projects[0]?.id ?? "", prompt: "", on: true, every: 60 }} fields={(s, ch) => (
        <>
          <textarea rows={2} placeholder="Prompt, e.g. Check the CI status and summarize failures" data-testid="sched-prompt" value={s.prompt} onChange={(e) => ch({ prompt: e.target.value })} />
          <div className="row">
            <select value={s.projectId} onChange={(e) => ch({ projectId: e.target.value })}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select value={s.at != null ? "at" : "every"} data-testid="sched-kind" onChange={(e) => ch(e.target.value === "at" ? { at: "09:00", every: undefined } : { every: 60, at: undefined })}><option value="every">Every</option><option value="at">Daily at</option></select>
            {s.at != null ? <input type="time" value={s.at} onChange={(e) => ch({ at: e.target.value })} /> : <><input type="number" min={1} style={{ width: 80 }} value={s.every ?? 60} onChange={(e) => ch({ every: Math.max(1, +e.target.value || 1) })} /> min</>}
            <label className="check"><input type="checkbox" checked={s.on} onChange={(e) => ch({ on: e.target.checked })} /> On</label>
          </div>
          {s.on && s.next && <span className="muted small">Next run {new Date(s.next).toLocaleString()}{s.last ? ` · last ${new Date(s.last).toLocaleString()}` : ""}</span>}
        </>
      )} />
    </>
  );
}

const BODY: Record<ToolsTab, (p: Props) => any> = { schedules: Schedules, prompts: Prompts, running: Running, rules: Rules, mcp: Mcp };

/** Full-screen Studio tools: prompts, rules, MCP servers, schedules, running tasks, checkpoints. */
export function ToolsScreen(p: Props) {
  const [tab, setTab] = useState<ToolsTab>(p.tab ?? "prompts");
  const B = BODY[tab];
  return (
    <div className="screen settings-screen" role="region" aria-label="Tools" data-testid="tools-screen">
      <nav className="screen-nav">
        <div className="screen-nav-title">Tools</div>
        {TABS.map((t) => <button key={t.id} className={tab === t.id ? "on" : ""} data-testid={`tools-${t.id}`} onClick={() => setTab(t.id)}><Icon name={t.icon} /> {t.label}</button>)}
      </nav>
      <div className="screen-main">
        <header className="screen-head"><h2>{TABS.find((t) => t.id === tab)!.label}</h2><div className="spacer" /><button className="ghost icon" aria-label="Close" data-testid="tools-close" onClick={p.onClose}><Icon name="x" /></button></header>
        <div className="screen-body section-anim" key={tab}><B {...p} /></div>
      </div>
    </div>
  );
}
