import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { combineSteer, makeSteerer, type Queued } from "./acp/steer";
import { AcpClient, ConnectionState, isAuthError, isModelError, pickConfiguredModel } from "./acp/client";
import { applyUpdate, ChatItem, emptySession, SessionState } from "./acp/session";
import type { ConfigOption, PermissionOutcome, PermissionRequest, SessionModes, SessionUpdate } from "./acp/types";
import { ModeControl } from "./components/ModeControl";
import { StdioTransport } from "./acp/tauriStdio";
import { browser, browserClientMeta } from "./browser/bridge";
import { BrowserPanel } from "./components/BrowserPanel";
const CliSetup = lazy(() => import("./components/CliSetup"));
import { Command, CommandPalette } from "./components/CommandPalette";
import { ComposerMenu } from "./components/ComposerMenu";
import { ModelControls } from "./components/ModelControls";
import { optionFor, updateSessionOptions } from "./lib/sessionOptions";
import { providerCatalogKey } from "./lib/catalog";
import { filterItems, insertMention, MenuItem, menuState, parseSlash } from "./lib/composer";
import { resolveTheme, themeList } from "./lib/themes";
import { extractMentions, fileItems, mentionBlocks } from "./lib/mentions";
import { defaultGatewayPrefs, DevicesSection, gatewayBind, urlPort } from "./components/Devices";
const SettingsScreen = lazy(() => import("./components/Settings").then((m) => ({ default: m.SettingsScreen })));
// Warm the lazy screens once the app is idle so the first open is instant.
const idle = (globalThis as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1200));
if (typeof window !== "undefined") idle(() => { void import("./components/Settings"); void import("./components/Usage"); });
const UsageScreen = lazy(() => import("./components/Usage").then((m) => ({ default: m.UsageScreen })));
import { transition } from "./lib/motion";
import { Onboarding } from "./components/Onboarding";
import { Icon } from "./components/Icon";
import { Markdown } from "./components/Markdown";
import { PermissionModal } from "./components/Permission";
import { Sidebar } from "./components/Sidebar";
import { ToolCard } from "./components/ToolCard";
import { VirtualList } from "./components/VirtualList";
import { GatewayHub } from "./gateway/hub";
import { effectiveRelay, ensureHostId } from "./lib/reach";
import { type Attachment, fmtSize, fromFile, isImage, rejectReason, toBlocks } from "./lib/attachments";
import { FileEntry, projectFiles, projectReadText } from "./lib/desktop";
import { agentCheck, agentFreePort, agentInfo, agentInstall, cliStatus, type CliStatus, agentLogNote, agentRestart, appConfig, background, ensureAgent, gateway, invoke, isDesktop, keychainGet, keychainSet, listen, mcpUrl, providerApply, providerSeedFromEnv, providerSetKey } from "./lib/desktop";
import { AppData, applyTree, ensureFolderProject, findProject, load, mergeCliSessions, normCwd, mapProject, Provider, parseAgentUrl, save, uid, wsUrl } from "./lib/store";
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
  const [view, setViewNow] = useState<View>("chat");
  const viewRef = useRef<View>("chat");
  const setView = useCallback((v: View) => {
    if (viewRef.current === v) return;
    viewRef.current = v;
    transition(() => setViewNow(v));
  }, []);
  const retryRef = useRef<((t: string) => void) | null>(null);
  const [loadingChats, setLoadingChats] = useState<Set<string>>(() => new Set());
  const [settingsSection, setSettingsSection] = useState<"connection" | "devices" | "providers" | "agent" | "appearance" | undefined>();
  const [palette, setPalette] = useState(false);
  const [permQueue, setPermQueue] = useState<PermState[]>([]);
  const perm = permQueue[0] ?? null;
  const [pairReq, setPairReq] = useState<{ pairingId: string; name: string } | null>(null);
  const [devicesOnline, setDevicesOnline] = useState(0);
  const [optionsBySession, setOptionsBySession] = useState<Record<string, ConfigOption[]>>({});
  const [modesBySession, setModesBySession] = useState<Record<string, SessionModes>>({});
  const modesRef = useRef<Record<string, SessionModes>>({});
  const rememberModes = (sid: string, modes?: SessionModes) => {
    if (!modes?.availableModes?.length) return;
    modesRef.current = { ...modesRef.current, [sid]: modes };
    setModesBySession(modesRef.current);
  };
  const optionsRef = useRef<Record<string, ConfigOption[]>>({});
  const rememberOptions = (sid: string, options: ConfigOption[]) => {
    optionsRef.current = updateSessionOptions(optionsRef.current, sid, options);
    setOptionsBySession(optionsRef.current);
  };
  const [usage, setUsage] = useState<UsageRecord[]>(loadUsage);
  const [pricing, setPricing] = useState(loadPricing);
  const clientRef = useRef<AcpClient | null>(null);
  const secretRef = useRef("");
  const [agentMissing, setAgentMissing] = useState(false);
  // First-run CLI setup: missing or too old -> full-screen installer; newer release -> offer an update.
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [cliSetup, setCliSetup] = useState<"missing" | "outdated" | "update" | null>(null);
  useEffect(() => {
    if (!isDesktop()) return;
    void cliStatus(true).then((st) => {
      setCli(st);
      if (!st.bin) setCliSetup("missing");
      else if (st.too_old) setCliSetup("outdated");
      else if (st.update_available) setNotice(`Supercharge CLI ${st.latest} is available (you have ${st.version}).`);
    }).catch(() => {});
  }, []);
  const [agentRejected, setAgentRejected] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyErr, setKeyErr] = useState("");
  const [installing, setInstalling] = useState("");
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
  const failedLoads = useRef(new Set<string>());
  /** Synchronous data update: keeps dataRef current for async flows. */
  const update = useCallback((fn: (d: AppData) => AppData) => {
    dataRef.current = fn(dataRef.current);
    save(dataRef.current); // persist now: effects may run after an immediate reload/quit
    setData(dataRef.current);
  }, []);

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
        prompt: (sid, text, from, extra) => {
          const f = chatForSession(sid);
          if (!f) return Promise.reject(new Error("Unknown session"));
          return runPrompt(f.project.id, f.chat.id, text, from, extra ?? []);
        },
        upload: isDesktop() ? (params) => invoke("upload_chunk", { params }) : undefined,
        resolveUploads: isDesktop() ? (blocks) => invoke<unknown[]>("upload_rewrite", { prompt: blocks, images: agentImages() }) : undefined,
        cancel: (sid) => void clientRef.current?.cancel(sid),
        configOptions: (sid) => optionsRef.current[sid] ?? [],
        modes: (sid) => modesRef.current[sid],
        setMode: async (sid, mode) => {
          const c = clientRef.current;
          if (!c) throw new Error("Agent not connected");
          await c.setMode(sid, mode);
          modesRef.current = { ...modesRef.current, [sid]: { ...modesRef.current[sid], currentModeId: mode } };
          setModesBySession(modesRef.current);
          const update: SessionUpdate = { sessionUpdate: "current_mode_update", currentModeId: mode };
          const found = chatForSession(sid);
          if (found) enqueue(found.chat.id, update);
          hubRef.current?.update(sid, update);
        },
        setConfigOption: async (sid, id, value) => {
          const c = clientRef.current;
          if (!c) throw new Error("Agent not connected");
          const result = await c.setConfigOption(sid, id, value);
          if (Array.isArray(result?.configOptions)) rememberOptions(sid, result.configOptions);
          return optionsRef.current[sid] ?? [];
        },
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
          if (!f || !c || ((sessionsRef.current[f.chat.id] || loaded.current.has(sid)) && optionsRef.current[sid])) return;
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
    const freshKey = async () => {
      const k = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
      const inKc = await keychainSet(k);
      update((d) => ({ ...d, settings: { ...d.settings, secret: inKc ? "" : k, secretInKeychain: inKc } }));
      return k;
    };
    let s = { ...base, ...(o.bind ? { bind: o.bind } : {}), ...(o.secret ? { secret: o.secret } : {}) };
    setAgentRejected("");
    try {
      if (isDesktop() && s.autoStart && s.transport === "ws") {
        setStatus("Checking for a running agent…");
        const useOwn = !o.bind && base.agentChoice === "own" && base.ownBind;
        if (useOwn) s = { ...s, bind: base.ownBind! };
        let chk = await agentCheck(s.bind, s.secret);
        void agentLogNote(`connect: ${s.bind} -> ${chk}${useOwn ? " (own agent)" : ""}`);
        if (chk === "unreachable") {
          // Nothing there: start our own with a per-install key (replace the shipped default).
          if (!o.secret && (!s.secret || s.secret === "dev-secret")) s = { ...s, secret: await freshKey() };
          setStatus("Starting agent…");
          const r = await ensureAgent(s.bind, s.secret, s.alwaysApprove);
          setStatus(r === "started" ? "Agent started" : "Attached to running agent");
        } else if (chk === "rejected") {
          // Something is listening but rejects our key (e.g. an agent started without --secret).
          const foreign = s.bind;
          if (o.secret || base.agentChoice === "key") {
            setAgentRejected(foreign);
            setConn("closed");
            setStatus(`An agent is running on ${foreign} but rejected the key`);
            return;
          }
          const own = await agentFreePort();
          if (!s.secret || s.secret === "dev-secret" || base.agentChoice !== "own") s = { ...s, secret: await freshKey() };
          s = { ...s, bind: own };
          setStatus(`Agent on ${foreign} rejected our key — starting our own on ${own}…`);
          void agentLogNote(`agent on ${foreign} rejected the key; starting own agent on ${own}`);
          await ensureAgent(own, s.secret, s.alwaysApprove);
          update((d) => ({ ...d, settings: { ...d.settings, agentChoice: "own", ownBind: own } }));
          setNotice(`The agent already running on ${foreign} rejected the key, so Supercharge Studio started its own on ${own}. To use yours instead, enter its key in Settings → Connection.`);
        } else {
          setStatus("Attached to running agent");
        }
        setAgentMissing(false);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      void agentLogNote(`connect failed: ${msg}`);
      if (msg.includes("AGENT_NOT_FOUND")) {
        setAgentMissing(true);
        setCliSetup("missing");
        void cliStatus(true).then(setCli).catch(() => {});
        setConn("closed");
        setStatus("Supercharge CLI not found");
        return; // nothing to connect to: show the setup card instead of a retry loop
      }
      setStatus(msg);
    }
    secretRef.current = s.secret;
    attached.current.clear();
    optionsRef.current = {};
    setOptionsBySession({});
    modesRef.current = {};
    setModesBySession({});
    const client = new AcpClient({
      ...(s.transport === "stdio" ? { transportFactory: () => new StdioTransport(s.alwaysApprove) } : { url: wsUrl(s) }),
      clientMeta: browserClientMeta(),
      onStateChange: (st, info) => {
        setConn(st);
        if (st === "reconnecting") setStatus(`Reconnecting (attempt ${info?.attempt}, ${info?.delayMs}ms)…`);
      },
      onUpdate: (sid, u) => {
        if (replaying.current.has(sid)) return; // history re-sent while reattaching tools
        hub.update(sid, u);
        const f = chatForSession(sid);
        if (!f) return;
        const cid = f.chat.id;
        enqueue(cid, u);
        if (u.sessionUpdate === "plan" && Array.isArray(u.entries) && u.entries.length && dataRef.current.activeChatId === cid) setPanel(true);
        const x = u as any;
        if (u.sessionUpdate === "config_option_update" && Array.isArray(x.configOptions)) rememberOptions(sid, x.configOptions);
        if (u.sessionUpdate === "current_mode_update" && modesRef.current[sid]) {
          modesRef.current = { ...modesRef.current, [sid]: { ...modesRef.current[sid], currentModeId: x.currentModeId } };
          setModesBySession(modesRef.current);
        }
        if (u.sessionUpdate === "session_info_update" && typeof x.title === "string" && x.title)
          update((d) => ({ ...d, groups: d.groups.map((g) => ({ ...g, projects: g.projects.map((p) => ({ ...p, chats: p.chats.map((c) => (c.id === cid ? { ...c, title: String(x.title).slice(0, 60) } : c)) })) })) }));
        if (x.usage) {
          const n = usageFromNotification("session/update", { sessionId: sid, update: u });
          if (n) recordUsage(sid, n.usage, `${sid}:${x._meta?.eventId ?? x.prompt_id ?? Date.now()}`);
        }
      },
      onNotification: (method, params: any) => {
        if (method === "_supercharge/sessions/changed") { scheduleSync(); return; }
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
            setPermQueue((pending) => pending.filter((p) => p.req !== req));
            resolve(o);
          };
          const fan = hub.deviceCount > 0 ? hub.requestPermission(req.sessionId, req) : null;
          fan?.answer.then((o) => finish(o, "device"));
          setPermQueue((pending) => [...pending, { req, resolve: (o) => finish(o, "desktop", fan?.token), token: fan?.token }]);
        }),
      onReconnected: () => {
        setStatus("Reconnected");
        // A restarted agent forgot every MCP attachment: re-register the browser tools now.
        attached.current.clear();
        optionsRef.current = {};
        setOptionsBySession({});
        const d = dataRef.current;
        const f = findProject(d, d.activeProjectId);
        const ch = f?.project.chats.find((x) => x.id === d.activeChatId);
        if (f && ch?.sessionId && clientRef.current) void ensureAttached(clientRef.current, ch.sessionId, ch.cwd ?? normCwd(f.project.cwd), ch.id).catch(() => {});
        scheduleSync();
      },
    });
    browser.attach(client);
    clientRef.current = client;
    try {
      await client.connect();
      const init = await client.initialize();
      setStatus(`Connected${init.agentInfo?.version ? ` · agent ${init.agentInfo.version}` : ""}`);
      // Restore the open chat's history after (re)connecting.
      const d = dataRef.current;
      const f = findProject(d, d.activeProjectId);
      const ch = f?.project.chats.find((x) => x.id === d.activeChatId);
      if (f && ch?.sessionId) void selectChat(f.project.id, ch.id, false);
      void syncCli();
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    }
  }, []);

  // Theme
  const theme = data.settings.theme ?? "dark";
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    const apply = () => {
      const root = document.documentElement;
      const next = resolveTheme(theme, !!mq?.matches);
      if (root.dataset.theme && root.dataset.theme !== next) {
        // Ease colours for one switch only (no permanent transitions on every element).
        root.classList.add("theme-anim");
        clearTimeout((apply as any).t);
        (apply as any).t = setTimeout(() => root.classList.remove("theme-anim"), 360);
      }
      root.dataset.theme = next;
    };
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
      listen<string>("agent://status", (st) => {
        if (st === "starting") setStatus("Starting agent…");
        else if (st === "restarting") setStatus("Agent stopped unexpectedly — restarting…");
        else if (st === "crashed") setStatus("The agent keeps crashing. Open Settings → Connection → Agent log for details.");
        else if (st === "ready") setStatus("Agent running");
      }),
      listen<{ deviceId: string; msg: any }>("gateway://message", ({ deviceId, msg }) => void hub.receive(deviceId, msg)),
      listen<{ deviceId: string; name: string }>("gateway://connected", ({ deviceId, name }) => { deviceNames.current.set(deviceId, name); hub.connected(deviceId); setDevicesOnline(hub.deviceCount); }),
      listen<{ deviceId: string }>("gateway://disconnected", ({ deviceId }) => { hub.disconnected(deviceId); setDevicesOnline(hub.deviceCount); }),
      listen<{ pairingId: string; name: string }>("gateway://pair-request", (r) => setPairReq(r)),
    ];
    const gw = dataRef.current.settings.gateway;
    if (gw?.enabled)
      void gateway.start(gatewayBind(gw))
        .then((url) => {
          const port = urlPort(url);
          if (port && port !== gw.port) {
            update((d) => ({ ...d, settings: { ...d.settings, gateway: { ...(d.settings.gateway ?? gw), port } } }));
            setNotice(`Mobile gateway: port ${gw.port} is in use, using ${port}. Paired phones find it automatically.`);
          }
        })
        .then(() => {
          const g = ensureHostId(dataRef.current.settings.gateway ?? gw);
          if (g.hostId !== (dataRef.current.settings.gateway ?? gw).hostId) update((d) => ({ ...d, settings: { ...d.settings, gateway: { ...(d.settings.gateway ?? gw), hostId: g.hostId } } }));
          const r = effectiveRelay(g);
          return r ? gateway.relaySet(r, g.hostId) : undefined;
        })
        .catch((e) => setNotice(`Mobile gateway: ${e}`));
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, []);

  function agentImages() {
    return (clientRef.current?.initResult?.agentCapabilities as any)?.promptCapabilities?.image !== false;
  }

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
    // Browser tools work with zero setup: if the agent needs the browser, show the panel.
    browser.onNeedPanel = () => { setView("chat"); setPanel(true); };
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
  const configOptions = activeChat?.sessionId ? optionsBySession[activeChat.sessionId] ?? [] : [];
  const sess = (activeChat && sessions[activeChat.id]) || emptySession();

  /** The in-app browser's MCP server, attached to every session/new and session/load. */
  async function browserMcp(c: AcpClient): Promise<unknown[]> {
    if (mcpRef.current === undefined) mcpRef.current = await mcpUrl();
    const httpMcp = !!(c.initResult?.agentCapabilities?.mcpCapabilities as any)?.http;
    return mcpRef.current && httpMcp ? [{ type: "http", name: "supercharge-studio-browser", url: mcpRef.current, headers: [] }] : [];
  }

  /** On model_not_configured, switch the session to a configured model and tell the user. */
  async function recoverModel(c: AcpClient, sid: string, chatId: string, e: unknown): Promise<boolean> {
    const prov = dataRef.current.settings.providers?.find((p) => p.id === dataRef.current.settings.activeProviderId);
    const r = pickConfiguredModel(e, [...((c.initResult?._meta as any)?.modelState?.currentModelId ? [(c.initResult?._meta as any).modelState.currentModelId] : []), ...(prov?.models.map((id) => providerCatalogKey(prov.id, id)) ?? [])]);
    if (!r) return false;
    await c.request("session/set_model", { sessionId: sid, modelId: r.pick }).catch(() => c.setConfigOption(sid, modelOption?.id ?? "model", r.pick).catch(() => {}));
    pushItem(chatId, { kind: "system", text: `This chat was last used with ${r.requested ? `"${r.requested}"` : "a model"}, which isn't configured now. Switched it to "${r.pick}".` });
    return true;
  }

  // ---- CLI session sync: every CLI session, grouped by folder ----
  const syncing = useRef(false);
  /** Sessions whose browser MCP server is attached on the current agent connection. */
  const attached = useRef(new Set<string>());
  /**
   * Make sure the agent has the browser tools for this session on this connection. After an
   * agent restart (or for a session created elsewhere) resume/load it with the MCP server again,
   * so the user never has to reconnect the browser tools.
   */
  async function ensureAttached(c: AcpClient, sid: string, cwd: string, chatId: string) {
    if (attached.current.has(sid)) return;
    const mcp = await browserMcp(c);
    let result;
    if (c.sessionCapability("resume")) {
      result = await c.resumeSession(sid, cwd, mcp);
    } else if (c.initResult?.agentCapabilities?.loadSession) {
      // No resume: load re-sends history; drop the replay into a scratch state.
      replaying.current.add(sid);
      try { result = await c.loadSession(sid, cwd, mcp); } finally { replaying.current.delete(sid); }
    } else return;
    if (Array.isArray(result?.configOptions)) rememberOptions(sid, result.configOptions);
    rememberModes(sid, result?.modes);
    attached.current.add(sid);
    void chatId;
  }
  const replaying = useRef(new Set<string>());
  const [syncBusy, setSyncBusy] = useState(false);
  async function syncCli() {
    const c = clientRef.current;
    if (!c || syncing.current || !c.sessionCapability("list")) return;
    syncing.current = true; setSyncBusy(true);
    try {
      const all: any[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 50; i++) {
        const r: any = await c.listSessions(cursor ? { cursor } : {});
        all.push(...(r?.sessions ?? []));
        cursor = r?.nextCursor ?? undefined;
        if (!cursor) break;
      }
      update((d) => mergeCliSessions(d, all));
    } catch { /* agent busy or restarting: next tick retries */ }
    finally { syncing.current = false; setSyncBusy(false); }
  }
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function scheduleSync() { clearTimeout(syncTimer.current); syncTimer.current = setTimeout(() => void syncCli(), 300); }
  useEffect(() => {
    const onFocus = () => scheduleSync();
    window.addEventListener("focus", onFocus);
    const t = setInterval(() => document.visibilityState !== "hidden" && void syncCli(), 30000);
    return () => { window.removeEventListener("focus", onFocus); clearInterval(t); };
  }, []);

  function openFolder(cwd: string) {
    let pid = "";
    update((d) => { const r = ensureFolderProject(d, cwd); pid = r.projectId; return r.data; });
    if (pid) newChat(pid);
  }

  const creatingSession = useRef(new Map<string, Promise<string | null>>());
  async function ensureSession(projectId: string, chatId: string): Promise<string | null> {
    const c = clientRef.current;
    const found = findProject(dataRef.current, projectId);
    const chat = found?.project.chats.find((x) => x.id === chatId);
    if (!c || !found || !chat) return null;
    if (chat.sessionId) return chat.sessionId;
    const pending = creatingSession.current.get(chatId);
    if (pending) return pending;
    const create = (async () => {
      const mcpServers = await browserMcp(c);
      const res = await c.newSession(normCwd(found.project.cwd), { yoloMode: dataRef.current.settings.alwaysApprove }, mcpServers);
      rememberOptions(res.sessionId, res.configOptions ?? []);
      rememberModes(res.sessionId, res.modes);
      loaded.current.add(res.sessionId);
      attached.current.add(res.sessionId);
      update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, sessionId: res.sessionId } : x)) })));
      hub.sessionsChanged();
      return res.sessionId;
    })();
    creatingSession.current.set(chatId, create);
    try { return await create; } finally { creatingSession.current.delete(chatId); }
  }

  function newChat(projectId: string, focus = true) {
    const chat = { id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now() };
    update((d) => ({ ...mapProject(d, projectId, (p) => ({ ...p, chats: [chat, ...p.chats] })), ...(focus ? { activeProjectId: projectId, activeChatId: chat.id } : {}) }));
    if (focus) {
      setView("chat");
      setTimeout(() => composerRef.current?.focus(), 0);
      if (clientRef.current) void ensureSession(projectId, chat.id).catch((e: any) => setNotice(`Could not create chat: ${e?.message ?? e}`));
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
    if (c && chat?.sessionId && (!sessionsRef.current[chatId] || failedLoads.current.has(chat.sessionId)) && !loaded.current.has(chat.sessionId) && c.initResult?.agentCapabilities?.loadSession) {
      loaded.current.add(chat.sessionId);
      hub.seed(chat.sessionId, []);
      setSessions((all) => ({ ...all, [chatId]: emptySession() }));
      setLoadingChats((l) => new Set(l).add(chatId));
      // The session's own folder (as the CLI recorded it), else the project's.
      const cwd = chat.cwd ?? normCwd(findProject(dataRef.current, projectId)!.project.cwd);
      const mcp = await browserMcp(c);
      const sid = chat.sessionId;
      await c.loadSession(sid, cwd, mcp)
        .catch(async (e: any) => { if (await recoverModel(c, sid, chatId, e)) return c.loadSession(sid, cwd, mcp); throw e; })
        .then((r: any) => { failedLoads.current.delete(sid); attached.current.add(sid); if (Array.isArray(r?.configOptions)) rememberOptions(sid, r.configOptions); rememberModes(sid, r?.modes); })
        .catch((e: any) => { loaded.current.delete(sid); failedLoads.current.add(sid); pushItem(chatId, { kind: "system", text: `Could not load this chat's history: ${e?.message ?? e}`, error: "load" } as any); });
      flush();
      setLoadingChats((l) => { const n = new Set(l); n.delete(chatId); return n; });
    } else if (c && chat?.sessionId && !optionsRef.current[chat.sessionId]) {
      await ensureAttached(c, chat.sessionId, chat.cwd ?? normCwd(findProject(dataRef.current, projectId)!.project.cwd), chatId).catch(() => {});
    }
  }

  /** Run one prompt in a chat (from the desktop composer or a paired device). */
  async function runPrompt(projectId: string, chatId: string, text: string, from?: string, extra: unknown[] = [], resend = false): Promise<{ stopReason: string; usage?: unknown }> {
    const c = clientRef.current;
    if (!c) throw new Error("Agent not connected");
    const chat = findProject(dataRef.current, projectId)?.project.chats.find((x) => x.id === chatId);
    if (chat?.title === "New chat")
      update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, title: text.slice(0, 40) } : x)) })));
    update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, updatedAt: Date.now() } : x)) })));
    turnText.current[chatId] = text;
    const attNames = (extra as any[]).filter((b) => b && b._att).map((b) => b._att as string);
    for (const b of extra as any[]) if (b && b._att) delete b._att;
    if (!resend) pushItem(chatId, { kind: "user", text: from ? `${text}` : text, ...(from ? { from } : {}), ...(attNames.length ? { attachments: attNames } : {}) } as ChatItem);
    setBusy((b) => ({ ...b, [chatId]: true }));
    try {
      let sid = await ensureSession(projectId, chatId);
      if (!sid) throw new Error("No session");
      hub.update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { supercharge: { from: from ?? "desktop" } } });
      const sentFiles = (extra as any[]).filter((b) => ["image", "resource", "resource_link"].includes(b?.type)).map((b) => b.name ?? decodeURIComponent(String(b.resource?.uri ?? b.uri ?? "").split("/").pop() || "") ?? b.type);
      if (from && sentFiles.length) hub.update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text: `${text ? "\n" : ""}📎 ${sentFiles.map((n) => n || "image").join(", ")}` } });
      if (from && sentFiles.length) pushItem(chatId, { kind: "system", text: `📎 ${from} attached ${sentFiles.map((n) => n || "image").join(", ")}` });
      let r;
      turnUsage.current.delete(sid);
      const cwdNow = chat?.cwd ?? normCwd(findProject(dataRef.current, projectId)!.project.cwd);
      await ensureAttached(c, sid, cwdNow, chatId).catch(() => {});
      try {
        r = await c.prompt(sid, text, extra).catch(async (e: any) => { if (await recoverModel(c, sid!, chatId, e)) return c.prompt(sid!, text, extra); throw e; });
      } catch (e: any) {
        // Session unknown to this agent (e.g. agent restarted): start a fresh one and retry once.
        if (!/session.*not found|unknown session|no such session/i.test(String(e?.message))) throw e;
        update((d) => mapProject(d, projectId, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === chatId ? { ...x, sessionId: undefined } : x)) })));
        sid = await ensureSession(projectId, chatId);
        if (!sid) throw e;
        r = await c.prompt(sid, text, extra);
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
      pushItem(chatId, { kind: "system", text: t, error: isAuthError(e) || isModelError(e) ? "config" : "prompt", retry: text } as any);
      throw e;
    } finally {
      setBusy((b) => ({ ...b, [chatId]: false }));
    }
  }

  retryRef.current = (text: string) => { if (active && activeChat) void runPrompt(active.project.id, activeChat.id, text).catch(() => {}); };

  // ---- Sending while the agent works: pq (default) or steer ----
  const [pq, setPq] = useState<Record<string, Queued[]>>({});
  const [editingQ, setEditingQ] = useState<string | null>(null);
  const turnText = useRef<Record<string, string>>({});
  const pendingResend = useRef<Record<string, string>>({});
  const pqRef = useRef(pq);
  pqRef.current = pq;
  const enqueue_ = (chatId: string, text: string) => setPq((q) => ({ ...q, [chatId]: [...(q[chatId] ?? []), { id: uid(), text }] }));
  const dequeue = (chatId: string, id: string) => setPq((q) => ({ ...q, [chatId]: (q[chatId] ?? []).filter((x) => x.id !== id) }));
  async function steer(projectId: string, chatId: string, text: string) {
    const c = clientRef.current;
    const sid = findProject(dataRef.current, projectId)?.project.chats.find((x) => x.id === chatId)?.sessionId;
    if (!c || !sid || !busyRef.current[chatId]) return void runPrompt(projectId, chatId, text).catch(() => {});
    const s = makeSteerer(c, (x) => c.cancel(x), () => { pendingResend.current[chatId] = combineSteer(turnText.current[chatId] ?? "", text); });
    pushItem(chatId, { kind: "user", text, steer: true } as any);
    try {
      await s.steer(sid, text);
      setNotice(s.mode === "native" ? "Steering the current turn" : "Restarting the turn with your message");
    } catch (e: any) {
      setNotice(`Could not steer: ${e?.message ?? e}. Queued instead.`);
      enqueue_(chatId, text);
    }
  }
  // When a turn ends: a cancel-and-resend steer goes first, then the next queued message.
  useEffect(() => {
    for (const [chatId, b] of Object.entries(busy)) {
      if (b) continue;
      const f = dataRef.current.groups.flatMap((g) => g.projects).find((p) => p.chats.some((c) => c.id === chatId));
      if (!f) continue;
      const re = pendingResend.current[chatId];
      if (re != null) { delete pendingResend.current[chatId]; void runPrompt(f.id, chatId, re, undefined, [], true).catch(() => {}); continue; }
      const next = (pqRef.current[chatId] ?? []).find((x) => x.id !== editingQ);
      if (next) { dequeue(chatId, next.id); void runPrompt(f.id, chatId, next.text).catch(() => {}); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, editingQ]);

  async function send() {
    const text = draft.trim();
    const sl = parseSlash(text);
    if (sl && nativeByName.has(sl.name)) {
      const agentHas = commands.some((c) => c.name === sl.name);
      // Plain "/setup", "/models", … open the app's own screens; with arguments the agent's command wins.
      if (!(agentHas && sl.args && !nativeByName.get(sl.name)!.sub) && runNative(sl.name, sl.args)) { setDraftCaret(""); return; }
      if (!agentHas) { setNotice(`/${sl.name}: unknown option “${sl.args}”`); return; }
    }
    if ((!text && !atts.length) || !clientRef.current || !active) return;
    if (activeChat && busyRef.current[activeChat.id] && !atts.length) {
      setDraft("");
      if (data.settings.steerByDefault) void steer(active.project.id, activeChat.id, text);
      else enqueue_(activeChat.id, text);
      return;
    }
    const chatId = activeChat?.id ?? newChat(active.project.id);
    setDraft("");
    if (composerRef.current) composerRef.current.style.height = "auto";
    let extra: unknown[] = [];
    if (/(^|\s)@\S/.test(text) && isDesktop()) {
      const root = active.project.cwd;
      const files = await loadFiles(root);
      const embed = !!(clientRef.current.initResult?.agentCapabilities as any)?.promptCapabilities?.embeddedContext;
      extra = await mentionBlocks(root, extractMentions(text, files), embed, (rel) => projectReadText(root, rel));
    }
    if (atts.length) {
      const pc = (clientRef.current.initResult?.agentCapabilities as any)?.promptCapabilities ?? {};
      const sending = atts;
      setAtts([]);
      try {
        const blocks = await toBlocks(sending, { image: pc.image !== false, embeddedContext: true }, isDesktop() ? (params) => invoke("upload_chunk", { params }) : undefined);
        blocks.forEach((b: any, i) => (b._att = sending[i].name));
        extra = [...extra, ...blocks];
      } catch (e: any) {
        setAtts(sending);
        setAttErr(`Could not attach: ${e?.message ?? e}`);
        return;
      }
      sending.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    }
    await runPrompt(active.project.id, chatId, text, undefined, extra).catch(() => {});
  }

  const stop = () => activeChat?.sessionId && clientRef.current?.cancel(activeChat.sessionId);

  // ---- Attachments (button, drag and drop, paste) ----
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [attErr, setAttErr] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  async function addFiles(files: File[]) {
    setAttErr("");
    let n = atts.length;
    const add: Attachment[] = [];
    for (const f of files) {
      const why = rejectReason(f, n);
      if (why) { setAttErr(why); continue; }
      add.push(await fromFile(f));
      n++;
    }
    if (add.length) setAtts((a) => [...a, ...add]);
  }
  const removeAtt = (id: string) => setAtts((a) => { const x = a.find((y) => y.id === id); if (x?.preview) URL.revokeObjectURL(x.preview); return a.filter((y) => y.id !== id); });

  // Native webviews draw above the DOM: hide the side browser while an overlay or another screen is shown.
  const browserVisible = view === "chat" && panel && !perm && !palette && !pairReq;
  useEffect(() => {
    void browser.setVisible(browserVisible);
  }, [browserVisible]);

  const isBusy = !!(activeChat && busy[activeChat.id]);
  const commands: { name: string; description?: string }[] =
    sess.commands.length > 0 ? sess.commands : ((clientRef.current?.initResult?._meta as any)?.availableCommands ?? []);

  const setTheme = (t: string) => update((d) => ({ ...d, settings: { ...d.settings, theme: t } }));
  const openSettings = (section?: "connection" | "devices" | "providers" | "agent" | "appearance") => { setSettingsSection(section); setView("settings"); };

  // ---- Composer: slash commands ----
  const modelOption = optionFor(configOptions, "model");
  const permissionOption = optionFor(configOptions, "permission_mode");
  const sessionModes = activeChat?.sessionId ? modesBySession[activeChat.sessionId] : undefined;
  const changeMode = async (mode: string) => {
    const sid = activeChat?.sessionId;
    if (!sid || !sessionModes?.availableModes.some((m) => m.id === mode)) return;
    try {
      await clientRef.current?.setMode(sid, mode);
      const next = { ...sessionModes, currentModeId: mode };
      rememberModes(sid, next);
      enqueue(activeChat!.id, { sessionUpdate: "current_mode_update", currentModeId: mode });
      hub.update(sid, { sessionUpdate: "current_mode_update", currentModeId: mode });
    } catch (e: any) { setNotice(`Could not change work mode: ${e?.message ?? e}`); throw e; }
  };
  const changePermission = async (id: string, value: string) => {
    const sid = activeChat?.sessionId;
    if (!sid || id !== "permission_mode" || !permissionOption?.options?.some((v) => v.value === value)) return;
    try {
      const result = await clientRef.current?.setConfigOption(sid, id, value);
      if (Array.isArray(result?.configOptions)) rememberOptions(sid, result.configOptions);
    } catch (e: any) { setNotice(`Could not change tool permissions: ${e?.message ?? e}`); throw e; }
  };
  const changeOption = (sid: string, id: string, value: string) => {
    const option = optionsRef.current[sid]?.find((o) => o.id === id);
    if (!option?.options?.some((v) => v.value === value)) return;
    void clientRef.current?.setConfigOption(sid, id, value)
      .then((r: any) => { if (Array.isArray(r?.configOptions)) rememberOptions(sid, r.configOptions); })
      .catch((e: any) => setNotice(`Could not change ${id}: ${e?.message ?? e}`));
  };
  const setModel = (v: string) => {
    if (!modelOption || !activeChat?.sessionId) return false;
    const opt = modelOption.options?.find((o) => o.value === v || (o.name ?? "").toLowerCase() === v.toLowerCase());
    if (!opt) return false;
    changeOption(activeChat.sessionId, modelOption.id, opt.value);
    return true;
  };
  function clearChat() {
    if (!active || !activeChat) return;
    if (activeChat.sessionId) loaded.current.delete(activeChat.sessionId);
    update((d) => mapProject(d, active.project.id, (p) => ({ ...p, chats: p.chats.map((x) => (x.id === activeChat.id ? { ...x, sessionId: undefined } : x)) })));
    setSessions((all) => ({ ...all, [activeChat.id]: emptySession() }));
  }
  type Native = { name: string; detail: string; icon: string; run: (args: string) => boolean | void; sub?: () => MenuItem[] };
  const nativeCommands: Native[] = [
    { name: "new", detail: "Start a new chat in this project", icon: "plus", run: () => { if (active) newChat(active.project.id); } },
    { name: "clear", detail: "Clear this chat and start a fresh session", icon: "trash", run: () => clearChat() },
    { name: "setup", detail: "Set up model providers and API keys", icon: "plug", run: () => openSettings("providers") },
    {
      name: "models", detail: modelOption?.currentValue ? `Switch model (now ${modelOption.options?.find((o) => o.value === modelOption.currentValue)?.name ?? modelOption.currentValue})` : "Switch model", icon: "bolt",
      run: (a) => { if (a) return setModel(a); if (modelOption?.options?.length) setTimeout(() => setDraftCaret("/models ")); else openSettings("agent"); },
      sub: modelOption?.options?.length ? () => modelOption!.options!.map((o) => ({ id: `m-${o.value}`, label: o.name ?? o.value, detail: o.value === modelOption!.currentValue ? "current" : o.name && o.name !== o.value ? o.value : undefined, value: o.value, icon: o.value === modelOption!.currentValue ? "check" : undefined })) : undefined,
    },
    { name: "theme", detail: "Change the color theme", icon: theme === "light" ? "sun" : "moon", run: (a) => { if (!a) { setTimeout(() => setDraftCaret("/theme ")); return; } const t = themeList.find((x) => x.id === a.toLowerCase() || x.name.toLowerCase() === a.toLowerCase()); if (!t) return false; setTheme(t.id); }, sub: () => themeList.map((t) => ({ id: `t-${t.id}`, label: t.name, detail: t.id === theme ? "current" : t.dark ? "dark" : "light", value: t.id, icon: t.id === theme ? "check" : undefined })) },
    { name: "help", detail: "Show commands and shortcuts", icon: "command", run: () => {
      const lines = [...nativeCommands.map((c) => `- \`/${c.name}\` ${c.detail}`), ...commands.map((c) => `- \`/${c.name}\` ${c.description ?? ""} (agent)`)];
      const cid = activeChat?.id ?? (active ? newChat(active.project.id) : undefined);
      if (cid) pushItem(cid, { kind: "system", text: `**Commands**\n${lines.join("\n")}\n\nType \`@\` to attach a file or folder. Ctrl K opens the command palette.` } as ChatItem);
      else setNotice("Open a chat to see the command list");
    } },
    { name: "settings", detail: "Open settings", icon: "settings", run: () => openSettings() },
    { name: "usage", detail: "Token usage and costs", icon: "chart", run: () => setView("usage") },
    { name: "pair", detail: "Pair a phone", icon: "phone", run: () => openSettings("devices") },
    { name: "reconnect", detail: "Reconnect to the agent", icon: "refresh", run: () => void connect() },
    ...(isBusy ? [{ name: "stop", detail: "Stop the running turn", icon: "stop", run: () => { stop(); } }] : []),
  ];
  // ---- Composer: @ mentions of project files and folders ----
  const filesRef = useRef<{ cwd: string; at: number; files: FileEntry[]; loading?: Promise<FileEntry[]> } | null>(null);
  const [mentionVersion, setMentionVersion] = useState(0);
  const [filesErr, setFilesErr] = useState("");
  function loadFiles(cwd: string, force = false): Promise<FileEntry[]> {
    const c = filesRef.current;
    if (c && c.cwd === cwd && !force && Date.now() - c.at < 20000) return c.loading ?? Promise.resolve(c.files);
    const loading = projectFiles(cwd)
      .then((files) => { filesRef.current = { cwd, at: Date.now(), files }; setFilesErr(""); setMentionVersion((v) => v + 1); return files; })
      .catch((e) => { filesRef.current = { cwd, at: Date.now(), files: [] }; setFilesErr(String(e?.message ?? e)); setMentionVersion((v) => v + 1); return [] as FileEntry[]; });
    filesRef.current = { cwd, at: c?.cwd === cwd ? c.at : 0, files: c?.cwd === cwd ? c.files : [], loading };
    return loading;
  }
  const mentionTitle = active ? `Files in ${active.project.name}` : "Files";
  const mentionEmpty = !isDesktop() ? "File mentions need the desktop app" : filesErr ? `Can't list files: ${filesErr}` : filesRef.current?.loading && !filesRef.current.files.length ? "Loading files…" : "No matching files or folders";
  const mentionItems = (q: string): MenuItem[] => {
    if (!active) return [];
    void loadFiles(active.project.cwd);
    const c = filesRef.current;
    return c && c.cwd === active.project.cwd ? fileItems(c.files, q) : [];
  };
  function pickMention(it: MenuItem, m: { start: number; end: number }, drill = false) {
    if (drill && it.value.endsWith("/")) {
      const ins = `@${it.value}`;
      return setDraftCaret(draft.slice(0, m.start) + ins + draft.slice(m.end), m.start + ins.length);
    }
    const r = insertMention(draft, m.start, m.end, it.value);
    setDraftCaret(r.draft, r.caret);
  }
  const nativeByName = new Map(nativeCommands.map((c) => [c.name, c]));
  const [caret, setCaret] = useState(0);
  const [menuSelState, setMenuSelState] = useState({ key: "", i: 0 });
  const [menuOff, setMenuOff] = useState<string | null>(null);
  const mstate = menuOff === draft ? null : menuState(draft, caret, (c) => !!nativeByName.get(c)?.sub);
  const menuItems: MenuItem[] = useMemo(() => {
    if (!mstate) return [];
    if (mstate.kind === "slash") {
      const all: MenuItem[] = [
        ...nativeCommands.map((c) => ({ id: `n-${c.name}`, label: `/${c.name}`, detail: c.detail, icon: c.icon, group: "App", value: `n:${c.name}` })),
        ...commands.map((c) => ({ id: `a-${c.name}`, label: `/${c.name}`, detail: c.description, icon: "tool", group: "Agent", value: `a:${c.name}` })),
      ];
      const q = mstate.q.toLowerCase();
      return filterItems(all.map((x) => ({ ...x, label: x.label.slice(1) })), q).map((x) => ({ ...x, label: `/${x.label}` }));
    }
    if (mstate.kind === "sub") return filterItems(nativeByName.get(mstate.cmd)?.sub?.() ?? [], mstate.q);
    return mentionItems(mstate.q);
  }, [mstate?.kind, (mstate as any)?.q, (mstate as any)?.cmd, commands, configOptions, theme, isBusy, activeChat?.id, mentionVersion]);
  // Selection resets synchronously whenever the query changes (no effect lag before Enter).
  const menuKey = mstate ? `${mstate.kind}|${(mstate as any).cmd ?? ""}|${mstate.q}` : "";
  const menuSel = menuSelState.key === menuKey ? menuSelState.i : 0;
  const setMenuSel = (f: number | ((i: number) => number)) => setMenuSelState({ key: menuKey, i: typeof f === "function" ? f(menuSel) : f });
  const menuOpen = !!mstate && (menuItems.length > 0 || mstate.kind === "mention");
  function setDraftCaret(text: string, pos = text.length) {
    setDraft(text);
    setCaret(pos);
    requestAnimationFrame(() => { const t = composerRef.current; if (t) { t.focus(); t.setSelectionRange(pos, pos); t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 220)}px`; } });
  }
  function runNative(name: string, args = ""): boolean {
    const c = nativeByName.get(name);
    if (!c) return false;
    const r = c.run(args);
    return r !== false;
  }
  function pickMenu(it: MenuItem) {
    if (!mstate) return;
    if (mstate.kind === "slash") {
      const [kind, name] = it.value.split(":");
      if (kind === "n") {
        const c = nativeByName.get(name)!;
        if (c.sub) return setDraftCaret(`/${name} `);
        setDraftCaret("");
        runNative(name);
      } else setDraftCaret(`/${name} `);
      return;
    }
    if (mstate.kind === "sub") {
      setDraftCaret("");
      if (!runNative(mstate.cmd, it.value)) setNotice(`/${mstate.cmd}: could not use “${it.label}”`);
      return;
    }
    pickMention(it, mstate as { start: number; end: number });
  }
  function onMenuKey(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!menuOpen) return false;
    const n = menuItems.length;
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { e.preventDefault(); if (n) setMenuSel((i) => (i + 1) % n); return true; }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) { e.preventDefault(); if (n) setMenuSel((i) => (i - 1 + n) % n); return true; }
    if (e.key === "Tab" && mstate?.kind === "mention" && n && menuItems[Math.min(menuSel, n - 1)].value.endsWith("/")) { e.preventDefault(); pickMention(menuItems[Math.min(menuSel, n - 1)], mstate, true); return true; }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { if (!n) return false; e.preventDefault(); pickMenu(menuItems[Math.min(menuSel, n - 1)]); return true; }
    if (e.key === "Escape") { e.preventDefault(); setMenuOff(draft); return true; }
    return false;
  }

  // ---- Command palette + keyboard shortcuts ----
  const paletteCommands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: "new", title: "New chat", hint: "Ctrl N", icon: "plus", run: () => active && newChat(active.project.id) },
      { id: "settings", title: "Open settings", hint: "Ctrl ,", icon: "settings", run: () => openSettings() },
      { id: "usage", title: "Open usage & costs", hint: "Ctrl Shift U", icon: "chart", run: () => setView("usage") },
      { id: "theme", title: `Switch to ${theme === "light" ? "dark" : "light"} theme`, icon: theme === "light" ? "moon" : "sun", run: () => setTheme(theme === "light" ? "dark" : "light") },
      ...themeList.map((t) => ({ id: `theme-${t.id}`, title: `Theme: ${t.name}`, group: "Themes", icon: t.dark ? "moon" : "sun", run: () => setTheme(t.id) })),
      { id: "sidebar", title: "Toggle sidebar", hint: "Ctrl B", icon: "panelLeft", run: () => setSideCollapsed((x) => !x) },
      { id: "panel", title: "Toggle browser & plan panel", hint: "Ctrl \\", icon: "panelRight", run: () => setPanel((x) => !x) },
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
      else if (k === "escape" && !palette && !perm && viewRef.current !== "chat") setView("chat");
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
      ) : (m as any).error ? (
        <div className="bubble error" role="alert" data-testid="error-item">
          <div className="err-head"><Icon name="alert" size={14} /> {(m as any).error === "config" ? "Setup needed" : (m as any).error === "load" ? "History unavailable" : "The turn failed"}</div>
          <div className="err-body">{m.text}</div>
          <div className="row">
            {(m as any).retry && <button className="secondary compact" data-testid="retry" onClick={() => retryRef.current?.((m as any).retry)}><Icon name="refresh" size={13} /> Retry</button>}
            {(m as any).error === "config" && <button className="ghost compact" onClick={() => openSettings("providers")}>Open providers</button>}
          </div>
        </div>
      ) : (
        <div className={`bubble ${m.kind}`}>{(m as any).from && <span className="from"><Icon name="phone" size={11} /> {(m as any).from}</span>}{m.text}{(m as any).attachments?.length > 0 && <span className="att-names" data-testid="bubble-attachments">{(m as any).attachments.map((n: string) => <span key={n} className="att-name"><Icon name="file" size={11} /> {n}</span>)}</span>}</div>
      ),
    [sess.toolCalls],
  );

  return (
    <div className={`app ${panel && view === "chat" ? "with-panel" : ""} view-${view}`}>
      {cliSetup && (
        <Suspense fallback={null}><CliSetup
          status={cli}
          mode={cliSetup}
          onDone={() => { setCliSetup(null); setAgentMissing(false); void cliStatus(false).then(setCli); void connect(); }}
          onSkip={() => setCliSetup(null)}
        /></Suspense>
      )}
      <Sidebar
        data={data}
        collapsed={sideCollapsed}
        onToggle={() => setSideCollapsed((x) => !x)}
        onSelectChat={(p, c) => void selectChat(p, c)}
        onSelectProject={(pid) => { update((d) => ({ ...d, activeProjectId: pid, activeChatId: undefined })); setView("chat"); }}
        onNewChat={(p) => void newChat(p)}
        onTree={(a) => update((d) => applyTree(d, a))}
        onOpenFolder={openFolder}
        onSidebarView={(v) => update((d) => ({ ...d, sidebarView: v }))}
        onSync={() => void syncCli()}
        syncing={syncBusy}
        onSettings={() => openSettings()}
        onUsage={() => setView("usage")}
        onPalette={() => setPalette(true)}
      />
      {view === "settings" && (
        <Suspense fallback={<ScreenSkeleton />}>
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
          onConfig={(id, v) => { if (activeChat?.sessionId) changeOption(activeChat.sessionId, id, v); }}
          onSave={async (settings) => {
            const activeProvider = settings.providers?.find((p) => p.id === settings.activeProviderId);
            if (activeProvider && isDesktop() && !activeProvider.models.length) {
              setNotice("Choose at least one model for the active provider.");
              return;
            }
            const stored = (await keychainSet(settings.secret)) ? { ...settings, secret: "", secretInKeychain: true } : { ...settings, secretInKeychain: false };
            if (activeProvider && isDesktop()) {
              try {
                await providerApply(activeProvider);
                const result = await agentRestart(stored.bind, secretRef.current || settings.secret, stored.alwaysApprove);
                if (result === "external") setNotice("Provider saved. Restart the external agent to use its updated model selection.");
              } catch (e: any) {
                setNotice(`Could not apply provider: ${e?.message ?? e}`);
                return;
              }
            }
            update((d) => ({ ...d, settings: { ...stored, gateway: d.settings.gateway } }));
            setView("chat");
            void connect();
          }}
        />
        </Suspense>
      )}
      {view === "usage" && (
        <Suspense fallback={<ScreenSkeleton />}>
          <UsageScreen records={usage} pricing={pricing} onPricing={(p) => { setPricing(p); savePricing(p); }} onClear={() => setUsage([])} onClose={() => setView("chat")} />
        </Suspense>
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
            <button className="icon" title={panel ? "Hide browser & plan (Ctrl \\)" : "Show browser & plan (Ctrl \\)"} onClick={() => setPanel((x) => !x)}><Icon name="panelRight" size={18} /></button>
          </header>
          {agentMissing && (
            <div className="agent-setup" data-testid="agent-setup">
              <h3>Install the Supercharge CLI</h3>
              <p className="muted">Supercharge Studio runs <code>supercharge agent serve</code> for you, but could not find the <code>supercharge</code> binary (checked PATH, ~/.local/bin, ~/.supercharge/bin, /usr/local/bin, /usr/bin and your login shell).</p>
              <pre className="cmd">curl -fsSL https://superchargeai.in/install.sh | bash</pre>
              <div className="row">
                <button disabled={!!installing} onClick={() => { setInstalling("Installing…"); void agentInstall().then(() => { setInstalling(""); void connect(); }, (e) => setInstalling(String(e?.message ?? e))); }} data-testid="agent-install">{installing === "Installing…" ? "Installing…" : "Install"}</button>
                <button className="secondary" onClick={() => void navigator.clipboard?.writeText("curl -fsSL https://superchargeai.in/install.sh | bash")}>Copy command</button>
                <button className="secondary" onClick={() => void agentInfo().then(() => connect())} data-testid="agent-retry">Retry</button>
                <button className="ghost" onClick={() => openSettings("connection")}>Settings</button>
              </div>
              {installing && installing !== "Installing…" && <div className="error-text">{installing}</div>}
              <p className="muted small">Already installed somewhere else? Set <code>SUPERCHARGE_BIN</code> to its path.</p>
            </div>
          )}
          {agentRejected && (
            <div className="agent-setup" data-testid="agent-rejected">
              <h3>An agent is already running on {agentRejected} but rejected the key</h3>
              <p className="muted">It was probably started without <code>--secret</code>, so it made up a random key. Paste its key (or its full <code>ws://…?server-key=…</code> URL), or let Supercharge Studio run its own agent.</p>
              <input value={keyDraft} placeholder="server key or ws://127.0.0.1:2419/ws?server-key=…" onChange={(e) => setKeyDraft(e.target.value)} data-testid="agent-key-input" />
              <div className="row">
                <button disabled={!keyDraft.trim()} data-testid="agent-key-save" onClick={async () => {
                  const p = parseAgentUrl(keyDraft);
                  const key = p.secret ?? keyDraft.trim();
                  const bind = p.bind ?? agentRejected;
                  const r = await agentCheck(bind, key);
                  if (r !== "ok") { setKeyErr(r === "rejected" ? "That key was rejected too." : `Could not reach ${bind}.`); return; }
                  const inKc = await keychainSet(key);
                  update((d) => ({ ...d, settings: { ...d.settings, bind, secret: inKc ? "" : key, secretInKeychain: inKc, agentChoice: "key" } }));
                  setKeyDraft(""); setKeyErr("");
                  dataRef.current = { ...dataRef.current, settings: { ...dataRef.current.settings, bind, secret: inKc ? "" : key, secretInKeychain: inKc, agentChoice: "key" } };
                  void connect();
                }}>Use this key</button>
                <button className="secondary" data-testid="agent-use-own" onClick={() => { update((d) => ({ ...d, settings: { ...d.settings, agentChoice: "own" } })); dataRef.current = { ...dataRef.current, settings: { ...dataRef.current.settings, agentChoice: "own" } }; void connect(); }}>Use my own agent</button>
              </div>
              {keyErr && <div className="error-text">{keyErr}</div>}
            </div>
          )}
          {!agentMissing && !agentRejected && (notice || (conn !== "open" && status)) && (
            <div className="notice" data-testid="notice">
              <span role="status">{notice || status}</span>
              <div className="spacer" />
              {!notice && conn !== "connecting" && <><button className="secondary compact" onClick={() => void connect()}>Retry</button><button className="ghost compact" onClick={() => openSettings("connection")}>Settings</button></>}
              {cli?.update_available && /CLI .* is available/.test(notice) && <button className="secondary sm" data-testid="cli-update" onClick={() => { setNotice(""); setCliSetup("update"); }}>Update</button>}
              {notice && <button className="icon sm" title="Dismiss" aria-label="Dismiss" onClick={() => setNotice("")}><Icon name="x" size={14} /></button>}
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
                {activeChat && loadingChats.has(activeChat.id) && sess.items.length === 0 && (
                  <div className="skel-chat" data-testid="chat-skeleton" aria-busy="true" aria-label="Loading chat">
                    <div className="skeleton" style={{ width: "42%", height: 34, marginLeft: "auto" }} />
                    <div className="skeleton" style={{ width: "78%", height: 64 }} />
                    <div className="skeleton" style={{ width: "55%", height: 30 }} />
                    <div className="skeleton" style={{ width: "36%", height: 34, marginLeft: "auto" }} />
                    <div className="skeleton" style={{ width: "70%", height: 48 }} />
                  </div>
                )}
                {sess.items.length === 0 && !isBusy && !(activeChat && loadingChats.has(activeChat.id)) && !data.settings.onboarded && (
                  <Onboarding
                    connected={conn === "open"}
                    connecting={conn === "connecting" || conn === "reconnecting"}
                    status={status}
                    hasProvider={(data.settings.providers ?? []).length > 0}
                    hasProject={!!active}
                    onConnect={() => void connect()}
                    onConnection={() => openSettings("connection")}
                    onProviders={() => openSettings("providers")}
                    onDismiss={() => update((d) => ({ ...d, settings: { ...d.settings, onboarded: true } }))}
                    onBackground={isDesktop() ? (on) => void background.set(on).catch((e) => setNotice(`Start at login: ${e}`)) : undefined}
                  />
                )}
                {sess.items.length === 0 && !isBusy && !(activeChat && loadingChats.has(activeChat.id)) && data.settings.onboarded && (
                  <div className="empty fade-in">
                    <div className="empty-icon"><Icon name="bolt" size={28} /></div>
                    <h2>{active ? `Start a chat in ${active.project.name}` : "Welcome to Supercharge Studio"}</h2>
                    <p>{active ? <>The agent works in <code>{active.project.cwd}</code>. Type a message below, or use <code>/</code> for commands.</> : "Pick or add a project in the sidebar to begin."}</p>
                    <p className="muted keys"><kbd>Ctrl K</kbd> commands · <kbd>Ctrl N</kbd> new chat · <kbd>Ctrl ,</kbd> settings</p>
                    {conn !== "open" && <p className="muted">Agent status: {status || conn}</p>}
                  </div>
                )}

              </>
            }
            footer={isBusy && <div className="typing" aria-label="Agent is working"><i /><i /><i /></div>}
          />
          <div className={`composer-wrap${dragOver ? " drag-over" : ""}`} data-testid="composer-wrap"
            onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
            onDrop={(e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); setDragOver(false); void addFiles([...e.dataTransfer.files]); }}>
            {menuOpen && (
              <ComposerMenu
                items={menuItems}
                sel={menuSel}
                title={mstate!.kind === "slash" ? "Commands" : mstate!.kind === "sub" ? `/${mstate!.cmd}` : mentionTitle}
                empty={mstate!.kind === "mention" ? mentionEmpty : undefined}
                onHover={setMenuSel}
                onPick={pickMenu}
              />
            )}
            {activeChat && active && (pq[activeChat.id] ?? []).length > 0 && (
              <div className="queue" data-testid="queue">
                {(pq[activeChat.id] ?? []).map((q) => (
                  <div key={q.id} className="qchip" data-testid="queued">
                    {editingQ === q.id ? (
                      <input autoFocus className="qedit" data-testid="queued-edit" defaultValue={q.text}
                        onBlur={(e) => { const v = e.target.value.trim(); setPq((all) => ({ ...all, [activeChat.id]: (all[activeChat.id] ?? []).flatMap((x) => (x.id === q.id ? (v ? [{ ...x, text: v }] : []) : [x])) })); setEditingQ(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { (e.target as HTMLInputElement).value = q.text; (e.target as HTMLInputElement).blur(); } }} />
                    ) : (
                      <button className="link qtext" data-testid="queued-text" title="Edit" onClick={() => setEditingQ(q.id)}>{q.text}</button>
                    )}
                    <button className="ghost sm" data-testid="queued-steer" title="Send now into the running turn" onClick={() => { dequeue(activeChat.id, q.id); void steer(active.project.id, activeChat.id, q.text); }}>Steer</button>
                    <button className="icon sm" data-testid="queued-remove" title="Remove" onClick={() => dequeue(activeChat.id, q.id)}><Icon name="x" size={12} /></button>
                  </div>
                ))}
                <span className="muted small">{isBusy ? "Sent when the agent finishes" : "Sending…"}</span>
              </div>
            )}
            {activeChat?.sessionId && <ModelControls key={activeChat.sessionId} options={configOptions} onSelect={(id, value) => changeOption(activeChat.sessionId!, id, value)} />}
            {(atts.length > 0 || attErr) && (
              <div className="att-row" data-testid="attachments">
                {atts.map((a) => (
                  <div key={a.id} className="att-chip" data-testid="attachment" title={`${a.name} · ${fmtSize(a.size)}`}>
                    {a.preview && isImage(a.mime) ? <img src={a.preview} alt="" /> : <span className="att-ico"><Icon name="file" size={14} /></span>}
                    <span className="att-meta"><b>{a.name}</b><span className="muted">{fmtSize(a.size)}</span></span>
                    <button className="icon sm" data-testid="attachment-remove" aria-label={`Remove ${a.name}`} onClick={() => removeAtt(a.id)}><Icon name="x" size={12} /></button>
                  </div>
                ))}
                {attErr && <span className="error-text small" data-testid="attach-error">{attErr}</span>}
              </div>
            )}
            <div className="composer">
              <input ref={fileInput} type="file" multiple hidden accept="*/*" data-testid="attach-input" onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
              <button className="icon attach" data-testid="attach" aria-label="Attach files" title="Attach files (or drop / paste them)" disabled={conn !== "open" || !active} onClick={() => fileInput.current?.click()}><Icon name="clip" /></button>
              <textarea
                onPaste={(e) => { const fs = [...(e.clipboardData?.files ?? [])]; if (fs.length) { e.preventDefault(); void addFiles(fs); } }}
                ref={composerRef}
                value={draft}
                rows={1}
                placeholder={conn === "open" ? (active ? `Message Supercharge…` : "Select a project") : "Agent not connected"}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCaret(e.target.selectionStart ?? e.target.value.length);
                  const t = e.target;
                  t.style.height = "auto";
                  t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
                }}
                onKeyDown={(e) => {
                  if (onMenuKey(e)) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={conn !== "open" || !active}
              />
              {isBusy ? (
                <>
                  {draft.trim() && <button className="round secondary" data-testid="queue-send" aria-label={data.settings.steerByDefault ? "Steer" : "Queue"} title={data.settings.steerByDefault ? "Steer the current turn (Enter)" : "Send when the agent finishes (Enter)"} onClick={() => void send()}><Icon name="send" /><span className="sr">{data.settings.steerByDefault ? "Steer" : "Queue"}</span></button>}
                  <button className="danger round" aria-label="Stop" title="Stop (Ctrl .)" onClick={stop}><Icon name="stop" /><span className="sr">Stop</span></button>
                </>
              ) : (
                <button className="round" aria-label="Send" title="Send (Enter)" onClick={() => void send()} disabled={conn !== "open" || !active || (!draft.trim() && !atts.length)}><Icon name="send" /><span className="sr">Send</span></button>
              )}
            </div>
            <div className="hint">{active ? <><span>cwd <code>{active.project.cwd}</code> · Enter to send, Shift+Enter for a new line · / commands · @ files</span>{activeChat?.sessionId && <ModeControl key={activeChat.sessionId} modes={sessionModes} currentMode={sess.modeId} permission={permissionOption} onMode={changeMode} onPermission={changePermission} />}</> : " "}</div>
          </div>
        </main>
      )}
      {view === "chat" && panel && <BrowserPanel plan={sess.plan} sessionId={activeChat?.sessionId} onClose={() => setPanel(false)} />}
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

function ScreenSkeleton() {
  return (
    <main className="main screen-skel" aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ width: 180, height: 22 }} />
      <div className="skeleton" style={{ height: 120 }} />
      <div className="skeleton" style={{ height: 220 }} />
    </main>
  );
}
