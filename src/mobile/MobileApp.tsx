import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcpClient, ConnectionState } from "../acp/client";
import { applyUpdate, ChatItem, emptySession, SessionState } from "../acp/session";
import type { PermissionOutcome, PermissionRequest } from "../acp/types";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ToolCard } from "../components/ToolCard";
import { GatewayTransport, type DeviceCreds } from "../gateway/transport";
import { defaultDeviceName, loadCreds, pendingCredsFromCode, saveCreds } from "./creds";
import { canScan, scanQr } from "./scan";

type Sess = { sessionId: string; title?: string; cwd?: string; _meta?: { project?: string; projectId?: string; group?: string; busy?: boolean } };
type Project = { projectId: string; name: string; cwd: string; group: string };

function Pair({ onPaired }: { onPaired: (c: DeviceCreds) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName());
  const [stage, setStage] = useState<"" | "connecting" | "waiting">("");
  const [err, setErr] = useState("");
  async function pair(c = code) {
    setErr("");
    try {
      const creds = await pendingCredsFromCode(c, name);
      setStage("connecting");
      const t = new GatewayTransport(creds.url, creds.deviceId, creds.key, name, undefined, (s) => s === "waiting" && setStage("waiting"));
      await t.open();
      t.close();
      onPaired({ ...creds, deviceId: t.deviceId });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setStage("");
    }
  }
  return (
    <div className="m-pair" data-testid="m-pair">
      <div className="m-hero"><div className="logo big"><Icon name="bolt" size={26} /></div><h1>Supercharge Studio</h1><p className="muted">Pair with Supercharge Studio on your computer: Settings → Devices → Show pairing code.</p></div>
      {canScan() && <button className="m-big" onClick={() => void scanQr().then((c) => { if (c) { setCode(c); void pair(c); } }).catch((e) => setErr(String(e?.message ?? e)))}><Icon name="qr" /> Scan QR code</button>}
      <label>Device name<input value={name} onChange={(e) => setName(e.target.value)} data-testid="m-name" /></label>
      <label>Pairing code<textarea rows={3} value={code} placeholder="scstudio://pair?…" onChange={(e) => setCode(e.target.value)} data-testid="m-code" /></label>
      <button className="m-big" disabled={!code.trim() || !!stage} onClick={() => void pair()} data-testid="m-pair-btn">{stage === "waiting" ? "Confirm on your computer…" : stage === "connecting" ? "Connecting…" : "Pair"}</button>
      {err && <div className="error-text" data-testid="m-error">{err}</div>}
    </div>
  );
}

