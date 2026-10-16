/** Local app data: groups → projects → chats. Persisted to localStorage. */
import { DEFAULT_RELAY, ensureHostId, reachOf, type Reach } from "./reach";
/** `updatedAt`: last activity (ms). `cli`: discovered from the agent's session list (the CLI owns it). `cwd`: the session's own folder. */
export type Chat = { id: string; title: string; sessionId?: string; createdAt: number; updatedAt?: number; cli?: boolean; cwd?: string;
  /** Set when the chat runs in its own git worktree (cwd = path). */
  worktree?: { path: string; branch: string; base: string; root: string } };
export type Project = { id: string; name: string; cwd: string; chats: Chat[] };
export type Group = { id: string; name: string; collapsed?: boolean; projects: Project[] };
export type ApiFormat = "responses" | "chat_completions" | "messages";
export type Provider = { id: string; name: string; baseUrl: string; format: ApiFormat; models: string[] };
/** A theme id from lib/themes (or "system"). */
export type Theme = string;

export type GatewayPrefs = { enabled: boolean; mode: "lan" | "tunnel"; port: number; publicUrl: string; relayUrl?: string; hostId?: string; reach?: Reach };
export const defaultGatewayPrefs: GatewayPrefs = { enabled: false, mode: "lan", port: 2420, publicUrl: "", relayUrl: DEFAULT_RELAY, reach: "public" };
const gatewayPrefs = (saved?: GatewayPrefs): GatewayPrefs => ensureHostId({ ...defaultGatewayPrefs, ...saved, reach: saved ? reachOf(saved) : "public" });

export type Settings = {
  /** Model last picked in the composer; new chats start with it when the agent offers it. */
  lastModel?: string;
  bind: string;
  secret: string;
  transport: "ws" | "stdio";
  autoStart: boolean;
  alwaysApprove: boolean;
  /** Messages sent while the agent works steer the running turn instead of waiting in the queue. */
  steerByDefault?: boolean;
  /** Server key lives in the OS keychain; `secret` is then kept empty on disk. */
  secretInKeychain?: boolean;
  providers?: Provider[];
  activeProviderId?: string;
  theme?: Theme;
  onboarded?: boolean;
  /** When the agent at `bind` rejects our key: "own" = run our own managed agent on `ownBind` (default), "key" = use the key the user entered. */
  agentChoice?: "own" | "key";
  ownBind?: string;
  gateway?: GatewayPrefs;
  /** Agent-event notifications (all on when absent). */
  notify?: { done: boolean; error: boolean; permission: boolean; sound: boolean };
};
export type AppData = {
  groups: Group[];
  settings: Settings;
  activeProjectId?: string;
  activeChatId?: string;
  /** Data format version (2 = synced with the CLI session list). */
  schema?: number;
  /** Sidebar layout: "projects" (one entry per folder, like the CLI) or "groups" (app-only groups). */
  sidebarView?: "projects" | "groups" | "recents";
  /** CLI sessions the user removed from the sidebar (never re-added by sync). */
  hiddenSessions?: string[];
};

/** Group that receives projects discovered from the CLI session list. */
export const CLI_GROUP = "Supercharge CLI";

const KEY = "supercharge-studio/v1";
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const defaultData = (): AppData => ({
  groups: [{ id: uid(), name: "Personal", projects: [{ id: uid(), name: "workspace", cwd: "/workspace", chats: [] }] }],
  schema: 2,
  sidebarView: "projects",
  hiddenSessions: [],
  settings: { bind: "127.0.0.1:2419", secret: "dev-secret", transport: "ws", autoStart: true, alwaysApprove: true, providers: [], theme: "dark" },
});

