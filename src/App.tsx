import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcpClient, ConnectionState, isAuthError, isModelError } from "./acp/client";
import { applyUpdate, ChatItem, emptySession, SessionState } from "./acp/session";
import type { ConfigOption, PermissionOutcome, PermissionRequest, SessionUpdate } from "./acp/types";
import { StdioTransport } from "./acp/tauriStdio";
import { browser, browserClientMeta } from "./browser/bridge";
import { BrowserPanel } from "./components/BrowserPanel";
import { Command, CommandPalette } from "./components/CommandPalette";
import { defaultGatewayPrefs, DevicesSection, gatewayBind } from "./components/Devices";
import { Icon } from "./components/Icon";
import { Markdown } from "./components/Markdown";
import { PermissionModal } from "./components/Permission";
import { SettingsScreen } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { ToolCard } from "./components/ToolCard";
import { UsageScreen } from "./components/Usage";
import { VirtualList } from "./components/VirtualList";
import { GatewayHub } from "./gateway/hub";
import { agentRestart, appConfig, ensureAgent, gateway, isDesktop, keychainGet, keychainSet, listen, mcpUrl, providerApply, providerSeedFromEnv, providerSetKey } from "./lib/desktop";
import { AppData, applyTree, findProject, load, mapProject, Provider, save, uid, wsUrl } from "./lib/store";
import { appendUsage, loadPricing, loadUsage, recordsFromUsage, savePricing, usageFromNotification, UsageRecord } from "./lib/usage";

type View = "chat" | "settings" | "usage";
type PermState = { req: PermissionRequest; resolve: (o: PermissionOutcome) => void; token?: number };

