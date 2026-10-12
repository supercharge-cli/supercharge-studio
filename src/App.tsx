import { useCallback, useEffect, useRef, useState } from "react";
import { AcpClient, ConnectionState, isAuthError, isModelError } from "./acp/client";
import { applyUpdate, emptySession, SessionState } from "./acp/session";
import type { ConfigOption, PermissionOutcome, PermissionRequest } from "./acp/types";
import { StdioTransport } from "./acp/tauriStdio";
import { browser, browserClientMeta } from "./browser/bridge";
import { BrowserPanel } from "./components/BrowserPanel";
import { PermissionModal } from "./components/Permission";
import { SettingsModal } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { ToolCard } from "./components/ToolCard";
import { appConfig, ensureAgent, keychainGet, keychainSet, mcpUrl } from "./lib/desktop";
import { AppData, applyTree, findProject, load, mapProject, save, uid, wsUrl } from "./lib/store";

export default function App() {
  const [data, setData] = useState<AppData>(load);
  const [conn, setConn] = useState<ConnectionState>("idle");
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [panel, setPanel] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [perm, setPerm] = useState<{ req: PermissionRequest; resolve: (o: PermissionOutcome) => void } | null>(null);
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const clientRef = useRef<AcpClient | null>(null);
  const secretRef = useRef("");
  const mcpRef = useRef<string | null | undefined>(undefined);
  const overrides = useRef<{ bind?: string | null; secret?: string | null } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef(data);
  /** Synchronous data update: keeps dataRef current for async flows. */
  const update = useCallback((fn: (d: AppData) => AppData) => {
    dataRef.current = fn(dataRef.current);
    setData(dataRef.current);
  }, []);

  useEffect(() => {
    save(data);
  }, [data]);

  const chatIdForSession = (sid: string) => {
    for (const g of dataRef.current.groups)
      for (const p of g.projects) for (const c of p.chats) if (c.sessionId === sid) return c.id;
    return null;
  };

  const connect = useCallback(async () => {
    clientRef.current?.close();
    // Environment overrides (desktop launcher) apply to this run only; never persisted.
    if (!overrides.current) overrides.current = await appConfig();
    const o = overrides.current;
    let base = dataRef.current.settings;
    if (base.secretInKeychain) {
      const k = await keychainGet();
      if (k) base = { ...base, secret: k };
    }
    secretRef.current = base.secret;
    const s = { ...base, ...(o.bind ? { bind: o.bind } : {}), ...(o.secret ? { secret: o.secret } : {}) };
    try {
      if (s.autoStart && s.transport === "ws") {
        setStatus("Starting agent…");
        setStatus(`Agent ${await ensureAgent(s.bind, s.secret, s.alwaysApprove)}`);
      }
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    }
    const client = new AcpClient({
      ...(s.transport === "stdio" ? { transportFactory: () => new StdioTransport(s.alwaysApprove) } : { url: wsUrl(s) }),
      clientMeta: browserClientMeta(),
      onStateChange: (st, info) => {
        setConn(st);
        if (st === "reconnecting") setStatus(`Reconnecting (attempt ${info?.attempt}, ${info?.delayMs}ms)…`);
      },
      onUpdate: (sid, u) => {
        const cid = chatIdForSession(sid);
        if (!cid) return;
        setSessions((all) => ({ ...all, [cid]: applyUpdate(all[cid] ?? emptySession(), u) }));
        if (u.sessionUpdate === "config_option_update" && Array.isArray((u as any).configOptions)) setConfigOptions((u as any).configOptions);
        if (u.sessionUpdate === "session_info_update" && typeof (u as any).title === "string" && (u as any).title)
          update((d) => ({ ...d, groups: d.groups.map((g) => ({ ...g, projects: g.projects.map((p) => ({ ...p, chats: p.chats.map((c) => (c.id === cid ? { ...c, title: String((u as any).title).slice(0, 60) } : c)) })) })) }));
      },
      onPermissionRequest: (req) => new Promise((resolve) => setPerm({ req, resolve })),
      onReconnected: () => setStatus("Reconnected"),
    });
    browser.attach(client);
    clientRef.current = client;
    try {
      await client.connect();
      const init = await client.initialize();
      setStatus(`Connected${init.agentInfo?.version ? ` · agent ${init.agentInfo.version}` : ""}`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    void browser.serveMcp().then((u) => (off = u));
    return () => off?.();
  }, []);

  useEffect(() => {
    void connect();
    return () => clientRef.current?.close();
  }, [connect]);

  const active = findProject(data, data.activeProjectId);
  const activeChat = active?.project.chats.find((c) => c.id === data.activeChatId);
  const sess = (activeChat && sessions[activeChat.id]) || emptySession();

  useEffect(() => {
    const el = bottomRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sess.items.length, sess]);

  async function ensureSession(projectId: string, chatId: string): Promise<string | null> {
    const c = clientRef.current;
    const found = findProject(dataRef.current, projectId);
    const chat = found?.project.chats.find((x) => x.id === chatId);
    if (!c || !found || !chat) return null;
    if (chat.sessionId) return chat.sessionId;
    if (mcpRef.current === undefined) mcpRef.current = await mcpUrl();
    const httpMcp = !!(c.initResult?.agentCapabilities?.mcpCapabilities as any)?.http;
    const mcpServers = mcpRef.current && httpMcp ? [{ type: "http", name: "supercharge-studio-browser", url: mcpRef.current, headers: [] }] : [];
    const res = await c.newSession(found.project.cwd, { yoloMode: dataRef.current.settings.alwaysApprove }, mcpServers);
    setConfigOptions(res.configOptions ?? []);
    update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, sessionId: res.sessionId } : x)) })));
    return res.sessionId;
  }

  function newChat(projectId: string) {
    const chat = { id: uid(), title: "New chat", createdAt: Date.now() };
    update((d) => ({ ...mapProject(d, projectId, (p) => ({ ...p, chats: [chat, ...p.chats] })), activeProjectId: projectId, activeChatId: chat.id }));
    return chat.id;
  }

  async function selectChat(projectId: string, chatId: string) {
    update((d) => ({ ...d, activeProjectId: projectId, activeChatId: chatId }));
    const c = clientRef.current;
    const chat = findProject(dataRef.current, projectId)?.project.chats.find((x) => x.id === chatId);
    if (c && chat?.sessionId && !sessions[chatId] && c.initResult?.agentCapabilities?.loadSession) {
      setSessions((all) => ({ ...all, [chatId]: emptySession() }));
      await c.loadSession(chat.sessionId, findProject(dataRef.current, projectId)!.project.cwd).catch(() => {});
    }
  }

  async function send() {
    const text = draft.trim();
    const c = clientRef.current;
    if (!text || !c || !active) return;
    let chatId = activeChat?.id;
    if (!chatId) chatId = newChat(active.project.id);
    setDraft("");
    const projectId = active.project.id;
    if (activeChat?.title === "New chat" || !activeChat)
      update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, title: text.slice(0, 40) } : x)) })));
    setSessions((all) => ({ ...all, [chatId!]: { ...(all[chatId!] ?? emptySession()), items: [...(all[chatId!]?.items ?? []), { kind: "user", text }] } }));
    setBusy((b) => ({ ...b, [chatId!]: true }));
    try {
      let sid = await ensureSession(projectId, chatId);
      if (!sid) throw new Error("No session");
      let r;
      try {
        r = await c.prompt(sid, text);
      } catch (e: any) {
        // Session unknown to this agent (e.g. agent restarted): start a fresh one and retry once.
        if (!/session.*not found|unknown session|no such session/i.test(String(e?.message))) throw e;
        update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, sessionId: undefined } : x)) })));
        sid = await ensureSession(projectId, chatId);
        if (!sid) throw e;
        r = await c.prompt(sid, text);
      }
      if (r.stopReason !== "end_turn")
        setSessions((all) => ({ ...all, [chatId!]: { ...all[chatId!], items: [...all[chatId!].items, { kind: "system", text: `stopped: ${r.stopReason}` }] } }));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const text = isAuthError(e)
        ? "No model provider is configured for the agent. Run `supercharge` in a terminal and use /setup, or send `/setup <provider> <api_key>` here.\n\n" + msg
        : isModelError(e)
          ? "The selected model is not available from your provider. Pick another model in Settings (or set `[models] default` in ~/.supercharge/config.toml).\n\n" + msg
          : `Error: ${msg}`;
      setSessions((all) => ({ ...all, [chatId!]: { ...(all[chatId!] ?? emptySession()), items: [...(all[chatId!]?.items ?? []), { kind: "system", text }] } }));
    } finally {
      setBusy((b) => ({ ...b, [chatId!]: false }));
    }
  }

  // Native webviews draw above the DOM: hide the side browser while a modal is open.
  useEffect(() => {
    void browser.setVisible(!showSettings && !perm);
  }, [showSettings, perm]);

  const isBusy = !!(activeChat && busy[activeChat.id]);
  const tools = Object.values(sess.toolCalls).reverse();
  const commands: { name: string; description?: string }[] =
    sess.commands.length > 0 ? sess.commands : ((clientRef.current?.initResult?._meta as any)?.availableCommands ?? []);

  return (
    <div className={`app ${panel ? "with-panel" : ""}`}>
      <Sidebar
        data={data}
        collapsed={sideCollapsed}
        onToggle={() => setSideCollapsed((x) => !x)}
        onSelectChat={(p, c) => void selectChat(p, c)}
        onSelectProject={(pid) => update((d) => ({ ...d, activeProjectId: pid, activeChatId: undefined }))}
        onNewChat={(p) => void newChat(p)}
        onTree={(a) => update((d) => applyTree(d, a))}
        onSettings={() => setShowSettings(true)}
      />
      <main className="main">
        <header className="topbar">
          <span className="brand">Supercharge Studio</span>
          <strong>{active ? `${active.group.name} / ${active.project.name}` : "Select a project"}</strong>
          <span className="muted">{activeChat?.title}</span>
          <div style={{ flex: 1 }} />
          <span className={`status ${conn === "open" ? "ok" : "bad"}`} title={status}>{conn}</span>
          {conn !== "open" && <button className="secondary" onClick={() => void connect()}>Connect</button>}
          <button className="secondary" onClick={() => setPanel((x) => !x)}>{panel ? "Hide panel" : "Browser / tools"}</button>
        </header>
        {(notice || (conn !== "open" && status)) && (
          <div className="notice" data-testid="notice">
            <span>{notice || status}</span>
            {notice && <button className="icon sm" onClick={() => setNotice("")}>×</button>}
          </div>
        )}
        <div className="messages">
          {!activeChat && <div className="empty">Pick a project, then start a chat. Status: {status || conn}</div>}
          {sess.plan.length > 0 && (
            <div className="plan">{sess.plan.map((e, i) => <div key={i} className={`plan-${e.status}`}>{e.status === "completed" ? "☑" : "☐"} {e.content}</div>)}</div>
          )}
          {sess.items.map((m, i) =>
            m.kind === "tool" ? (
              sess.toolCalls[m.toolCallId] && <ToolCard key={i} tc={sess.toolCalls[m.toolCallId]} />
            ) : (
              <div key={i} className={`bubble ${m.kind}`}>{m.text}</div>
            ),
          )}
          <div ref={bottomRef} />
        </div>
        {draft.startsWith("/") && commands.length > 0 && (
          <div className="slash">
            {commands.filter((c) => c.name.startsWith(draft.slice(1).split(" ")[0])).map((c) => (
              <button key={c.name} className="secondary" title={c.description} onClick={() => setDraft(`/${c.name} `)}>/{c.name}</button>
            ))}
          </div>
        )}
        <div className="composer">
          <textarea
            value={draft}
            placeholder={conn === "open" ? (active ? `Message Supercharge in ${active.project.cwd}` : "Select a project") : "Agent not connected"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!isBusy) void send();
              }
            }}
            disabled={conn !== "open" || !active}
          />
          {isBusy ? (
            <button className="danger" onClick={() => activeChat?.sessionId && clientRef.current?.cancel(activeChat.sessionId)}>Stop</button>
          ) : (
            <button onClick={() => void send()} disabled={conn !== "open" || !active || !draft.trim()}>Send</button>
          )}
        </div>
      </main>
      {panel && <BrowserPanel tools={tools} onClose={() => setPanel(false)} />}
      {showSettings && (
        <SettingsModal
          value={{ ...data.settings, secret: secretRef.current || data.settings.secret }}
          configOptions={configOptions}
          extensions={clientRef.current ? [...clientRef.current.extensions.methods, ...clientRef.current.extensions.features, ...clientRef.current.extensions.notifications] : []}
          onClose={() => setShowSettings(false)}
          onConfig={(id, v) => activeChat?.sessionId && void clientRef.current
              ?.setConfigOption(activeChat.sessionId, id, v)
              .then((r: any) => Array.isArray(r?.configOptions) && setConfigOptions(r.configOptions))
              .catch((e: any) => setNotice(`Could not set ${id}: ${e?.message ?? e}`))}
          onSave={async (settings) => {
            const stored = (await keychainSet(settings.secret)) ? { ...settings, secret: "", secretInKeychain: true } : { ...settings, secretInKeychain: false };
            update((d) => ({ ...d, settings: stored }));
            setShowSettings(false);
            void connect();
          }}
        />
      )}
      {perm && (
        <PermissionModal
          req={perm.req}
          onAnswer={(o) => {
            perm.resolve(o);
            setPerm(null);
          }}
        />
      )}
    </div>
  );
}