export function load(): AppData {
  try {
    const raw = localStorage.getItem(KEY);
    const data = raw ? migrate({ ...defaultData(), ...JSON.parse(raw) }) : defaultData();
    const gateway = gatewayPrefs(data.settings.gateway);
    if (JSON.stringify(data.settings.gateway) !== JSON.stringify(gateway)) {
      data.settings = { ...data.settings, gateway };
      try { save(data); } catch { /* storage may be unavailable */ }
    }
    return data;
  } catch {
    return defaultData();
  }
}
/** Upgrade older saved data in place; never drops chats, projects or groups. */
export function migrate(d: AppData): AppData {
  if ((d.schema ?? 1) >= 2) return d;
  return {
    ...d,
    schema: 2,
    sidebarView: d.sidebarView ?? "projects",
    hiddenSessions: d.hiddenSessions ?? [],
    groups: (d.groups ?? []).map((g) => ({ ...g, projects: (g.projects ?? []).map((p) => ({ ...p, chats: (p.chats ?? []).map((c) => ({ ...c, updatedAt: c.updatedAt ?? c.createdAt })) })) })),
  };
}

export const save = (d: AppData) => localStorage.setItem(KEY, JSON.stringify(d));
export const wsUrl = (s: Settings) => `ws://${s.bind}/ws?server-key=${encodeURIComponent(s.secret)}`;

export function findProject(d: AppData, id?: string) {
  for (const g of d.groups) for (const p of g.projects) if (p.id === id) return { group: g, project: p };
  return null;
}

/** Immutable update helper for a project. */
export function mapProject(d: AppData, id: string, fn: (p: Project) => Project): AppData {
  return { ...d, groups: d.groups.map((g) => ({ ...g, projects: g.projects.map((p) => (p.id === id ? fn(p) : p)) })) };
}

/** Sidebar tree mutations (pure). */
export type TreeAction =
  | { type: "addGroup"; name: string }
  | { type: "renameGroup"; groupId: string; name: string }
  | { type: "removeGroup"; groupId: string }
  | { type: "toggleGroup"; groupId: string }
  | { type: "addProject"; groupId: string; name: string; cwd: string }
  | { type: "renameProject"; projectId: string; name: string }
  | { type: "removeProject"; projectId: string }
  | { type: "renameChat"; chatId: string; title: string }
  | { type: "removeChat"; chatId: string };

const mapChats = (d: AppData, fn: (c: Chat[]) => Chat[]): AppData => ({
  ...d,
  groups: d.groups.map((g) => ({ ...g, projects: g.projects.map((p) => ({ ...p, chats: fn(p.chats) })) })),
});

export function applyTree(d: AppData, a: TreeAction): AppData {
  switch (a.type) {
    case "addGroup":
      return { ...d, groups: [...d.groups, { id: uid(), name: a.name, projects: [] }] };
    case "renameGroup":
      return { ...d, groups: d.groups.map((g) => (g.id === a.groupId ? { ...g, name: a.name } : g)) };
    case "removeGroup": {
      const g = d.groups.find((x) => x.id === a.groupId);
      const gone = new Set(g?.projects.map((p) => p.id));
      return {
        ...d,
        groups: d.groups.filter((x) => x.id !== a.groupId),
        ...(gone.has(d.activeProjectId ?? "") ? { activeProjectId: undefined, activeChatId: undefined } : {}),
      };
    }
    case "toggleGroup":
      return { ...d, groups: d.groups.map((g) => (g.id === a.groupId ? { ...g, collapsed: !g.collapsed } : g)) };
    case "addProject": {
      const p: Project = { id: uid(), name: a.name, cwd: a.cwd, chats: [] };
      return {
        ...d,
        activeProjectId: p.id,
        activeChatId: undefined,
        groups: d.groups.map((g) => (g.id === a.groupId ? { ...g, collapsed: false, projects: [...g.projects, p] } : g)),
      };
    }
    case "renameProject":
      return mapProject(d, a.projectId, (p) => ({ ...p, name: a.name }));
    case "removeProject": {
      const sids = d.groups.flatMap((g) => g.projects).filter((p) => p.id === a.projectId).flatMap((p) => p.chats.map((c) => c.sessionId).filter(Boolean) as string[]);
      return {
        ...d,
        hiddenSessions: [...new Set([...(d.hiddenSessions ?? []), ...sids])],
        groups: d.groups.map((g) => ({ ...g, projects: g.projects.filter((p) => p.id !== a.projectId) })),
        ...(d.activeProjectId === a.projectId ? { activeProjectId: undefined, activeChatId: undefined } : {}),
      };
    }
    case "renameChat":
      return mapChats(d, (cs) => cs.map((c) => (c.id === a.chatId ? { ...c, title: a.title } : c)));
    case "removeChat": {
      const sid = d.groups.flatMap((g) => g.projects.flatMap((p) => p.chats)).find((c) => c.id === a.chatId)?.sessionId;
      return {
        ...mapChats(d, (cs) => cs.filter((c) => c.id !== a.chatId)),
        ...(sid ? { hiddenSessions: [...new Set([...(d.hiddenSessions ?? []), sid])] } : {}),
        ...(d.activeChatId === a.chatId ? { activeChatId: undefined } : {}),
      };
    }
  }
}

