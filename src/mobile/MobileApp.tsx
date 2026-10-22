import { invoke, isDesktop } from "../lib/desktop";
import { cleanPermission } from "../lib/labels";
import { answerOption, permKey } from "../lib/quick";
import { clip, Deduper, defaultNotifyPrefs, notifyTitle, shouldNotify, type NotifyKind, type NotifyPrefs } from "../lib/notify";
import type { Hit, SearchIndex } from "../lib/searchIndex";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { type Attachment, deviceBlocks, fmtSize, fromFile, isImage, rejectReason } from "../lib/attachments";
import { APP_VERSION, checkUpdate, pickApk, UPDATE_EVERY } from "../lib/updates";
import { effortLabel, reasoningOption } from "../lib/sessionOptions";
import { ContextMeter, type WindowCtl } from "../components/ContextMeter";
import { applyWindow, windowOption } from "../lib/contextWindow";
/** Provider setup on the paired computer (same steps as the CLI's /setup), loaded on first open. */
const PhoneSetup = lazy(() => Promise.all([import("../components/ProviderSetup"), import("../lib/setup")]).then(([m, s]) => ({
  default: function PhoneSetup({ client, onClose, sessionId }: { client: AcpClient; onClose: () => void; sessionId: () => string | undefined }) {
    const api = useMemo(() => s.rpcSetup((op, p) => client.ext("_supercharge/setup", { ...p, op })), [client]);
    return <m.default api={api} open={(u) => window.open(u, "_blank")} onClose={onClose} sessionId={sessionId} />;
  },
})));

/** Light haptic tick where the platform allows it. */
const haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* not supported */ } };
/** Fast reconnect: 250 ms, doubling, never more than 5 s between tries. */
export const RECONNECT = { initialDelayMs: 250, maxDelayMs: 5000, factor: 2 };
/** The on-screen keyboard is open when the visible height dropped well below the full height. */
export const keyboardOpen = (full: number, now: number) => full - now > 120;
/** Android keep-alive bridge (absent on iOS and in the browser). */
/** Local alert for agent events while the app is in the background or another chat is open. */
const notifyDedupe = new Deduper();
function phoneNotify(kind: NotifyKind, sid: string, chatTitle: string, body: string, prefs: NotifyPrefs, openSid: string | null, key?: string) {
  const visible = document.visibilityState !== "hidden";
  if (!shouldNotify(kind, prefs, { focused: visible, visible, activeChatId: openSid ?? undefined, chatId: sid }) || !notifyDedupe.ok(`${sid}:${kind}`)) return;
  const title = notifyTitle(kind, chatTitle), text = clip(body);
  try {
    const a = (window as any).SuperchargeAndroid;
    if (key && a?.notifyPermission) { a.notifyPermission(sid, key, title, text, prefs.sound); return; }
    if (a?.notify) { a.notify(sid, title, text, prefs.sound); return; }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification(title, { body: text, silent: !prefs.sound });
      n.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent("supercharge:open-chat", { detail: sid })); };
    }
  } catch { /* not available */ }
}
const NOTIFY_KEY = "supercharge-mobile/notify";
const loadNotifyPrefs = (): NotifyPrefs => { try { return { ...defaultNotifyPrefs, ...JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? "{}") }; } catch { return defaultNotifyPrefs; } };
const keepAlive = (on: boolean) => { try { (window as any).SuperchargeAndroid?.keepAlive?.(on); } catch { /* not available */ } };
const SUGGESTIONS = ["Explain this project", "Find and fix a bug", "Write tests for recent changes", "Summarize what changed today"];

type Sess = { sessionId: string; title?: string; cwd?: string; updatedAt?: string; _meta?: { project?: string; projectId?: string; group?: string; busy?: boolean } };
type Project = { projectId: string; name: string; cwd: string; group: string };
type HistoryView = "projects" | "chats";
const HISTORY_KEY = "supercharge-mobile/history-view";

function sessionTime(s: Sess): number {
  const t = Date.parse(s.updatedAt ?? "");
  return Number.isFinite(t) ? t : 0;
}

