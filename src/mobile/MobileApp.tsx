import { cleanPermission } from "../lib/labels";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcpClient, ConnectionState } from "../acp/client";
import { applyUpdate, ChatItem, emptySession, SessionState } from "../acp/session";
import type { ConfigOption, PermissionOutcome, PermissionRequest, SessionModes } from "../acp/types";
import { ModeControl } from "../components/ModeControl";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ToolCard } from "../components/ToolCard";
import { transition } from "../lib/motion";
import { usePullToRefresh, useSwipeBack } from "./gestures";
import { candidates, GatewayTransport, type DeviceCreds } from "../gateway/transport";
import { defaultDeviceName, loadCreds, pendingCredsFromCode, saveCreds } from "./creds";
import { canScan, onPairLink, scanQr } from "./scan";
import { parsePairUri } from "../gateway/crypto";

type Sess = { sessionId: string; title?: string; cwd?: string; _meta?: { project?: string; projectId?: string; group?: string; busy?: boolean } };
type Project = { projectId: string; name: string; cwd: string; group: string };

function Pair({ onPaired }: { onPaired: (c: DeviceCreds) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName());
  const [stage, setStage] = useState<"" | "connecting" | "waiting">("");
  const [err, setErr] = useState("");
  useEffect(() => { void onPairLink((c) => { setCode(c); void pair(c); }).catch(() => {}); }, []);
  const [scanBusy, setScanBusy] = useState(false);
  const pairing = useRef(false);
  async function onScan() {
    setErr("");
    setScanBusy(true);
    try {
      const c = await scanQr();
      if (!c) return;
      setCode(c);
      // Check the code before doing anything with it, so other QR codes just show a message.
      try { parsePairUri(c); } catch (e: any) { setErr(String(e?.message ?? e)); return; }
      await pair(c);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setScanBusy(false);
    }
  }
  async function pair(c = code) {
    if (pairing.current) return;
    pairing.current = true;
    setErr("");
    try {
      const creds = await pendingCredsFromCode(c, name);
      setStage("connecting");
      const t = new GatewayTransport(candidates(creds), creds.deviceId, creds.key, name, undefined, (s) => s === "waiting" && setStage("waiting"));
      t.localIp = await phoneIp();
      await t.open();
      t.close();
      // Remember the address that worked so the next launch tries it first.
      const direct = t.route === "direct" && t.connectedUrl ? t.connectedUrl : creds.url;
      const alts = [creds.url, ...(creds.alts ?? [])].filter((u) => u !== direct);
      onPaired({ ...creds, url: direct, alts, deviceId: t.deviceId });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setStage("");
    } finally {
      pairing.current = false;
    }
  }
  return (
    <div className="m-pair" data-testid="m-pair">
      <div className="m-hero"><div className="logo big"><Icon name="bolt" size={26} /></div><h1>Supercharge Studio</h1><p className="muted">Pair with Supercharge Studio on your computer: Settings → Devices → Show pairing code.</p></div>
      {canScan() && <button className="m-big" disabled={!!stage || scanBusy} onClick={() => void onScan()} data-testid="m-scan"><Icon name="qr" /> Scan QR code</button>}
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
  const [permQueue, setPermQueue] = useState<{ req: PermissionRequest; resolve: (o: PermissionOutcome) => void }[]>([]);
  const perm = permQueue[0] ?? null;
  const [handoff, setHandoff] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [listed, setListed] = useState(false);
  const [loadingSess, setLoadingSess] = useState<string | null>(null);
  const [configBySession, setConfigBySession] = useState<Record<string, ConfigOption[]>>({});
  const [modesBySession, setModesBySession] = useState<Record<string, SessionModes>>({});
  const rememberModes = (sid: string, modes?: SessionModes) => {
    if (modes?.availableModes?.length) setModesBySession((all) => ({ ...all, [sid]: modes }));
  };
  const [picker, setPicker] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [settingOption, setSettingOption] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [route, setRoute] = useState<"direct" | "relay">("direct");
  const client = useRef<AcpClient | null>(null);
  const loadedRef = useRef(new Set<string>());
  const activeSessionRef = useRef<string | null>(null);
  const sessionsRef = useRef(list);
  sessionsRef.current = list;
  const scroller = useRef<HTMLDivElement>(null);
  const threadView = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ptr = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const c = client.current;
    if (!c) return;
    const r: any = await c.listSessions();
    const seen = new Set<string>();
    setList((r.sessions ?? []).filter((x: Sess) => !seen.has(x.sessionId) && !!seen.add(x.sessionId)));
    setListed(true);
    setProjects(r._meta?.projects ?? []);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }, []);

  useEffect(() => {
    if (!creds) return;
    const pending: { sid: string; u: any }[] = [];
    let raf = 0;
    const c = new AcpClient({
      transportFactory: () => { const t = new GatewayTransport(candidates(creds), creds.deviceId, creds.key, creds.name); const o = t.open.bind(t); t.open = async () => { t.localIp = await phoneIp(); await o(); setRoute(t.route); if (t.route === "direct" && t.connectedUrl && t.connectedUrl !== creds.url) { const next = { ...creds, url: t.connectedUrl, alts: [creds.url, ...(creds.alts ?? [])].filter((u) => u !== t.connectedUrl) }; saveCreds(next); } }; return t; },
      clientName: "supercharge-studio-mobile",
      onStateChange: (s) => setConn(s),
      // Token chunks are applied in one state update per animation frame.
      onUpdate: (sid, u) => {
        if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions))
          setConfigBySession((all) => ({ ...all, [sid]: u.configOptions as ConfigOption[] }));
        if (u.sessionUpdate === "current_mode_update")
          setModesBySession((all) => all[sid] ? { ...all, [sid]: { ...all[sid], currentModeId: u.currentModeId as string } } : all);
        pending.push({ sid, u });
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          const q = pending.splice(0);
          setState((all) => { const next = { ...all }; for (const { sid, u } of q) next[sid] = applyUpdate(next[sid] ?? emptySession(), u); return next; });
        });
      },
      onNotification: (method, p: any) => {
        if (method === "_supercharge/permission/resolved") {
          setPermQueue((pending) => pending.filter((item) => {
            if (item.req.sessionId !== p?.sessionId || (p?.toolCallId && item.req.toolCall.toolCallId !== p.toolCallId)) return true;
            item.resolve({ outcome: "cancelled" });
            setToast(`Answered on ${p?.by ?? "another device"}`);
            return false;
          }));
        } else if (method === "_supercharge/handoff") setHandoff(String(p?.sessionId ?? ""));
        else if (method === "_supercharge/sessions/changed") void refresh();
      },
      onPermissionRequest: (req) => new Promise((resolve) => setPermQueue((pending) => [...pending, { req: cleanPermission(req), resolve }])),
      onReconnected: () => {
        loadedRef.current.clear();
        setConfigBySession({});
        setModesBySession({});
        void refresh();
        const sid = activeSessionRef.current;
        if (sid) {
          setState((all) => ({ ...all, [sid]: emptySession() }));
          setLoadingSess(sid);
          void c.loadSession(sid, sessionsRef.current.find((s) => s.sessionId === sid)?.cwd ?? "")
            .then((r: any) => {
              loadedRef.current.add(sid);
              if (Array.isArray(r?.configOptions)) setConfigBySession((all) => ({ ...all, [sid]: r.configOptions }));
              rememberModes(sid, r?.modes);
            })
            .catch((e) => setErr(`Could not reload this chat: ${e?.message ?? e}`))
            .finally(() => setLoadingSess(null));
        }
      },
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
  }, [creds, refresh, retryKey]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  async function openSession(sid: string) {
    activeSessionRef.current = sid;
    setPicker(null);
    setModelSearch("");
    transition(() => setOpen(sid));
    setHandoff(null);
    const c = client.current;
    if (!c || loadedRef.current.has(sid)) return;
    loadedRef.current.add(sid);
    setState((all) => ({ ...all, [sid]: emptySession() }));
    setLoadingSess(sid);
    await c.loadSession(sid, list.find((s) => s.sessionId === sid)?.cwd ?? "")
      .then((r: any) => { if (Array.isArray(r?.configOptions)) setConfigBySession((all) => ({ ...all, [sid]: r.configOptions })); rememberModes(sid, r?.modes); })
      .catch((e) => { loadedRef.current.delete(sid); setErr(`Could not load this chat: ${e?.message ?? e}`); });
    setLoadingSess(null);
  }

  async function newChat(p: Project) {
    const c = client.current;
    if (!c) return;
    const r = await c.newSession(p.cwd, { projectId: p.projectId });
    loadedRef.current.add(r.sessionId);
    activeSessionRef.current = r.sessionId;
    setConfigBySession((all) => ({ ...all, [r.sessionId]: r.configOptions ?? [] }));
    rememberModes(r.sessionId, r.modes);
    setPicker(null);
    setModelSearch("");
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
      setState((all) => ({ ...all, [open]: { ...(all[open] ?? emptySession()), items: [...(all[open]?.items ?? []), { kind: "system", text: `The turn failed: ${e?.message ?? e}`, error: true } as any] } }));
    } finally {
      setBusy((b) => ({ ...b, [open]: false }));
    }
  }

  async function chooseOption(configId: string, value: string) {
    const sid = open;
    const c = client.current;
    if (!sid || !c || settingOption) return;
    setSettingOption(true);
    try {
      const r: any = await c.setConfigOption(sid, configId, value);
      if (Array.isArray(r?.configOptions)) setConfigBySession((all) => ({ ...all, [sid]: r.configOptions }));
      setPicker(null);
      setModelSearch("");
    } catch (e: any) {
      setToast(`Could not change ${configId === "model" ? "model" : configId === "permission_mode" ? "tool permissions" : "reasoning"}: ${e?.message ?? e}`);
    } finally {
      setSettingOption(false);
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

  const back = () => { activeSessionRef.current = null; setPicker(null); transition(() => setOpen(null)); };
  useSwipeBack(threadView, !!open, back);
  usePullToRefresh(listRef, ptr, !!creds && !open, async () => { await refresh(); setToast("Up to date"); });

  if (!creds) return <div className="m-app"><Pair onPaired={(c) => { saveCreds(c); setCreds(c); }} /></div>;

  const title = list.find((s) => s.sessionId === open)?.title ?? "Chat";
  const isBusy = !!(open && busy[open]);
  const sessionOptions = (open && configBySession[open]) || [];
  const modelOption = sessionOptions.find((o) => o.id === "model" && o.options?.length);
  const reasoningOption = sessionOptions.find((o) => o.id === "reasoning_effort" && o.options?.length);
  const permissionOption = sessionOptions.find((o) => o.id === "permission_mode" && o.options?.length);
  const sessionModes = open ? modesBySession[open] : undefined;
  const activeOption = sessionOptions.find((o) => o.id === picker);
  const optionLabel = (option: ConfigOption) => option.options?.find((v) => v.value === option.currentValue)?.name ?? option.currentValue ?? option.name ?? option.id;
  const renderItem = (m: ChatItem, i: number) =>
    m.kind === "tool" ? (sess.toolCalls[m.toolCallId] ? <ToolCard key={i} tc={sess.toolCalls[m.toolCallId]} compact /> : null) : m.kind === "agent" ? <div key={i} className="bubble agent"><Markdown text={m.text} /></div> : <div key={i} className={`bubble ${(m as any).error ? "error" : m.kind}`} role={(m as any).error ? "alert" : undefined}>{m.text}</div>;

  return (
    <div className="m-app">
      <header className="m-top">
        {open ? <button className="icon" aria-label="Back" onClick={back} data-testid="m-back"><Icon name="arrowLeft" size={20} /></button> : <div className="logo"><Icon name="bolt" size={16} /></div>}
        <div className="m-title">{open ? title : creds.desktopName ?? "Supercharge Studio"}</div>
        {conn === "open" && route === "relay" && <span className="pill" data-testid="m-route" title="Connected through the relay (end-to-end encrypted)">relay</span>}
        <span className={`status ${conn === "open" ? "ok" : "bad"}`} data-testid="m-status"><i className="dot" />{conn}</span>
        {open && <button className="icon" title="Open on computer" onClick={() => void client.current?.ext("_supercharge/focus", { sessionId: open })}><Icon name="panelRight" size={18} /></button>}
      </header>
      {err && (
        <div className="notice m-err" role="alert" data-testid="m-err">
          <span>{err}</span>
          <div className="spacer" />
          <button className="secondary compact" onClick={() => { setErr(""); setRetryKey((k) => k + 1); }}>Retry</button>
        </div>
      )}
      {handoff && (
        <button className="m-handoff" data-testid="m-handoff" onClick={() => void openSession(handoff)}><Icon name="phone" /> Continue “{list.find((s) => s.sessionId === handoff)?.title ?? "chat"}” from your computer</button>
      )}
      {!open ? (
        <div className="m-list-wrap">
        <div className="m-ptr" ref={ptr} aria-hidden><Icon name="refresh" size={18} /></div>
        <div className="m-list" ref={listRef} data-testid="m-list">
          {!listed && !err && [0, 1].map((k) => (
            <section key={k} className="m-proj m-skel" aria-busy="true" data-testid="m-skeleton">
              <div className="skeleton" style={{ width: "40%", height: 16, margin: "8px" }} />
              <div className="skeleton" style={{ height: 40, margin: "6px" }} />
              <div className="skeleton" style={{ height: 40, margin: "6px" }} />
            </section>
          ))}
          {listed && grouped.length === 0 && <div className="empty"><div className="empty-icon"><Icon name="folder" size={24} /></div><h2>No projects yet</h2><p className="muted">Add a project on your computer and it will show up here.</p></div>}
          {grouped.map(({ project, sessions }, pi) => (
            <section key={`${project.projectId}-${pi}`} className="m-proj">
              <div className="m-proj-head"><Icon name="folder" size={14} /><b>{project.name}</b><span className="muted">{project.group}</span><div className="spacer" /><button className="icon" aria-label={`New chat in ${project.name}`} data-testid="m-new" onClick={() => void newChat(project)}><Icon name="plus" /></button></div>
              {sessions.length === 0 && <div className="muted m-none">No chats</div>}
              {sessions.map((s, si) => (
                <button key={`${s.sessionId}-${si}`} className="m-chat" data-testid="m-chat" onClick={() => void openSession(s.sessionId)}>
                  <Icon name="chat" size={15} /><span>{s.title || "Untitled"}</span>{s._meta?.busy && <i className="m-busy" aria-label="working" />}<Icon name="chevronRight" size={14} />
                </button>
              ))}
            </section>
          ))}
          <button className="ghost m-unpair" onClick={() => { saveCreds(null); setCreds(null); }}>Unpair this device</button>
        </div>
        </div>
      ) : (
        <div className="m-view" ref={threadView}>
          <div className="m-thread" ref={scroller} data-testid="m-thread">
            <div className="thread">
              {loadingSess === open && sess.items.length === 0 && (
                <div className="skel-chat" aria-busy="true">
                  <div className="skeleton" style={{ width: "50%", height: 34, marginLeft: "auto" }} />
                  <div className="skeleton" style={{ width: "80%", height: 60 }} />
                  <div className="skeleton" style={{ width: "60%", height: 30 }} />
                </div>
              )}
              {loadingSess !== open && sess.items.length === 0 && !isBusy && <div className="empty"><p className="muted">Say something to start.</p></div>}
              {sess.plan.length > 0 && <section className="m-plan" data-testid="m-plan"><strong>Plan</strong><ol>{sess.plan.map((step, i) => <li key={`${i}-${step.content}`} className={step.status === "completed" ? "completed" : ""}>{step.content} <small>{step.status?.replaceAll("_", " ")}</small></li>)}</ol></section>}
              {sess.items.map(renderItem)}
              {isBusy && <div className="typing"><i /><i /><i /></div>}
            </div>
          </div>
          {(modelOption || reasoningOption || permissionOption || sessionModes) && <div className="m-config-bar">
            {modelOption && <button className="m-config-chip" data-testid="m-model" aria-label={`Model: ${optionLabel(modelOption)}`} onClick={() => { setModelSearch(""); setPicker("model"); }}><Icon name="bolt" size={14} />{optionLabel(modelOption)}</button>}
            {reasoningOption && <button className="m-config-chip" data-testid="m-reasoning" aria-label={`Reasoning: ${optionLabel(reasoningOption)}`} onClick={() => setPicker("reasoning_effort")}>Reasoning: {optionLabel(reasoningOption)}</button>}
            <ModeControl key={open} modes={sessionModes} currentMode={sess.modeId} permission={permissionOption} onMode={async (id) => {
              try {
                await client.current?.setMode(open!, id);
                if (sessionModes) rememberModes(open!, { ...sessionModes, currentModeId: id });
              } catch (e: any) { setToast(`Could not change work mode: ${e?.message ?? e}`); throw e; }
            }} onPermission={async (id, value) => {
              try {
                const result = await client.current?.setConfigOption(open!, id, value);
                if (Array.isArray(result?.configOptions)) setConfigBySession((all) => ({ ...all, [open!]: result.configOptions }));
              } catch (e: any) { setToast(`Could not change tool permissions: ${e?.message ?? e}`); throw e; }
            }} />
          </div>}
          <div className="m-composer">
            <textarea rows={1} value={draft} placeholder="Message Supercharge…" data-testid="m-input" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!isBusy) void send(); } }} />
            {isBusy ? <button className="danger round" aria-label="Stop" onClick={() => client.current?.cancel(open)}><Icon name="stop" /></button> : <button className="round" aria-label="Send" disabled={!draft.trim()} onClick={() => void send()} data-testid="m-send"><Icon name="send" /></button>}
          </div>
        </div>
      )}
      {open && activeOption && (
        <div className="m-sheet-bg" onClick={() => setPicker(null)}>
          <div className="m-sheet m-config-sheet" role="dialog" aria-label={picker === "model" ? "Choose model" : "Choose reasoning"} data-testid="m-config-picker" onClick={(e) => e.stopPropagation()}>
            <div className="m-picker-head"><h3>{picker === "model" ? "Model" : "Reasoning"}</h3><button className="icon" aria-label="Close picker" onClick={() => setPicker(null)}>×</button></div>
            {picker === "model" && <input type="search" aria-label="Search models" placeholder="Search models" value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} />}
            <div className="m-picker-options">
              {(activeOption.options ?? []).filter((v) => picker !== "model" || `${v.name ?? ""} ${v.value}`.toLowerCase().includes(modelSearch.trim().toLowerCase())).map((v) => (
                <button key={v.value} className="m-picker-option" aria-pressed={v.value === activeOption.currentValue} disabled={settingOption} onClick={() => void chooseOption(activeOption.id, v.value)}>
                  <span>{v.name ?? v.value}</span>{v.name && v.name !== v.value && <small>{v.value}</small>}{v.value === activeOption.currentValue && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {perm && (
        <div className="m-sheet-bg">
          <div className="m-sheet" role="dialog" aria-label="Permission request" data-testid="m-perm">
            <h3>Allow this tool call?</h3>
            <p>{perm.req.toolCall.title ?? perm.req.toolCall.toolCallId}</p>
            {perm.req.toolCall.rawInput != null && <pre className="mono">{JSON.stringify(perm.req.toolCall.rawInput, null, 2)}</pre>}
            {perm.req.options.map((o) => (
              <button key={o.optionId} className={`m-big ${o.kind.startsWith("reject") ? "secondary" : ""}`} onClick={() => { perm.resolve({ outcome: "selected", optionId: o.optionId }); setPermQueue((pending) => pending.filter((item) => item !== perm)); }}>{o.name}</button>
            ))}
          </div>
        </div>
      )}
      {toast && <div className="m-toast">{toast}</div>}
    </div>
  );
}

/** The phone's Wi-Fi IPv4 address from the native side, if available (used only for error messages). */
async function phoneIp(): Promise<string | undefined> {
  try {
    const core = await import("@tauri-apps/api/core");
    if (!(core as any).isTauri?.() && !(window as any).__TAURI_INTERNALS__) return undefined;
    return (await core.invoke<string | null>("local_ipv4")) ?? undefined;
  } catch { return undefined; }
}