/** Accept "host:port" or a full agent URL like ws://127.0.0.1:2419/ws?server-key=abc. */
export function parseAgentUrl(text: string): { bind?: string; secret?: string } {
  const t = text.trim();
  if (!/^wss?:\/\//i.test(t)) return {};
  try {
    const u = new URL(t);
    return { bind: u.host || undefined, secret: u.searchParams.get("server-key") ?? undefined };
  } catch {
    return {};
  }
}

// ---------- CLI session sync ----------

/** One entry of the agent's session/list. */
export type CliSession = { sessionId: string; cwd?: string; title?: string | null; updatedAt?: string; createdAt?: string };

export const normCwd = (c: string) => (c.length > 1 ? c.replace(/[\\/]+$/, "") : c);
export const folderName = (cwd: string) => normCwd(cwd).split(/[\\/]/).filter(Boolean).pop() || cwd;
const ts = (s?: string) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : undefined; };

/**
 * Merge the CLI's sessions into the tree (pure). Known sessions get their activity time and
 * title refreshed; new ones are added under the project for their cwd, creating the project
 * (in the "Supercharge CLI" group) when no project uses that folder yet. Hidden sessions are skipped.
 */
export function mergeCliSessions(d: AppData, list: CliSession[]): AppData {
  const hidden = new Set(d.hiddenSessions ?? []);
  const groups = d.groups.map((g) => ({ ...g, projects: g.projects.map((p) => ({ ...p, chats: [...p.chats] })) }));
  const bySid = new Map<string, Chat>();
  const byCwd = new Map<string, Project>();
  for (const g of groups) for (const p of g.projects) {
    if (!byCwd.has(normCwd(p.cwd))) byCwd.set(normCwd(p.cwd), p);
    p.chats.forEach((c, i) => { if (c.sessionId) { const n = { ...c }; p.chats[i] = n; bySid.set(c.sessionId, n); } });
  }
  let changed = false;
  for (const s of list) {
    if (!s.sessionId || !s.cwd || hidden.has(s.sessionId)) continue;
    const up = ts(s.updatedAt) ?? ts(s.createdAt) ?? Date.now();
    const title = s.title?.trim() ? s.title.trim().slice(0, 60) : undefined;
    const known = bySid.get(s.sessionId);
    if (known) {
      if (known.updatedAt !== up) { known.updatedAt = up; changed = true; }
      if (known.cwd !== s.cwd) { known.cwd = s.cwd; changed = true; }
      if (title && known.title !== title && (known.cli || known.title === "New chat")) { known.title = title; changed = true; }
      continue;
    }
    let proj = byCwd.get(normCwd(s.cwd));
    if (!proj) {
      let g = groups.find((x) => x.name === CLI_GROUP);
      if (!g) { g = { id: uid(), name: CLI_GROUP, projects: [] }; groups.push(g); }
      proj = { id: uid(), name: folderName(s.cwd), cwd: normCwd(s.cwd), chats: [] };
      g.projects.push(proj);
      byCwd.set(normCwd(s.cwd), proj);
    }
    const chat: Chat = { id: uid(), title: title ?? "Untitled chat", sessionId: s.sessionId, createdAt: ts(s.createdAt) ?? up, updatedAt: up, cli: true, cwd: s.cwd };
    proj.chats.push(chat);
    bySid.set(s.sessionId, chat);
    changed = true;
  }
  if (!changed) return d;
  for (const g of groups) for (const p of g.projects) p.chats.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  return { ...d, groups };
}