function ago(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Chat history buckets: today, yesterday, the last week, then everything older. */
function chatBucket(ms: number, now = Date.now()): string {
  if (!ms) return "Older";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = start.getTime();
  if (ms >= day) return "Today";
  if (ms >= day - 86_400_000) return "Yesterday";
  if (ms >= day - 7 * 86_400_000) return "Previous 7 days";
  return "Older";
}

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
      <div className="m-hero"><div className="logo big"><img src="/logo.png" alt="" /></div><h1>Supercharge Studio</h1><p className="muted">Pair with Supercharge Studio on your computer: Settings → Devices → Show pairing code.</p></div>
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
  /** The computer's saved prompts (custom slash commands); the computer expands them. */
  const [prompts, setPrompts] = useState<{ name: string; text: string }[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  // Notifications + message search (local index of chats opened on this phone).
  const notifyPrefs = useRef(loadNotifyPrefs());
  const openRef = useRef<string | null>(null);
  openRef.current = open;
  const titleOf = useRef<(sid: string) => string>(() => "chat");
  const notifyRef = useRef((kind: NotifyKind, sid: string, body: string, key?: string) => phoneNotify(kind, sid, titleOf.current(sid), body, notifyPrefs.current, openRef.current, key));
  /** Allow / Deny tapped on a notification before the request reached this page (after a reconnect). */
  const answers = useRef(new Map<string, boolean>());
  const searchIx = useRef<SearchIndex | null>(null);
  const [flashMsg, setFlashMsg] = useState(-1);
  const photoInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<Record<string, SessionState>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [permQueue, setPermQueue] = useState<{ req: PermissionRequest; resolve: (o: PermissionOutcome) => void }[]>([]);
  const perm = permQueue[0] ?? null;
  const [handoff, setHandoff] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  // Android downloads the APK in the background (must match latest.json's sha256) and the system installer
  // replaces the app in place; iOS links to the release. On launch and every 6 hours.
  const [update, setUpdate] = useState<any>(null);
  useEffect(() => {
    const A = (window as any).SuperchargeAndroid, on = (e: any) => setUpdate((u: any) => u && { ...u, ...e.detail });
    let found = 0;
    const run = () => checkUpdate(APP_VERSION, pickApk).then((n: any) => {
      if (found || !n) return setUpdate((u: any) => u && { ...u, hide: 0 });
      found = 1;
      if (A?.downloadUpdate && n.manifest) A.downloadUpdate(n.asset, n.manifest, n.assetName), (n.p = 0);
      setUpdate(n);
    }).catch(() => {});
    addEventListener("supercharge:update", on);
    void run();
    const t = setInterval(run, UPDATE_EVERY);
    return () => { clearInterval(t); removeEventListener("supercharge:update", on); };
  }, []);
  const [listed, setListed] = useState(false);
  const [loadingSess, setLoadingSess] = useState<string | null>(null);
  const [configBySession, setConfigBySession] = useState<Record<string, ConfigOption[]>>({});
  // Context meter + window override (the computer reports support per session).
  const [ctxBySession, setCtxBySession] = useState<Record<string, { used: number; max?: number }>>({});
  const [windowBySession, setWindowBySession] = useState<Record<string, { via: "option" | "ext"; current?: number | "auto" | null } | null>>({});
  const rememberWindow = (sid: string, r: any) => { const w = r?._meta?.supercharge?.contextWindow; setWindowBySession((all) => ({ ...all, [sid]: w && (w.via === "option" || w.via === "ext") ? w : null })); };
  const [modesBySession, setModesBySession] = useState<Record<string, SessionModes>>({});
  const rememberModes = (sid: string, modes?: SessionModes) => {
    if (modes?.availableModes?.length) setModesBySession((all) => ({ ...all, [sid]: modes }));
  };
  const [picker, setPicker] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [settingOption, setSettingOption] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [route, setRoute] = useState<"direct" | "relay">("direct");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [attErr, setAttErr] = useState("");
  const [uploading, setUploading] = useState<number | null>(null);
  const [sheet, setSheet] = useState(false);
  const [newSheet, setNewSheet] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [thinkPop, setThinkPop] = useState(false);
  const [permPop, setPermPop] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [historyView, setHistoryView] = useState<HistoryView>(() => (localStorage.getItem(HISTORY_KEY) === "projects" ? "projects" : "chats"));
  const [drawer, setDrawer] = useState(false);
  const [modePop, setModePop] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const stuck = useRef(true);
  const pickView = (v: HistoryView) => { setHistoryView(v); localStorage.setItem(HISTORY_KEY, v); };
  const fileInput = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const client = useRef<AcpClient | null>(null);
  const queued = useRef<{ sid: string; text: string }[]>([]);
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
    setPrompts(r._meta?.prompts ?? []);
  }, []);

  // Keyboard: the native side shrinks the web view (adjustResize + IME insets), so the app
  // only has to match the visible height. Header and chat list stay put; the composer sits
  // on top of the keyboard and the chat list shrinks, keeping the latest message in view.
  useEffect(() => {
    const vv = window.visualViewport;
    let full = 0, width = 0;
    const fit = () => {
      const h = Math.round(vv?.height ?? window.innerHeight);
      if (window.innerWidth !== width) { width = window.innerWidth; full = 0; }
      full = Math.max(full, h, vv ? 0 : window.innerHeight);
      const root = document.documentElement;
      root.style.setProperty("--vvh", `${h}px`);
      root.dataset.kb = keyboardOpen(full, h) ? "1" : "";
      if (window.scrollY) window.scrollTo(0, 0); // never let the page itself pan
      const el = scroller.current;
      if (el && stuck.current) el.scrollTop = el.scrollHeight;
    };
    fit();
    vv?.addEventListener("resize", fit);
    window.addEventListener("resize", fit);
    return () => { vv?.removeEventListener("resize", fit); window.removeEventListener("resize", fit); };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    const apply = () => (document.documentElement.dataset.theme = mq?.matches ? "light" : "dark");
    apply();
    mq?.addEventListener?.("change", apply);
    return () => mq?.removeEventListener?.("change", apply);
  }, []);

  useEffect(() => {
    if (!creds) return;
    const pending: { sid: string; u: any }[] = [];
    let raf = 0;
    const c = new AcpClient({
      reconnect: RECONNECT,
      heartbeatMs: 15_000,
      heartbeatTimeoutMs: 5_000,
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
        else if (method === "_supercharge/agent_event" && p?.sessionId && ["done", "error", "permission"].includes(p?.kind)) notifyRef.current(p.kind, String(p.sessionId), String(p.body ?? ""));
        else if (method === "_supercharge/sessions/changed") void refresh();
        else if (method === "_supercharge/session/context_usage" && p?.sessionId && Number(p?.usedTokens) >= 0) setCtxBySession((all) => ({ ...all, [String(p.sessionId)]: { used: Number(p.usedTokens), max: Number(p.maxTokens) > 0 ? Number(p.maxTokens) : all[String(p.sessionId)]?.max } }));
      },
      onPermissionRequest: (req) => new Promise((resolve) => {
        const key = permKey(req), early = answers.current.get(key), opt = early != null && answerOption(req.options, early);
        if (opt) { answers.current.delete(key); return resolve({ outcome: "selected", optionId: opt }); }
        notifyRef.current("permission", req.sessionId, `Allow: ${(req as any).toolCall?.title ?? "a tool call"}?`, key);
        setPermQueue((pending) => [...pending, { req: cleanPermission(req), resolve }]);
      }),
      onReconnected: () => {
        loadedRef.current.clear();
        setConfigBySession({});
        setModesBySession({});
        // Questions asked on the old socket can't be answered any more; the desktop asks again on load.
        setPermQueue((q) => { q.forEach((x) => x.resolve({ outcome: "cancelled" })); return []; });
        void refresh().then(() => {
          // Turns keep running on the computer while the phone is away: take "busy" from it.
          setBusy(Object.fromEntries(sessionsRef.current.map((s) => [s.sessionId, !!s._meta?.busy])));
          flushQueued();
        }).catch(() => {});
        const sid = activeSessionRef.current;
        if (sid) {
          setState((all) => ({ ...all, [sid]: emptySession() }));
          setLoadingSess(sid);
          void c.loadSession(sid, sessionsRef.current.find((s) => s.sessionId === sid)?.cwd ?? "")
            .then((r: any) => {
              loadedRef.current.add(sid);
              if (Array.isArray(r?.configOptions)) setConfigBySession((all) => ({ ...all, [sid]: r.configOptions }));
              rememberModes(sid, r?.modes); rememberWindow(sid, r);
            })
            .catch((e) => setErr(`Could not reload this chat: ${e?.message ?? e}`))
            .finally(() => setLoadingSess(null));
        }
      },
    });
    client.current = c;
    // Back from the background, screen on, or network changed: check the link and reconnect now.
    const wake = () => { if (document.visibilityState !== "hidden") c.reconnectNow(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("supercharge:resume", wake);
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
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("supercharge:resume", wake);
      c.close();
    };
  }, [creds, refresh, retryKey]);

  // Android: keep the process (and socket) alive with a quiet notification while a turn runs.
  const anyBusy = Object.values(busy).some(Boolean);
  useEffect(() => { keepAlive(anyBusy && conn !== "closed" && conn !== "idle"); }, [anyBusy, conn]);
  useEffect(() => () => keepAlive(false), []);

  // Only show "Reconnecting…" if it takes a moment, so a quick resume doesn't flash a banner.
  const [showConn, setShowConn] = useState(false);
  useEffect(() => {
    if (conn !== "reconnecting" && conn !== "closed") { setShowConn(false); return; }
    const t = setTimeout(() => setShowConn(true), conn === "closed" ? 0 : 1200);
    return () => clearTimeout(t);
  }, [conn]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  titleOf.current = (sid) => list.find((x) => x.sessionId === sid)?.title || "chat";
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!searchIx.current) { const { SearchIndex } = await import("../lib/searchIndex"); searchIx.current ??= new SearchIndex(); }
      for (const x of list) {
        const at = Date.parse(x.updatedAt ?? "") || 0;
        searchIx.current!.upsert({ chatId: x.sessionId, title: x.title || "Untitled", project: x._meta?.project ?? (x.cwd ?? "").split(/[\\/]/).pop() ?? "", updatedAt: at }, (state[x.sessionId]?.items as any) ?? null);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [list, state]);
  async function openHit(h: Hit) {
    await openSession(h.chatId);
    if (h.msgIndex == null) return;
    const idx = h.msgIndex;
    let tries = 0;
    const t = setInterval(() => {
      const el = document.querySelector(`[data-mi="${idx}"]`) as HTMLElement | null;
      if (el) { clearInterval(t); stuck.current = false; el.scrollIntoView({ block: "center" }); setFlashMsg(idx); setTimeout(() => setFlashMsg(-1), 2200); }
      else if (++tries > 40) clearInterval(t);
    }, 75);
  }
  useEffect(() => {
    const onOpen = (e: Event) => { const sid = String((e as CustomEvent).detail ?? ""); if (sid) { setDrawer(false); void openSession(sid); } };
    window.addEventListener("supercharge:open-chat", onOpen);
    return () => window.removeEventListener("supercharge:open-chat", onOpen);
  });
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
      .then((r: any) => { if (Array.isArray(r?.configOptions)) setConfigBySession((all) => ({ ...all, [sid]: r.configOptions })); rememberModes(sid, r?.modes); rememberWindow(sid, r); })
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
    rememberModes(r.sessionId, r.modes); rememberWindow(r.sessionId, r);
    setPicker(null);
    setModelSearch("");
    await refresh();
    setOpen(r.sessionId);
  }

  async function addFiles(files: File[]) {
    setAttErr("");
    let n = atts.length;
    const add: Attachment[] = [];
    for (const f of files) {
      const why = rejectReason(f, n);
      if (why) { setAttErr(why); continue; }
      try { add.push(await fromFile(f)); } catch (e: any) { setAttErr(String(e?.message ?? e)); continue; }
      n++;
    }
    if (add.length) { haptic(); setAtts((a) => [...a, ...add]); }
  }
  const removeAtt = (id: string) => setAtts((a) => { const x = a.find((y) => y.id === id); if (x?.preview) URL.revokeObjectURL(x.preview); return a.filter((y) => y.id !== id); });

  async function send() {
    const c = client.current;
    const text = draft.trim();
    if (!c || !open || (!text && !atts.length) || uploading != null) return;
    haptic();
    if (c.state !== "open" && !atts.length) {
      // Offline for a moment: hold the message and send it as soon as the link is back.
      queued.current.push({ sid: open, text });
      setDraft("");
      if (inputRef.current) inputRef.current.style.height = "";
      setToast("Will send when reconnected");
      c.reconnectNow();
      return;
    }
    await sendText(c, open, text);
  }

  async function sendText(c: AcpClient, open: string, text: string, withFiles = true) {
    let extra: unknown[] = [];
    if (withFiles && atts.length) {
      setUploading(0);
      try {
        // Files go up in small encrypted chunks first (the relay caps frame size), then the prompt links them.
        extra = await deviceBlocks(atts, (p) => c.ext("_supercharge/upload", p), (i, pr) => setUploading((i + pr) / atts.length));
      } catch (e: any) {
        setAttErr(`Upload failed: ${e?.message ?? e}`);
        setUploading(null);
        return;
      }
      setUploading(null);
      atts.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      setAtts([]);
    }
    setDraft("");
    stuck.current = true;
    setAtBottom(true);
    if (inputRef.current) inputRef.current.style.height = "";
    setBusy((b) => ({ ...b, [open]: true }));
    try {
      const r = await c.prompt(open, text, extra);
      if (r.stopReason !== "end_turn") setState((all) => ({ ...all, [open]: { ...all[open], items: [...all[open].items, { kind: "system", text: `stopped: ${r.stopReason}` }] } }));
      if (r.stopReason !== "cancelled") notifyRef.current("done", open, r.stopReason === "end_turn" ? "The agent finished its reply" : `Stopped: ${r.stopReason}`);
      setBusy((b) => ({ ...b, [open]: false }));
    } catch (e: any) {
      // A dropped link doesn't stop the turn on the computer; the reload after reconnecting shows the rest.
      if (/Connection lost|Connection closed|no answer to ping/i.test(String(e?.message ?? e))) return;
      setState((all) => ({ ...all, [open]: { ...(all[open] ?? emptySession()), items: [...(all[open]?.items ?? []), { kind: "system", text: `The turn failed: ${e?.message ?? e}`, error: true } as any] } }));
      notifyRef.current("error", open, String(e?.message ?? e));
      setBusy((b) => ({ ...b, [open]: false }));
    }
  }

  function flushQueued() {
    const c = client.current;
    if (!c || c.state !== "open") return;
    for (const q of queued.current.splice(0)) void sendRef.current(c, q.sid, q.text, false);
  }
  const sendRef = useRef(sendText);
  sendRef.current = sendText;

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
  // Stick to the bottom while streaming unless the reader has scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [sess]);
  useEffect(() => { stuck.current = true; setAtBottom(true); }, [open]);
  const onThreadScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    stuck.current = near;
    setAtBottom((v) => (v === near ? v : near));
  };
  const jumpToEnd = () => { const el = scroller.current; if (!el) return; stuck.current = true; setAtBottom(true); el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); };

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

  const back = () => { activeSessionRef.current = null; setPicker(null); setSheet(false); transition(() => setOpen(null)); };
  useSwipeBack(threadView, !!open, back);
  usePullToRefresh(listRef, ptr, !!creds && !open, async () => { await refresh(); setToast("Up to date"); });

  if (!creds) return <div className="m-app"><Pair onPaired={(c) => { saveCreds(c); setCreds(c); }} /></div>;

  const title = list.find((s) => s.sessionId === open)?.title ?? "New chat";
  const isBusy = !!(open && busy[open]);
  const sessionOptions = (open && configBySession[open]) || [];
  const modelOption = sessionOptions.find((o) => o.id === "model" && o.options?.length);
  const thinkingOption = reasoningOption(sessionOptions);
  const permissionOption = sessionOptions.find((o) => o.id === "permission_mode" && o.options?.length);
  const sessionModes = open ? modesBySession[open] : undefined;
  const activeOption = sessionOptions.find((o) => o.id === picker);
  const windowSup = open ? windowBySession[open] : null;
  const windowCtl: WindowCtl | undefined = open && windowSup ? {
    option: windowSup.via === "option" ? windowOption(sessionOptions) : undefined, ext: windowSup.via === "ext", current: windowSup.current,
    onSet: async (v) => {
      const c = client.current, sid = open;
      if (!c) throw new Error("Not connected");
      haptic();
      const r = await applyWindow(c, sid, v, windowSup.via === "option");
      if (r.configOptions) setConfigBySession((all) => ({ ...all, [sid]: r.configOptions! }));
      if (windowSup.via === "ext") setWindowBySession((all) => ({ ...all, [sid]: { via: "ext", current: v === "auto" ? "auto" : r.contextWindow ?? v } }));
      const n = v === "auto" ? r.contextWindow ?? undefined : r.contextWindow ?? v;
      if (n) setCtxBySession((all) => ({ ...all, [sid]: { used: all[sid]?.used ?? 0, max: n } }));
    },
  } : undefined;
  const optionLabel = (option: ConfigOption) => { const cur = option.options?.find((v) => v.value === option.currentValue); return (option.id === "reasoning_effort" || option.category === "thought_level") ? effortLabel(option.currentValue ?? "", cur?.name) : (cur?.name ?? option.currentValue ?? option.name ?? option.id); };
  const hasSettings = !!(modelOption || thinkingOption || permissionOption || sessionModes);
  const renderItem = (m: ChatItem, i: number) =>
    m.kind === "tool" ? (sess.toolCalls[m.toolCallId] ? <ToolCard key={i} tc={sess.toolCalls[m.toolCallId]} compact /> : null)
      : m.kind === "agent" ? <div key={i} data-mi={i} className={`bubble agent${flashMsg === i ? " search-flash" : ""}`}><Markdown text={m.text} /></div>
      : <div key={i} data-mi={i} className={`bubble ${(m as any).error ? "error" : m.kind}${flashMsg === i ? " search-flash" : ""}`} role={(m as any).error ? "alert" : undefined}>{m.text}</div>;
  const q = search.trim().toLowerCase();
  const msgHits: Hit[] = q.length >= 2 ? (searchIx.current?.search(q, 30) ?? []).filter((h) => h.msgIndex != null) : [];
  const shown = q ? grouped.map((g) => ({ ...g, sessions: g.sessions.filter((s) => `${s.title ?? ""} ${g.project.name}`.toLowerCase().includes(q)) })).filter((g) => g.sessions.length || g.project.name.toLowerCase().includes(q)) : grouped;
  const allProjects = grouped.map((g) => g.project);
  const chatSections = (() => {
    const order = ["Today", "Yesterday", "Previous 7 days", "Older"];
    const now = Date.now();
    const sessions = shown.flatMap(({ project, sessions }) => sessions.map((s) => ({ s, project })));
    sessions.sort((a, b) => sessionTime(b.s) - sessionTime(a.s));
    const buckets = new Map<string, typeof sessions>();
    for (const row of sessions) {
      const name = chatBucket(sessionTime(row.s), now);
      const rows = buckets.get(name) ?? [];
      rows.push(row);
      buckets.set(name, rows);
    }
    return order.filter((name) => buckets.has(name)).map((name) => ({ name, rows: buckets.get(name)! }));
  })();
  // Quick actions: notification answers, and the home-screen widget's status line.
  useEffect(() => {
    const on = (e: Event) => {
      const { key, allow } = (e as CustomEvent).detail ?? {};
      setPermQueue((q) => {
        const it = q.find((x) => permKey(x.req) === key), opt = it && answerOption(it.req.options, !!allow);
        if (!opt) { answers.current.set(String(key), !!allow); return q; }
        it!.resolve({ outcome: "selected", optionId: opt });
        setToast(allow ? "Allowed" : "Denied");
        return q.filter((x) => x !== it);
      });
    };
    window.addEventListener("supercharge:answer", on);
    return () => window.removeEventListener("supercharge:answer", on);
  }, []);
  const working = Object.values(busy).filter(Boolean).length;
  useEffect(() => {
    try { (window as any).SuperchargeAndroid?.widget?.(JSON.stringify({ working, waiting: permQueue.length, linked: !!creds, title: permQueue[0]?.req.toolCall.title ?? "" })); } catch { /* no widget */ }
  }, [working, permQueue.length, !!creds]);
  const canSend = (!!draft.trim() || atts.length > 0) && uploading == null;
  const slashQ = /^\/[\w-]*$/.test(draft) ? draft.slice(1).toLowerCase() : null;
  const shownPrompts = slashQ == null ? [] : prompts.filter((p) => p.name.startsWith(slashQ));

  return (
    <div className="m-app">
      {update && !update.hide && (
        <div className="m-sheet-bg top" data-testid="m-update">
          <div className="m-sheet" role="dialog" aria-label="Update" onClick={(e) => e.stopPropagation()}>
            <div className="m-grabber" aria-hidden />
            <h3>{update.ready ? "Update ready" : `Update ${update.version}`}</h3>
            {update.err ? <p className="muted">{update.err}</p> : update.p != null && !update.ready && <progress data-testid="m-update-progress" max={1} value={update.p || undefined} />}
            {(update.ready || update.p == null) && <button className="m-big" onClick={() => update.ready ? (window as any).SuperchargeAndroid.installUpdate() : window.open(update.err ? update.asset : update.page)}>{update.ready ? "Restart" : update.err ? "Download manually" : "Install"}</button>}
            <button className="m-big secondary" onClick={() => setUpdate({ ...update, hide: 1 })}>Later</button>
          </div>
        </div>
      )}
      <header className="m-top">
        {open ? <button className="icon" aria-label="Chats" data-testid="m-menu" onClick={() => { haptic(); setDrawer(true); }}><Icon name="panelLeft" size={20} /></button> : <div className="logo"><img src="/logo.png" alt="" /></div>}
        {open && <button className="icon" aria-label="Back" onClick={back} data-testid="m-back"><Icon name="arrowLeft" size={20} /></button>}
        {open ? (
          <button className="m-head-title" data-testid="m-chat-settings" aria-label="Chat settings" disabled={!hasSettings} onClick={() => { haptic(); setSheet(true); }}>
            <span className="m-title">{title}</span>
            {modelOption && <span className="m-sub">{optionLabel(modelOption)}{sessionModes && <> · {sessionModes.availableModes.find((x) => x.id === (sess.modeId ?? sessionModes.currentModeId))?.name ?? ""}</>}{hasSettings && <Icon name="chevronRight" size={11} />}</span>}
          </button>
        ) : (
          <div className="m-head-title static"><span className="m-title">{creds.desktopName ?? "Supercharge Studio"}</span><span className="m-sub">{conn === "open" ? (route === "relay" ? "Connected anywhere" : "Connected on Wi-Fi") : conn === "connecting" || conn === "reconnecting" ? "Connecting…" : "Offline"}</span></div>
        )}
        {conn === "open" && route === "relay" && <span className="pill" data-testid="m-route" title="Connected through the relay (end-to-end encrypted)">relay</span>}
        <span className={`m-dot ${conn === "open" ? "ok" : "bad"}`} data-testid="m-status" title={conn}><i /><span className="sr">{conn}</span></span>
        {open && <button className="icon" aria-label="New chat" data-testid="m-new-chat" onClick={() => { haptic(); const pid = list.find((s) => s.sessionId === open)?._meta?.projectId; const p = allProjects.find((x) => x.projectId === pid); if (p) void newChat(p); else setNewSheet(true); }}><Icon name="compose" size={18} /></button>}
      </header>
      {showConn && (conn === "reconnecting" || conn === "closed") && !err && (
        <div className={`m-conn ${conn}`} role="status" data-testid="m-conn">
          <span className="m-conn-dot" aria-hidden />
          <span>{connLabel(conn)}</span>
          <div className="spacer" />
          <button className="secondary compact" data-testid="m-reconnect" onClick={() => { haptic(); setRetryKey((k) => k + 1); }}>Reconnect</button>
        </div>
      )}
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
      {(!open || drawer) && (
        <div className={open ? "m-list-wrap m-drawer-open" : "m-list-wrap"} onClick={(e) => { if (open && e.target === e.currentTarget) setDrawer(false); }}>
          <div className="m-ptr" ref={ptr} aria-hidden><Icon name="refresh" size={18} /></div>
          <div className="m-list" ref={listRef} data-testid="m-list">
            {listed && grouped.length > 0 && (
              <>
                <div className="m-views" role="tablist" aria-label="History">
                  <button role="tab" aria-selected={historyView === "chats"} className={historyView === "chats" ? "on" : ""} data-testid="m-view-chats" onClick={() => pickView("chats")}>Recents</button>
                  <button role="tab" aria-selected={historyView === "projects"} className={historyView === "projects" ? "on" : ""} data-testid="m-view-projects" onClick={() => pickView("projects")}>Projects</button>
                </div>
                <label className="m-search"><Icon name="search" size={15} /><input type="search" placeholder="Search chats" aria-label="Search chats" data-testid="m-search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
              </>
            )}
            {!listed && !err && [0, 1].map((k) => (
              <section key={k} className="m-proj m-skel" aria-busy="true" data-testid="m-skeleton">
                <div className="skeleton" style={{ width: "40%", height: 16, margin: "8px" }} />
                <div className="skeleton" style={{ height: 40, margin: "6px" }} />
                <div className="skeleton" style={{ height: 40, margin: "6px" }} />
              </section>
            ))}
            {listed && grouped.length === 0 && <div className="empty"><div className="empty-icon"><Icon name="folder" size={24} /></div><h2>No projects yet</h2><p className="muted">Add a project on your computer and it will show up here.</p></div>}
            {historyView === "projects" && shown.map(({ project, sessions }, pi) => {
              const openFolder = !!expanded[project.projectId];
              const visible = openFolder ? sessions : sessions.slice(0, 3);
              return (
              <section key={`${project.projectId}-${pi}`} className="m-proj" style={{ animationDelay: `${Math.min(pi, 6) * 40}ms` }}>
                <div className="m-proj-head"><Icon name="folder" size={15} /><b>{project.name}</b><div className="spacer" /><button className="icon" aria-label={`New chat in ${project.name}`} data-testid="m-new" onClick={() => { haptic(); setDrawer(false); void newChat(project); }}><Icon name="plus" /></button></div>
                {sessions.length === 0 && <div className="muted m-none">No chats</div>}
                {visible.map((s, si) => (
                  <button key={`${s.sessionId}-${si}`} className={`m-chat${s.sessionId === open ? " on" : ""}`} data-testid="m-chat" onClick={() => { setDrawer(false); void openSession(s.sessionId); }}>
                    <span className="m-chat-title">{s.title || "Untitled"}</span>
                    {s._meta?.busy && <i className="m-busy" aria-label="working" />}
                  </button>
                ))}
                {sessions.length > 3 && <button className="m-more" onClick={() => setExpanded((e) => ({ ...e, [project.projectId]: !openFolder }))}>{openFolder ? "Show less" : "Show more"}</button>}
              </section>
              );
            })}
            {historyView === "chats" && (
              <section className="m-proj" data-testid="m-chat-section">
                <div className="m-proj-head"><b>Recents</b></div>
                {chatSections.flatMap((section) => section.rows).map(({ s, project }, si) => (
                  <button key={`${s.sessionId}-${si}`} className={`m-chat m-chat-recent${s.sessionId === open ? " on" : ""}`} data-testid="m-chat" onClick={() => { setDrawer(false); void openSession(s.sessionId); }}>
                    <span className="m-chat-body"><span className="m-chat-title">{s.title || "Untitled"}</span><span className="m-chat-sub">{project.name}</span></span>
                    <span className="m-chat-time">{ago(sessionTime(s))}</span>
                    {s._meta?.busy && <i className="m-busy" aria-label="working" />}
                  </button>
                ))}
              </section>
            )}
            {msgHits.length > 0 && (
              <section className="m-proj" data-testid="m-msg-hits">
                <div className="m-proj-head"><b>In messages</b></div>
                {msgHits.map((h) => (
                  <button key={`hit-${h.chatId}`} className="m-chat m-chat-recent m-hit" data-testid="m-search-hit" onClick={() => { setDrawer(false); void openHit(h); }}>
                    <span className="m-chat-body"><span className="m-chat-title">{h.title || "Untitled"}</span><span className="m-chat-sub m-snip">{h.snippet.before}<mark>{h.snippet.match}</mark>{h.snippet.after}</span></span>
                    <span className="m-chat-time">{h.project}</span>
                  </button>
                ))}
              </section>
            )}
            {q && shown.length === 0 && msgHits.length === 0 && <p className="muted m-none">No chats match “{search}”.</p>}
            </div>
          <div className="m-fab-row">
            <button className="m-fab m-disconnect" data-testid="m-disconnect" onClick={() => { haptic(); setConfirmDisconnect(true); }}>Disconnect</button>
            {(client.current?.initResult?.agentCapabilities as any)?._meta?.supercharge?.setup && <button className="m-fab m-disconnect" data-testid="m-setup" aria-label="Provider setup" onClick={() => { haptic(); setDrawer(false); setSetupOpen(true); }}><Icon name="server" size={16} /></button>}
            {listed && allProjects.length > 0 && (
              <button className="m-fab" data-testid="m-fab" aria-label="New chat" onClick={() => { haptic(); setDrawer(false); if (allProjects.length === 1) void newChat(allProjects[0]); else setNewSheet(true); }}><Icon name="compose" size={18} /> New chat</button>
            )}
          </div>
        </div>
      )}
      {open && (
        <div className="m-view" ref={threadView}>
          <div className="m-thread" ref={scroller} data-testid="m-thread" onScroll={onThreadScroll}>
            <div className={`thread${isBusy ? " streaming" : ""}`}>
              {loadingSess === open && sess.items.length === 0 && (
                <div className="skel-chat" aria-busy="true">
                  <div className="skeleton" style={{ width: "50%", height: 34, marginLeft: "auto" }} />
                  <div className="skeleton" style={{ width: "80%", height: 60 }} />
                  <div className="skeleton" style={{ width: "60%", height: 30 }} />
                </div>
              )}
              {loadingSess !== open && sess.items.length === 0 && !isBusy && (
                <div className="m-welcome" data-testid="m-welcome">
                  <div className="logo big"><img src="/logo.png" alt="" /></div>
                  <h2>What can I help with?</h2>
                </div>
              )}
              {sess.plan.length > 0 && <section className="m-plan" data-testid="m-plan"><strong>Plan</strong><ol>{sess.plan.map((step, i) => <li key={`${i}-${step.content}`} className={step.status === "completed" ? "completed" : ""}>{step.content} <small>{step.status?.replaceAll("_", " ")}</small></li>)}</ol></section>}
              {sess.items.map(renderItem)}
              {isBusy && <div className="typing"><i /><i /><i /></div>}
            </div>
          </div>
          {!atBottom && sess.items.length > 0 && <button className="m-jump" aria-label="Jump to latest" data-testid="m-jump" onClick={jumpToEnd}><Icon name="chevronDown" size={18} /></button>}
          <div className="m-composer">
            {(slashQ != null ? shownPrompts.length > 0 : loadingSess !== open && sess.items.length === 0 && !isBusy) && (
              <div className="m-pills" data-testid="m-pills">{slashQ != null ? shownPrompts.map((p) => <button key={p.name} className="m-pill" data-testid="m-prompt" onClick={() => { setDraft(`/${p.name} `); inputRef.current?.focus(); }}>/{p.name}</button>) : SUGGESTIONS.map((t) => <button key={t} className="m-pill" onClick={() => { setDraft(t); inputRef.current?.focus(); }}>{t}</button>)}</div>
            )}
            <div className="m-compose-box">
              {(atts.length > 0 || attErr) && (
                <div className="m-atts" data-testid="m-attachments">
                  {atts.map((a) => (
                    <div key={a.id} className="m-att" data-testid="m-attachment">
                      {a.preview && isImage(a.mime) ? <img src={a.preview} alt={a.name} /> : <span className="m-att-file"><Icon name="file" size={16} /><span>{a.name}</span><small>{fmtSize(a.size)}</small></span>}
                      <button className="m-att-x" aria-label={`Remove ${a.name}`} data-testid="m-attachment-remove" onClick={() => removeAtt(a.id)}><Icon name="x" size={11} /></button>
                    </div>
                  ))}
                  {attErr && <span className="error-text small" data-testid="m-attach-error">{attErr}</span>}
                </div>
              )}
              <div className="m-compose-meta">
                <button type="button" className="m-chip" onClick={() => { haptic(); setNewSheet(true); }}><Icon name="folder" size={13} /> {list.find((s) => s.sessionId === open)?._meta?.project || "Project"}</button>
              </div>
              <textarea ref={inputRef} rows={1} value={draft} placeholder="Message Supercharge…" data-testid="m-input"
                onChange={(e) => { setDraft(e.target.value); const t = e.target; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }}
                onPaste={(e) => { const fs = [...(e.clipboardData?.files ?? [])]; if (fs.length) { e.preventDefault(); void addFiles(fs); } }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!isBusy) void send(); } }} />
              <div className="m-compose-row">
                <input ref={fileInput} type="file" multiple hidden accept="*/*" data-testid="m-attach-input" onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
                <button className="icon m-attach" aria-label="Attach files" data-testid="m-attach" onClick={() => fileInput.current?.click()}><Icon name="plus" size={20} /></button>
                <input ref={photoInput} type="file" multiple hidden accept="image/*" data-testid="m-photo-input" onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
                <button className="icon m-attach" aria-label="Add photo" data-testid="m-photo" onClick={() => photoInput.current?.click()}><Icon name="photo" size={19} /></button>
                {permissionOption && (
                  <span className="m-think-anchor">
                    <button type="button" className="m-chip m-chip-accent" onClick={() => { haptic(); setPermPop((v) => !v); setThinkPop(false); setModePop(false); }}>{optionLabel(permissionOption)}</button>
                    {permPop && (
                      <div className="m-think-pop m-pop-start" role="dialog" aria-label="Access">
                        {permissionOption.options!.map((v) => (
                          <button key={v.value} type="button" className="m-pop-item" aria-pressed={v.value === permissionOption.currentValue} onClick={() => { setPermPop(false); void chooseOption(permissionOption.id, v.value); }}>{v.name ?? v.value}</button>
                        ))}
                      </div>
                    )}
                  </span>
                )}
                {sessionModes && sessionModes.availableModes.length > 1 && (
                  <span className="m-think-anchor">
                    <button type="button" className="m-chip" data-testid="m-mode-chip" onClick={() => { haptic(); setModePop((v) => !v); setPermPop(false); setThinkPop(false); }}>{sessionModes.availableModes.find((x) => x.id === (sess.modeId ?? sessionModes.currentModeId))?.name ?? "Mode"}</button>
                    {modePop && (
                      <div className="m-think-pop m-pop-start" role="dialog" aria-label="Mode">
                        {sessionModes.availableModes.map((m) => (
                          <button key={m.id} type="button" className="m-pop-item" aria-pressed={m.id === (sess.modeId ?? sessionModes.currentModeId)} onClick={() => { setModePop(false); void client.current?.setMode(open!, m.id).then(() => rememberModes(open!, { ...sessionModes, currentModeId: m.id })).catch((e: any) => setToast(`Could not change work mode: ${e?.message ?? e}`)); }}>{m.name}</button>
                        ))}
                      </div>
                    )}
                  </span>
                )}
                <div className="spacer" />
                {open && (ctxBySession[open] || windowBySession[open]) && <ContextMeter used={ctxBySession[open]?.used ?? 0} max={ctxBySession[open]?.max} window={windowCtl} />}
                {modelOption && <button className="m-chip" data-testid="m-model-chip" onClick={() => { haptic(); setModelSearch(""); setPicker("model"); }}>{optionLabel(modelOption)}</button>}
                {thinkingOption && (
                  <span className="m-think-anchor">
                    <button type="button" className="m-chip" data-testid="m-think-chip" onClick={() => { haptic(); setThinkPop((v) => !v); setPermPop(false); setModePop(false); }}>{optionLabel(thinkingOption)}</button>
                    {thinkPop && (
                      <div className="m-think-pop" role="dialog" aria-label="Thinking">
                        <b>{optionLabel(thinkingOption)}</b>
                        <input type="range" aria-label="Thinking level" min={0} max={Math.max(0, (thinkingOption.options?.length ?? 1) - 1)} step={1} disabled={settingOption}
                          value={Math.max(0, thinkingOption.options!.findIndex((v) => v.value === thinkingOption.currentValue))}
                          onChange={(e) => { const choice = thinkingOption.options![Number(e.target.value)]; if (choice) void chooseOption(thinkingOption.id, choice.value); }} />
                      </div>
                    )}
                  </span>
                )}
                {uploading != null && <span className="muted small" data-testid="m-uploading">Uploading {Math.round(uploading * 100)}%</span>}
                {isBusy ? <button className="danger round" aria-label="Stop" onClick={() => { haptic(); client.current?.cancel(open); }}><Icon name="stop" /></button> : <button className="round" aria-label="Send" disabled={!canSend} onClick={() => void send()} data-testid="m-send"><Icon name="send" /></button>}
              </div>
            </div>
          </div>
        </div>
      )}
      {open && sheet && (
        <div className="m-sheet-bg" onClick={() => setSheet(false)}>
          <div className="m-sheet m-settings-sheet" role="dialog" aria-label="Chat settings" data-testid="m-settings-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-grabber" aria-hidden />
            <div className="m-picker-head"><h3>Chat settings</h3><button className="icon" aria-label="Close" data-testid="m-sheet-close" onClick={() => setSheet(false)}><Icon name="x" size={16} /></button></div>
            {modelOption && <button className="m-row" data-testid="m-model" aria-label={`Model: ${optionLabel(modelOption)}`} onClick={() => { setModelSearch(""); setPicker("model"); }}><span>Model</span><b>{optionLabel(modelOption)}</b><Icon name="chevronRight" size={14} /></button>}
            {thinkingOption && (
              <label className="m-row m-thinking">
                <span>Thinking</span>
                <b>{optionLabel(thinkingOption)}</b>
                <input type="range" aria-label="Thinking level" data-testid="m-thinking" min={0} max={Math.max(0, (thinkingOption.options?.length ?? 1) - 1)} step={1} disabled={settingOption}
                  value={Math.max(0, thinkingOption.options!.findIndex((v) => v.value === thinkingOption.currentValue))}
                  onChange={(e) => { haptic(); const choice = thinkingOption.options![Number(e.target.value)]; if (choice) void chooseOption(thinkingOption.id, choice.value); }} />
              </label>
            )}
            {(sessionModes || permissionOption) && <div className="m-row m-row-mode"><span>Mode</span>
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
            <button className="m-row" onClick={() => { setSheet(false); void client.current?.ext("_supercharge/focus", { sessionId: open }); setToast("Opened on your computer"); }}><span>Open on computer</span><Icon name="panelRight" size={15} /></button>
            <div className="m-row m-notify" data-testid="m-notify"><span>Alerts</span>
              <span className="m-notify-opts">
                {([["done", "Done"], ["error", "Errors"], ["permission", "Approvals"], ["sound", "Sound"]] as const).map(([k, label]) => (
                  <label key={k}><input type="checkbox" data-testid={`m-notify-${k}`} checked={notifyPrefs.current[k]} onChange={(e) => { notifyPrefs.current = { ...notifyPrefs.current, [k]: e.target.checked }; try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(notifyPrefs.current)); } catch { /* ignore */ } setFlashMsg((x) => x); setToast(`${label} alerts ${e.target.checked ? "on" : "off"}`); }} /> {label}</label>
                ))}
              </span>
            </div>
          </div>
        </div>
      )}
      {setupOpen && client.current && (
        <div className="m-sheet-bg top" onClick={() => setSetupOpen(false)}>
          <div className="m-sheet m-setup-sheet" role="dialog" aria-label="Provider setup" data-testid="m-setup-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-grabber" aria-hidden />
            <Suspense fallback={<p className="muted">Loading…</p>}><PhoneSetup client={client.current} onClose={() => setSetupOpen(false)} sessionId={() => activeSessionRef.current ?? undefined} /></Suspense>
          </div>
        </div>
      )}
      {confirmDisconnect && (
        <div className="m-sheet-bg top" onClick={() => setConfirmDisconnect(false)}>
          <div className="m-sheet" role="dialog" aria-label="Disconnect" data-testid="m-disconnect-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="m-grabber" aria-hidden />
            <h3>Disconnect this phone?</h3>
            <p className="muted">It forgets this computer. Connecting again needs a new pairing code.</p>
            <button className="m-big danger" data-testid="m-disconnect-yes" onClick={() => { saveCreds(null); setCreds(null); setConfirmDisconnect(false); setDrawer(false); }}>Disconnect</button>
            <button className="m-big secondary" onClick={() => setConfirmDisconnect(false)}>Cancel</button>
          </div>
        </div>
      )}
      {newSheet && (
        <div className="m-sheet-bg" onClick={() => { setNewSheet(false); setProjectQuery(""); }}>
          <div className="m-sheet" role="dialog" aria-label="New chat in" data-testid="m-new-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-grabber" aria-hidden />
            <div className="m-picker-head"><h3>New chat in…</h3><button className="icon" aria-label="Close" onClick={() => { setNewSheet(false); setProjectQuery(""); }}><Icon name="x" size={16} /></button></div>
            <label className="m-search m-project-search"><Icon name="search" size={15} /><input type="search" placeholder="Search projects" aria-label="Search projects" data-testid="m-new-search" value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} /></label>
            <div className="m-project-list">
              {allProjects.filter((p) => `${p.name} ${p.group}`.toLowerCase().includes(projectQuery.trim().toLowerCase())).map((p) => (
                <button key={p.projectId} className="m-row" data-testid="m-new-in" onClick={() => { setNewSheet(false); setProjectQuery(""); void newChat(p); }}><Icon name="folder" size={15} /><span>{p.name}</span><small className="muted">{p.group}</small></button>
              ))}
              {allProjects.every((p) => !`${p.name} ${p.group}`.toLowerCase().includes(projectQuery.trim().toLowerCase())) && <p className="muted m-none">No projects match “{projectQuery}”.</p>}
            </div>
          </div>
        </div>
      )}
      {open && activeOption && (
        <div className="m-sheet-bg top" onClick={() => setPicker(null)}>
          <div className="m-sheet m-config-sheet" role="dialog" aria-label={picker === "model" ? "Choose model" : "Choose reasoning"} data-testid="m-config-picker" onClick={(e) => e.stopPropagation()}>
            <div className="m-grabber" aria-hidden />
            <div className="m-picker-head"><h3>{picker === "model" ? "Model" : "Reasoning"}</h3><button className="icon" aria-label="Close picker" onClick={() => setPicker(null)}><Icon name="x" size={16} /></button></div>
            {picker === "model" && <input type="search" aria-label="Search models" placeholder="Search models" value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} />}
            <div className="m-picker-options">
              {(activeOption.options ?? []).filter((v) => picker !== "model" || `${v.name ?? ""} ${v.value}`.toLowerCase().includes(modelSearch.trim().toLowerCase())).map((v) => (
                <button key={v.value} className="m-picker-option" aria-pressed={v.value === activeOption.currentValue} disabled={settingOption} onClick={() => { haptic(); void chooseOption(activeOption.id, v.value); }}>
                  <span>{v.name || v.value}</span>{v.value === activeOption.currentValue && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {perm && (
        <div className="m-sheet-bg top">
          <div className="m-sheet" role="dialog" aria-label="Permission request" data-testid="m-perm">
            <div className="m-grabber" aria-hidden />
            <div className="m-perm-head"><span className="m-perm-icon" aria-hidden><Icon name="alert" size={18} /></span><div><h3>Allow this action?</h3>{permQueue.length > 1 && <small className="muted">{permQueue.length - 1} more waiting</small>}</div></div>
            <p className="m-perm-title">{perm.req.toolCall.title ?? perm.req.toolCall.toolCallId}</p>
            {perm.req.toolCall.rawInput != null && <details className="m-perm-details"><summary>Details</summary><pre className="mono">{JSON.stringify(perm.req.toolCall.rawInput, null, 2)}</pre></details>}
            {perm.req.options.map((o) => (
              <button key={o.optionId} className={`m-big ${o.kind.startsWith("reject") ? "secondary" : ""}`} onClick={() => { haptic(12); perm.resolve({ outcome: "selected", optionId: o.optionId }); setPermQueue((pending) => pending.filter((item) => item !== perm)); }}>{o.name}</button>
            ))}
          </div>
        </div>
      )}
      {toast && <div className="m-toast">{toast}</div>}
    </div>
  );
}

/** Within 80px of the end counts as "at the bottom", so streaming keeps following. */
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, slack = 80): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

export function connLabel(c: ConnectionState): string {
  return c === "connecting" ? "Connecting…" : c === "reconnecting" ? "Connection lost, reconnecting…" : "Offline";
}

/** The phone's Wi-Fi IPv4 address from the native side, if available (used only for error messages). */
async function phoneIp(): Promise<string | undefined> {
  try {
    if (!isDesktop()) return undefined;
    return (await invoke<string | null>("local_ipv4")) ?? undefined;
  } catch { return undefined; }
}