export default function MobileApp() {
  const [creds, setCreds] = useState<DeviceCreds | null>(loadCreds);
  const [conn, setConn] = useState<ConnectionState>("idle");
  const [err, setErr] = useState("");
  const [list, setList] = useState<Sess[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, SessionState>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [perm, setPerm] = useState<{ req: PermissionRequest; resolve: (o: PermissionOutcome) => void } | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const client = useRef<AcpClient | null>(null);
  const loadedRef = useRef(new Set<string>());
  const scroller = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const c = client.current;
    if (!c) return;
    const r: any = await c.listSessions();
    setList(r.sessions ?? []);
    setProjects(r._meta?.projects ?? []);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }, []);

  useEffect(() => {
    if (!creds) return;
    const c = new AcpClient({
      transportFactory: () => new GatewayTransport(creds.url, creds.deviceId, creds.key, creds.name),
      clientName: "supercharge-studio-mobile",
      onStateChange: (s) => setConn(s),
      onUpdate: (sid, u) => setState((all) => ({ ...all, [sid]: applyUpdate(all[sid] ?? emptySession(), u) })),
      onNotification: (method, p: any) => {
        if (method === "_supercharge/permission/resolved") {
          setPerm((cur) => {
            if (cur && cur.req.sessionId === p?.sessionId) { cur.resolve({ outcome: "cancelled" }); setToast(`Answered on ${p?.by ?? "another device"}`); return null; }
            return cur;
          });
        } else if (method === "_supercharge/handoff") setHandoff(String(p?.sessionId ?? ""));
        else if (method === "_supercharge/sessions/changed") void refresh();
      },
      onPermissionRequest: (req) => new Promise((resolve) => setPerm({ req, resolve })),
      onReconnected: () => { loadedRef.current.clear(); void refresh(); },
    });
    client.current = c;
    (async () => {
      try {
        await c.connect();
        await c.initialize();
        setErr("");
        await refresh();
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
    })();
    return () => c.close();
  }, [creds, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  async function openSession(sid: string) {
    setOpen(sid);
    setHandoff(null);
    const c = client.current;
    if (!c || loadedRef.current.has(sid)) return;
    loadedRef.current.add(sid);
    setState((all) => ({ ...all, [sid]: emptySession() }));
    await c.loadSession(sid, list.find((s) => s.sessionId === sid)?.cwd ?? "").catch((e) => setErr(String(e?.message ?? e)));
  }

  async function newChat(p: Project) {
    const c = client.current;
    if (!c) return;
    const r = await c.newSession(p.cwd, { projectId: p.projectId });
    loadedRef.current.add(r.sessionId);
    await refresh();
    setOpen(r.sessionId);
  }

  async function send() {
    const c = client.current;
    const text = draft.trim();
    if (!c || !open || !text) return;
    setDraft("");
    setBusy((b) => ({ ...b, [open]: true }));
    try {
      const r = await c.prompt(open, text);
      if (r.stopReason !== "end_turn") setState((all) => ({ ...all, [open]: { ...all[open], items: [...all[open].items, { kind: "system", text: `stopped: ${r.stopReason}` }] } }));
    } catch (e: any) {
      setState((all) => ({ ...all, [open]: { ...(all[open] ?? emptySession()), items: [...(all[open]?.items ?? []), { kind: "system", text: `Error: ${e?.message ?? e}` }] } }));
    } finally {
      setBusy((b) => ({ ...b, [open]: false }));
    }
  }

  const sess = (open && state[open]) || emptySession();
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [sess]);

  const grouped = useMemo(() => {
    const m = new Map<string, { project: Project; sessions: Sess[] }>();
    for (const p of projects) m.set(p.projectId, { project: p, sessions: [] });
    for (const s of list) {
      const pid = s._meta?.projectId ?? s.cwd ?? "?";
      if (!m.has(pid)) m.set(pid, { project: { projectId: pid, name: s._meta?.project ?? s.cwd ?? "Project", cwd: s.cwd ?? "", group: s._meta?.group ?? "" }, sessions: [] });
      m.get(pid)!.sessions.push(s);
    }
    return [...m.values()];
  }, [list, projects]);

  if (!creds) return <div className="m-app"><Pair onPaired={(c) => { saveCreds(c); setCreds(c); }} /></div>;

  const title = list.find((s) => s.sessionId === open)?.title ?? "Chat";
  const isBusy = !!(open && busy[open]);
  const renderItem = (m: ChatItem, i: number) =>
    m.kind === "tool" ? (sess.toolCalls[m.toolCallId] ? <ToolCard key={i} tc={sess.toolCalls[m.toolCallId]} compact /> : null) : m.kind === "agent" ? <div key={i} className="bubble agent"><Markdown text={m.text} /></div> : <div key={i} className={`bubble ${m.kind}`}>{m.text}</div>;

  return (
    <div className="m-app">
      <header className="m-top">
        {open ? <button className="icon" aria-label="Back" onClick={() => setOpen(null)} data-testid="m-back"><Icon name="arrowLeft" size={20} /></button> : <div className="logo"><Icon name="bolt" size={16} /></div>}
        <div className="m-title">{open ? title : creds.desktopName ?? "Supercharge Studio"}</div>
        <span className={`status ${conn === "open" ? "ok" : "bad"}`} data-testid="m-status"><i className="dot" />{conn}</span>
        {open && <button className="icon" title="Open on computer" onClick={() => void client.current?.ext("_supercharge/focus", { sessionId: open })}><Icon name="panelRight" size={18} /></button>}
      </header>
      {err && <div className="notice">{err}</div>}
      {handoff && (
        <button className="m-handoff" data-testid="m-handoff" onClick={() => void openSession(handoff)}><Icon name="phone" /> Continue “{list.find((s) => s.sessionId === handoff)?.title ?? "chat"}” from your computer</button>
      )}
      {!open ? (
        <div className="m-list" data-testid="m-list">
          {grouped.length === 0 && <div className="empty"><p className="muted">No projects yet.</p></div>}
          {grouped.map(({ project, sessions }, pi) => (
            <section key={`${project.projectId}-${pi}`} className="m-proj">
              <div className="m-proj-head"><Icon name="folder" size={14} /><b>{project.name}</b><span className="muted">{project.group}</span><div className="spacer" /><button className="icon" aria-label={`New chat in ${project.name}`} data-testid="m-new" onClick={() => void newChat(project)}><Icon name="plus" /></button></div>
              {sessions.length === 0 && <div className="muted m-none">No chats</div>}
              {sessions.map((s, si) => (
                <button key={`${s.sessionId}-${si}`} className="m-chat" data-testid="m-chat" onClick={() => void openSession(s.sessionId)}>
                  <Icon name="chat" size={15} /><span>{s.title || "Untitled"}</span>{s._meta?.busy && <i className="m-busy" />}
                </button>
              ))}
            </section>
          ))}
          <button className="ghost m-unpair" onClick={() => { saveCreds(null); setCreds(null); }}>Unpair this device</button>
        </div>
      ) : (
        <>
          <div className="m-thread" ref={scroller} data-testid="m-thread">
            <div className="thread">
              {sess.items.map(renderItem)}
              {isBusy && <div className="typing"><i /><i /><i /></div>}
            </div>
          </div>
          <div className="m-composer">
            <textarea rows={1} value={draft} placeholder="Message Supercharge…" data-testid="m-input" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!isBusy) void send(); } }} />
            {isBusy ? <button className="danger round" aria-label="Stop" onClick={() => client.current?.cancel(open)}><Icon name="stop" /></button> : <button className="round" aria-label="Send" disabled={!draft.trim()} onClick={() => void send()} data-testid="m-send"><Icon name="send" /></button>}
          </div>
        </>
      )}
      {perm && (
        <div className="m-sheet-bg">
          <div className="m-sheet" role="dialog" aria-label="Permission request" data-testid="m-perm">
            <h3>Allow this tool call?</h3>
            <p>{perm.req.toolCall.title ?? perm.req.toolCall.toolCallId}</p>
            {perm.req.toolCall.rawInput != null && <pre className="mono">{JSON.stringify(perm.req.toolCall.rawInput, null, 2)}</pre>}
            {perm.req.options.map((o) => (
              <button key={o.optionId} className={`m-big ${o.kind.startsWith("reject") ? "secondary" : ""}`} onClick={() => { perm.resolve({ outcome: "selected", optionId: o.optionId }); setPerm(null); }}>{o.name}</button>
            ))}
          </div>
        </div>
      )}
      {toast && <div className="m-toast">{toast}</div>}
    </div>
  );
}