/** One sidebar entry per folder (the CLI's view): chats from every project with that cwd, newest first. */
export type FolderView = { cwd: string; name: string; projectId: string; chats: { projectId: string; chat: Chat }[]; updatedAt: number };
export function projectsByCwd(d: AppData): FolderView[] {
  const m = new Map<string, FolderView>();
  for (const g of d.groups) for (const p of g.projects) {
    const k = normCwd(p.cwd);
    let f = m.get(k);
    if (!f) { f = { cwd: k, name: p.name || folderName(k), projectId: p.id, chats: [], updatedAt: 0 }; m.set(k, f); }
    for (const c of p.chats) { f.chats.push({ projectId: p.id, chat: c }); f.updatedAt = Math.max(f.updatedAt, c.updatedAt ?? c.createdAt); }
  }
  const out = [...m.values()];
  for (const f of out) f.chats.sort((a, b) => (b.chat.updatedAt ?? b.chat.createdAt) - (a.chat.updatedAt ?? a.chat.createdAt));
  return out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/** Every chat across projects, most recent activity first (sidebar Recents). */
export type RecentChat = { projectId: string; projectName: string; chat: Chat; at: number };
export function recentChats(d: AppData): RecentChat[] {
  const out: RecentChat[] = [];
  for (const g of d.groups) for (const p of g.projects) for (const c of p.chats)
    out.push({ projectId: p.id, projectName: p.name || folderName(normCwd(p.cwd)), chat: c, at: c.updatedAt ?? c.createdAt });
  return out.sort((a, b) => b.at - a.at);
}

/** Sidebar width, persisted on this device. */
export const SIDEBAR_MIN = 180, SIDEBAR_MAX = 480, SIDEBAR_DEFAULT = 264;
const SW_KEY = "supercharge-studio/sidebar-width";
export const clampSidebar = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
export function loadSidebarWidth(): number {
  try { const n = Number(localStorage.getItem(SW_KEY)); return n ? clampSidebar(n) : SIDEBAR_DEFAULT; } catch { return SIDEBAR_DEFAULT; }
}
export function saveSidebarWidth(w: number) { try { localStorage.setItem(SW_KEY, String(clampSidebar(w))); } catch { /* ignore */ } }

/** "now", "5m", "3h", "2d", "4w", then a date. */
export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 35) return `${Math.floor(s / 86400 / 7)}w`;
  return new Date(ms).toLocaleDateString();
}

/** Find the project for a folder, or add one (in the CLI group) and return its id. */
export function ensureFolderProject(d: AppData, cwd: string): { data: AppData; projectId: string } {
  const k = normCwd(cwd.trim());
  for (const g of d.groups) for (const p of g.projects) if (normCwd(p.cwd) === k) return { data: d, projectId: p.id };
  const proj: Project = { id: uid(), name: folderName(k), cwd: k, chats: [] };
  const has = d.groups.some((g) => g.name === CLI_GROUP);
  const groups = has ? d.groups.map((g) => (g.name === CLI_GROUP ? { ...g, projects: [...g.projects, proj] } : g)) : [...d.groups, { id: uid(), name: CLI_GROUP, projects: [proj] }];
  return { data: { ...d, groups }, projectId: proj.id };
}