const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

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
  const [view, setView] = useState<View>("chat");
  const [settingsSection, setSettingsSection] = useState<"connection" | "devices" | undefined>();
  const [palette, setPalette] = useState(false);
  const [perm, setPerm] = useState<PermState | null>(null);
  const [pairReq, setPairReq] = useState<{ pairingId: string; name: string } | null>(null);
  const [devicesOnline, setDevicesOnline] = useState(0);
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const [usage, setUsage] = useState<UsageRecord[]>(loadUsage);
  const [pricing, setPricing] = useState(loadPricing);
  const clientRef = useRef<AcpClient | null>(null);
  const secretRef = useRef("");
  const mcpRef = useRef<string | null | undefined>(undefined);
  const overrides = useRef<{ bind?: string | null; secret?: string | null } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const dataRef = useRef(data);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const usageSeen = useRef(new Set<string>());
  /** Sessions whose current turn already reported usage via a notification. */
  const turnUsage = useRef(new Set<string>());
  const loaded = useRef(new Set<string>());
  /** Synchronous data update: keeps dataRef current for async flows. */
  const update = useCallback((fn: (d: AppData) => AppData) => {
    dataRef.current = fn(dataRef.current);
    setData(dataRef.current);
  }, []);

  useEffect(() => {
    save(data);
  }, [data]);

  const chatForSession = (sid: string) => {
    for (const g of dataRef.current.groups) for (const p of g.projects) for (const c of p.chats) if (c.sessionId === sid) return { group: g, project: p, chat: c };
    return null;
  };

  // ---- Smooth streaming: coalesce session updates and apply once per frame ----
  const queue = useRef<{ cid: string; u: SessionUpdate }[]>([]);
  const raf = useRef(0);
  const flush = useCallback(() => {
    raf.current = 0;
    const q = queue.current;
    queue.current = [];
    if (q.length === 0) return;
    setSessions((all) => {
      const next = { ...all };
      for (const { cid, u } of q) next[cid] = applyUpdate(next[cid] ?? emptySession(), u);
      return next;
    });
  }, []);
  const enqueue = useCallback((cid: string, u: SessionUpdate) => {
    queue.current.push({ cid, u });
    if (!raf.current) raf.current = (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: any) => setTimeout(f, 16))(flush) as any;
  }, [flush]);
  const pushItem = (cid: string, item: ChatItem) => {
    flush();
    setSessions((all) => ({ ...all, [cid]: { ...(all[cid] ?? emptySession()), items: [...(all[cid]?.items ?? []), item] } }));
  };

  // ---- Usage ----
  const providerName = () => {
    const st = dataRef.current.settings;
    return (st.providers ?? []).find((p) => p.id === st.activeProviderId)?.name ?? "agent";
  };
  const recordUsage = useCallback((sessionId: string, u: any, key: string) => {
    if (usageSeen.current.has(key)) return;
    usageSeen.current.add(key);
    turnUsage.current.add(sessionId);
    const rs = recordsFromUsage(u, { sessionId, provider: providerName() });
    if (rs.length) setUsage(appendUsage(rs));
  }, []);

  // ---- Gateway hub (paired devices) ----
  const hubRef = useRef<GatewayHub | null>(null);
  const deviceNames = useRef(new Map<string, string>());
  if (!hubRef.current) {
    hubRef.current = new GatewayHub(
      (d, msg) => void gateway.send(d, msg),
      {
        sessions: () =>
          dataRef.current.groups.flatMap((g) =>
            g.projects.flatMap((p) => p.chats.filter((c) => c.sessionId).map((c) => ({ sessionId: c.sessionId!, title: c.title, cwd: p.cwd, project: p.name, projectId: p.id, group: g.name, updatedAt: c.createdAt, busy: !!busyRef.current[c.id] }))),
          ),
        projects: () => dataRef.current.groups.flatMap((g) => g.projects.map((p) => ({ projectId: p.id, name: p.name, cwd: p.cwd, group: g.name }))),
        prompt: (sid, text, from) => {
          const f = chatForSession(sid);
          if (!f) return Promise.reject(new Error("Unknown session"));
          return runPrompt(f.project.id, f.chat.id, text, from);
        },
        cancel: (sid) => void clientRef.current?.cancel(sid),
        newSession: async (projectId) => {
          const cid = newChat(projectId, false);
          const sid = await ensureSession(projectId, cid);
          if (!sid) throw new Error("Agent not connected");
          return sid;
        },
        focus: (sid) => {
          const f = chatForSession(sid);
          if (f) { setView("chat"); void selectChat(f.project.id, f.chat.id); }
        },
        ensureLoaded: async (sid) => {
          const f = chatForSession(sid);
          const c = clientRef.current;
          if (!f || !c || sessionsRef.current[f.chat.id] || loaded.current.has(sid)) return;
          await selectChat(f.project.id, f.chat.id, false);
        },
      },
      (d) => deviceNames.current.get(d) ?? "phone",
    );
  }
  const hub = hubRef.current;
  const busyRef = useRef(busy);
  busyRef.current = busy;

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
        hub.update(sid, u);
        const f = chatForSession(sid);
        if (!f) return;
        const cid = f.chat.id;
        enqueue(cid, u);
        const x = u as any;
        if (u.sessionUpdate === "config_option_update" && Array.isArray(x.configOptions)) setConfigOptions(x.configOptions);
        if (u.sessionUpdate === "session_info_update" && typeof x.title === "string" && x.title)
          update((d) => ({ ...d, groups: d.groups.map((g) => ({ ...g, projects: g.projects.map((p) => ({ ...p, chats: p.chats.map((c) => (c.id === cid ? { ...c, title: String(x.title).slice(0, 60) } : c)) })) })) }));
        if (x.usage) {
          const n = usageFromNotification("session/update", { sessionId: sid, update: u });
          if (n) recordUsage(sid, n.usage, `${sid}:${x._meta?.eventId ?? x.prompt_id ?? Date.now()}`);
        }
      },
      onNotification: (method, params: any) => {
        const n = usageFromNotification(method, params);
        if (n) recordUsage(n.sessionId, n.usage, `${n.sessionId}:${params?.update?.prompt_id ?? params?._meta?.eventId ?? Date.now()}`);
      },
      onPermissionRequest: (req) =>
        new Promise((resolve) => {
          let done = false;
          const finish = (o: PermissionOutcome, from: "desktop" | "device", token?: number) => {
            if (done) return;
            done = true;
            if (from === "desktop" && token != null) hub.resolved(token, o);
            setPerm((p) => (p?.req === req ? null : p));
            resolve(o);
          };
          const fan = hub.deviceCount > 0 ? hub.requestPermission(req.sessionId, req) : null;
          fan?.answer.then((o) => finish(o, "device"));
          setPerm({ req, resolve: (o) => finish(o, "desktop", fan?.token), token: fan?.token });
        }),
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

  // Theme
  const theme = data.settings.theme ?? "dark";
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    const apply = () => (document.documentElement.dataset.theme = theme === "system" ? (mq?.matches ? "light" : "dark") : theme);
    apply();
    mq?.addEventListener?.("change", apply);
    return () => mq?.removeEventListener?.("change", apply);
  }, [theme]);

  // First desktop run: optional test provider from the environment (key goes straight to secure storage).
  useEffect(() => {
    if (!isDesktop() || (dataRef.current.settings.providers ?? []).length > 0) return;
    void providerSeedFromEnv("test").then((p) => {
      if (p) update((d) => ({ ...d, settings: { ...d.settings, providers: [p as Provider], activeProviderId: d.settings.activeProviderId } }));
    });
  }, [update]);

  // Gateway: auto-start if enabled, route device traffic into the hub.
  const gwPrefs = data.settings.gateway ?? defaultGatewayPrefs;
  useEffect(() => {
    if (!isDesktop()) return;
    const offs: Promise<() => void>[] = [
      listen<{ deviceId: string; msg: any }>("gateway://message", ({ deviceId, msg }) => void hub.receive(deviceId, msg)),
      listen<{ deviceId: string; name: string }>("gateway://connected", ({ deviceId, name }) => { deviceNames.current.set(deviceId, name); hub.connected(deviceId); setDevicesOnline(hub.deviceCount); }),
      listen<{ deviceId: string }>("gateway://disconnected", ({ deviceId }) => { hub.disconnected(deviceId); setDevicesOnline(hub.deviceCount); }),
      listen<{ pairingId: string; name: string }>("gateway://pair-request", (r) => setPairReq(r)),
    ];
    if (dataRef.current.settings.gateway?.enabled) void gateway.start(gatewayBind(dataRef.current.settings.gateway)).catch((e) => setNotice(`Mobile gateway: ${e}`));
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, []);

  async function activateProvider(p: Provider, all: Provider[]) {
    update((d) => ({ ...d, settings: { ...d.settings, providers: all } }));
    try {
      await providerApply(p);
      const st = dataRef.current.settings;
      const r = await agentRestart(st.bind, secretRef.current || st.secret, st.alwaysApprove);
      update((d) => ({ ...d, settings: { ...d.settings, activeProviderId: p.id } }));
      if (r === "external") setNotice(`Provider "${p.name}" saved to the agent config. Restart \`supercharge agent serve\` to use it.`);
      else setNotice("");
      await connect();
    } catch (e: any) {
      setNotice(`Could not apply provider "${p.name}": ${e?.message ?? e}`);
      throw e;
    }
  }

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
    loaded.current.add(res.sessionId);
    update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, sessionId: res.sessionId } : x)) })));
    hub.sessionsChanged();
    return res.sessionId;
  }

  function newChat(projectId: string, focus = true) {
    const chat = { id: uid(), title: "New chat", createdAt: Date.now() };
    update((d) => ({ ...mapProject(d, projectId, (p) => ({ ...p, chats: [chat, ...p.chats] })), ...(focus ? { activeProjectId: projectId, activeChatId: chat.id } : {}) }));
    if (focus) {
      setView("chat");
      setTimeout(() => composerRef.current?.focus(), 0);
    }
    return chat.id;
  }

  async function selectChat(projectId: string, chatId: string, focus = true) {
    if (focus) {
      update((d) => ({ ...d, activeProjectId: projectId, activeChatId: chatId }));
      setView("chat");
    }
    const c = clientRef.current;
    const chat = findProject(dataRef.current, projectId)?.project.chats.find((x) => x.id === chatId);
    if (c && chat?.sessionId && !sessionsRef.current[chatId] && !loaded.current.has(chat.sessionId) && c.initResult?.agentCapabilities?.loadSession) {
      loaded.current.add(chat.sessionId);
      hub.seed(chat.sessionId, []);
      setSessions((all) => ({ ...all, [chatId]: emptySession() }));
      await c.loadSession(chat.sessionId, findProject(dataRef.current, projectId)!.project.cwd).catch(() => {});
      flush();
    }
  }

  /** Run one prompt in a chat (from the desktop composer or a paired device). */
  async function runPrompt(projectId: string, chatId: string, text: string, from?: string): Promise<{ stopReason: string; usage?: unknown }> {
    const c = clientRef.current;
    if (!c) throw new Error("Agent not connected");
    const chat = findProject(dataRef.current, projectId)?.project.chats.find((x) => x.id === chatId);
    if (chat?.title === "New chat")
      update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, title: text.slice(0, 40) } : x)) })));
    pushItem(chatId, { kind: "user", text: from ? `${text}` : text, ...(from ? { from } : {}) } as ChatItem);
    setBusy((b) => ({ ...b, [chatId]: true }));
    try {
      let sid = await ensureSession(projectId, chatId);
      if (!sid) throw new Error("No session");
      hub.update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { supercharge: { from: from ?? "desktop" } } });
      let r;
      turnUsage.current.delete(sid);
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
      flush();
      // Prefer the agent's turn report; fall back to `usage` on the prompt result.
      if ((r as any).usage && !turnUsage.current.has(sid)) recordUsage(sid, (r as any).usage, `${sid}:result:${Date.now()}`);
      if (r.stopReason !== "end_turn") pushItem(chatId, { kind: "system", text: `stopped: ${r.stopReason}` });
      return r as any;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const t = isAuthError(e)
        ? "No model provider is configured for the agent. Run `supercharge` in a terminal and use /setup, or send `/setup <provider> <api_key>` here.\n\n" + msg
        : isModelError(e)
          ? "The selected model is not available from your provider. Pick another model in Settings (or set `[models] default` in ~/.supercharge/config.toml).\n\n" + msg
          : `Error: ${msg}`;
      pushItem(chatId, { kind: "system", text: t });
      throw e;
    } finally {
      setBusy((b) => ({ ...b, [chatId]: false }));
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || !clientRef.current || !active) return;
    const chatId = activeChat?.id ?? newChat(active.project.id);
    setDraft("");
    if (composerRef.current) composerRef.current.style.height = "auto";
    await runPrompt(active.project.id, chatId, text).catch(() => {});
  }

  const stop = () => activeChat?.sessionId && clientRef.current?.cancel(activeChat.sessionId);

  // Native webviews draw above the DOM: hide the side browser while an overlay or another screen is shown.
  const browserVisible = view === "chat" && panel && !perm && !palette && !pairReq;
  useEffect(() => {
    void browser.setVisible(browserVisible);
  }, [browserVisible]);

  const isBusy = !!(activeChat && busy[activeChat.id]);
  const tools = Object.values(sess.toolCalls).reverse();
  const commands: { name: string; description?: string }[] =
    sess.commands.length > 0 ? sess.commands : ((clientRef.current?.initResult?._meta as any)?.availableCommands ?? []);

  const setTheme = (t: "dark" | "light") => update((d) => ({ ...d, settings: { ...d.settings, theme: t } }));
  const openSettings = (section?: "connection" | "devices") => { setSettingsSection(section); setView("settings"); };

  // ---- Command palette + keyboard shortcuts ----
  const paletteCommands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: "new", title: "New chat", hint: "Ctrl N", icon: "plus", run: () => active && newChat(active.project.id) },
      { id: "settings", title: "Open settings", hint: "Ctrl ,", icon: "settings", run: () => openSettings() },
      { id: "usage", title: "Open usage & costs", hint: "Ctrl Shift U", icon: "chart", run: () => setView("usage") },
      { id: "theme", title: `Switch to ${theme === "light" ? "dark" : "light"} theme`, icon: theme === "light" ? "moon" : "sun", run: () => setTheme(theme === "light" ? "dark" : "light") },
      { id: "sidebar", title: "Toggle sidebar", hint: "Ctrl B", icon: "panelLeft", run: () => setSideCollapsed((x) => !x) },
      { id: "panel", title: "Toggle browser & tools panel", hint: "Ctrl \\", icon: "panelRight", run: () => setPanel((x) => !x) },
      { id: "focus", title: "Focus message box", hint: "Ctrl L", icon: "chat", run: () => composerRef.current?.focus() },
      { id: "reconnect", title: "Reconnect to agent", icon: "refresh", run: () => void connect() },
      { id: "pair", title: "Pair a phone", icon: "phone", run: () => openSettings("devices") },
    ];
    if (isBusy) cmds.unshift({ id: "stop", title: "Stop the running turn", hint: "Ctrl .", icon: "stop", run: stop });
    if (activeChat?.sessionId && devicesOnline > 0)
      cmds.push({ id: "handoff", title: "Continue this chat on phone", icon: "phone", run: () => setNotice(`Sent to ${hub.handoff(activeChat.sessionId!)} device(s)`) });
    for (const g of data.groups)
      for (const p of g.projects) {
        cmds.push({ id: `np-${p.id}`, title: `New chat in ${p.name}`, group: g.name, icon: "plus", run: () => newChat(p.id) });
        for (const c of p.chats) cmds.push({ id: `c-${c.id}`, title: c.title, group: `${g.name} / ${p.name}`, icon: "chat", run: () => void selectChat(p.id, c.id) });
      }
    return cmds;
  }, [data, theme, isBusy, activeChat, devicesOnline, active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (mod(e) && k === "k") { e.preventDefault(); setPalette((x) => !x); }
      else if (mod(e) && k === "n" && !e.shiftKey) { e.preventDefault(); if (active) newChat(active.project.id); }
      else if (mod(e) && k === ",") { e.preventDefault(); openSettings(); }
      else if (mod(e) && e.shiftKey && k === "u") { e.preventDefault(); setView("usage"); }
      else if (mod(e) && k === "b") { e.preventDefault(); setSideCollapsed((x) => !x); }
      else if (mod(e) && k === "\\") { e.preventDefault(); setPanel((x) => !x); }
      else if (mod(e) && k === "l") { e.preventDefault(); setView("chat"); composerRef.current?.focus(); }
      else if (mod(e) && k === ".") { e.preventDefault(); stop(); }
      else if (k === "escape" && !palette && !perm && view !== "chat") setView("chat");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const renderItem = useCallback(
    (m: ChatItem) =>
      m.kind === "tool" ? (
        sess.toolCalls[m.toolCallId] ? <ToolCard tc={sess.toolCalls[m.toolCallId]} /> : null
      ) : m.kind === "agent" ? (
        <div className="bubble agent"><Markdown text={m.text} /></div>
      ) : (
        <div className={`bubble ${m.kind}`}>{(m as any).from && <span className="from"><Icon name="phone" size={11} /> {(m as any).from}</span>}{m.text}</div>
      ),
    [sess.toolCalls],
  );

  return (
    <div className={`app ${panel && view === "chat" ? "with-panel" : ""} view-${view}`}>
      <Sidebar
        data={data}
        collapsed={sideCollapsed}
        onToggle={() => setSideCollapsed((x) => !x)}
        onSelectChat={(p, c) => void selectChat(p, c)}
        onSelectProject={(pid) => { update((d) => ({ ...d, activeProjectId: pid, activeChatId: undefined })); setView("chat"); }}
        onNewChat={(p) => void newChat(p)}
        onTree={(a) => update((d) => applyTree(d, a))}
        onSettings={() => openSettings()}
        onUsage={() => setView("usage")}
        onPalette={() => setPalette(true)}
      />
      {view === "settings" && (
        <SettingsScreen
          key={settingsSection ?? "s"}
          initial={settingsSection}
          value={{ ...data.settings, secret: secretRef.current || data.settings.secret }}
          configOptions={configOptions}
          desktop={isDesktop()}
          onProviderKey={(id, key) => providerSetKey(id, key)}
          onActivate={activateProvider}
          extensions={clientRef.current ? [...clientRef.current.extensions.methods, ...clientRef.current.extensions.features, ...clientRef.current.extensions.notifications] : []}
          onClose={() => setView("chat")}
          devices={<DevicesSection desktop={isDesktop()} prefs={gwPrefs} onPrefs={(g) => update((d) => ({ ...d, settings: { ...d.settings, gateway: g } }))} />}
          onConfig={(id, v) => activeChat?.sessionId && void clientRef.current
              ?.setConfigOption(activeChat.sessionId, id, v)
              .then((r: any) => Array.isArray(r?.configOptions) && setConfigOptions(r.configOptions))
              .catch((e: any) => setNotice(`Could not set ${id}: ${e?.message ?? e}`))}
          onSave={async (settings) => {
            const stored = (await keychainSet(settings.secret)) ? { ...settings, secret: "", secretInKeychain: true } : { ...settings, secretInKeychain: false };
            update((d) => ({ ...d, settings: { ...stored, gateway: d.settings.gateway } }));
            setView("chat");
            void connect();
          }}
        />
      )}
      {view === "usage" && (
        <UsageScreen records={usage} pricing={pricing} onPricing={(p) => { setPricing(p); savePricing(p); }} onClear={() => setUsage([])} onClose={() => setView("chat")} />
      )}
      {view === "chat" && (
        <main className="main">
          <header className="topbar">
            <div className="crumbs">
              <span className="crumb-dim">{active ? active.group.name : "Supercharge Studio"}</span>
              {active && <Icon name="chevronRight" size={14} />}
              <strong>{active ? active.project.name : ""}</strong>
              {activeChat && <span className="crumb-dim chat-crumb">{activeChat.title}</span>}
            </div>
            <div className="spacer" />
            {devicesOnline > 0 && <span className="pill" title="Paired devices online"><Icon name="phone" size={12} /> {devicesOnline}</span>}
            <span className={`status ${conn === "open" ? "ok" : "bad"}`} title={status}><i className="dot" />{conn}</span>
            {conn !== "open" && <button className="secondary" onClick={() => void connect()}><Icon name="refresh" /> Connect</button>}
            <button className="icon" title="Command palette (Ctrl K)" onClick={() => setPalette(true)}><Icon name="search" size={17} /></button>
            <button className="icon" title={panel ? "Hide browser & tools (Ctrl \\)" : "Show browser & tools (Ctrl \\)"} onClick={() => setPanel((x) => !x)}><Icon name="panelRight" size={18} /></button>
          </header>
          {(notice || (conn !== "open" && status)) && (
            <div className="notice" data-testid="notice">
              <span>{notice || status}</span>
              {notice && <button className="icon sm" title="Dismiss" onClick={() => setNotice("")}><Icon name="x" size={14} /></button>}
            </div>
          )}
          <VirtualList
            key={activeChat?.id ?? "none"}
            className="messages"
            items={sess.items}
            keyOf={(_, i) => i}
            render={renderItem}
            header={
              <>
                {sess.items.length === 0 && !isBusy && (
                  <div className="empty">
                    <div className="empty-icon"><Icon name="bolt" size={28} /></div>
                    <h2>{active ? `Start a chat in ${active.project.name}` : "Welcome to Supercharge Studio"}</h2>
                    <p>{active ? <>The agent works in <code>{active.project.cwd}</code>. Type a message below, or use <code>/</code> for commands.</> : "Pick or add a project in the sidebar to begin."}</p>
                    <p className="muted keys"><kbd>Ctrl K</kbd> commands · <kbd>Ctrl N</kbd> new chat · <kbd>Ctrl ,</kbd> settings</p>
                    {conn !== "open" && <p className="muted">Agent status: {status || conn}</p>}
                  </div>
                )}
                {sess.plan.length > 0 && (
                  <div className="plan">
                    <div className="plan-title">Plan</div>
                    {sess.plan.map((e, i) => <div key={i} className={`plan-item plan-${e.status}`}><span className="box">{e.status === "completed" && <Icon name="check" size={12} />}</span>{e.content}</div>)}
                  </div>
                )}
              </>
            }
            footer={isBusy && <div className="typing" aria-label="Agent is working"><i /><i /><i /></div>}
          />
          <div className="composer-wrap">
            {draft.startsWith("/") && commands.length > 0 && (
              <div className="slash">
                {commands.filter((c) => c.name.startsWith(draft.slice(1).split(" ")[0])).map((c) => (
                  <button key={c.name} className="chip" title={c.description} onClick={() => setDraft(`/${c.name} `)}><b>/{c.name}</b> <span>{c.description}</span></button>
                ))}
              </div>
            )}
            <div className="composer">
              <textarea
                ref={composerRef}
                value={draft}
                rows={1}
                placeholder={conn === "open" ? (active ? `Message Supercharge…` : "Select a project") : "Agent not connected"}
                onChange={(e) => {
                  setDraft(e.target.value);
                  const t = e.target;
                  t.style.height = "auto";
                  t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!isBusy) void send();
                  }
                }}
                disabled={conn !== "open" || !active}
              />
              {isBusy ? (
                <button className="danger round" aria-label="Stop" title="Stop (Ctrl .)" onClick={stop}><Icon name="stop" /><span className="sr">Stop</span></button>
              ) : (
                <button className="round" aria-label="Send" title="Send (Enter)" onClick={() => void send()} disabled={conn !== "open" || !active || !draft.trim()}><Icon name="send" /><span className="sr">Send</span></button>
              )}
            </div>
            <div className="hint">{active ? <>cwd <code>{active.project.cwd}</code> · Enter to send, Shift+Enter for a new line · Ctrl K for commands</> : " "}</div>
          </div>
        </main>
      )}
      {view === "chat" && panel && <BrowserPanel tools={tools} onClose={() => setPanel(false)} />}
      {palette && <CommandPalette commands={paletteCommands} onClose={() => setPalette(false)} />}
      {pairReq && (
        <div className="modal-bg">
          <div className="modal" role="dialog" aria-label="Pair device" data-testid="pair-request">
            <h3>Pair “{pairReq.name}”?</h3>
            <p>This device will be able to see your projects and chats, send prompts and answer permission requests.</p>
            <div className="row end">
              <button className="secondary" onClick={() => { void gateway.pairAnswer(pairReq.pairingId, false); setPairReq(null); }}>Reject</button>
              <button data-testid="pair-allow" onClick={() => { void gateway.pairAnswer(pairReq.pairingId, true); setPairReq(null); }}>Allow</button>
            </div>
          </div>
        </div>
      )}
      {perm && <PermissionModal req={perm.req} onAnswer={(o) => perm.resolve(o)} />}
    </div>
  );
}
