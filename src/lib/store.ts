/** Local app data: groups → projects → chats. Persisted to localStorage. */
export type Chat = { id: string; title: string; sessionId?: string; createdAt: number };
export type Project = { id: string; name: string; cwd: string; chats: Chat[] };
export type Group = { id: string; name: string; collapsed?: boolean; projects: Project[] };
export type ApiFormat = "responses" | "chat_completions" | "messages";
export type Provider = { id: string; name: string; baseUrl: string; format: ApiFormat; models: string[] };
export type Theme = "dark" | "light" | "system";

export type Settings = {
  bind: string;
  secret: string;
  transport: "ws" | "stdio";
  autoStart: boolean;
  alwaysApprove: boolean;
  /** Server key lives in the OS keychain; `secret` is then kept empty on disk. */
  secretInKeychain?: boolean;
  providers?: Provider[];
  activeProviderId?: string;
  theme?: Theme;
};
export type AppData = { groups: Group[]; settings: Settings; activeProjectId?: string; activeChatId?: string };

const KEY = "supercharge-studio/v1";
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const defaultData = (): AppData => ({
  groups: [{ id: uid(), name: "Personal", projects: [{ id: uid(), name: "workspace", cwd: "/workspace", chats: [] }] }],
  settings: { bind: "127.0.0.1:2419", secret: "dev-secret", transport: "ws", autoStart: true, alwaysApprove: true, providers: [], theme: "dark" },
});

export function load(): AppData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultData(), ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return defaultData();
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
    case "removeProject":
      return {
        ...d,
        groups: d.groups.map((g) => ({ ...g, projects: g.projects.filter((p) => p.id !== a.projectId) })),
        ...(d.activeProjectId === a.projectId ? { activeProjectId: undefined, activeChatId: undefined } : {}),
      };
    case "renameChat":
      return mapChats(d, (cs) => cs.map((c) => (c.id === a.chatId ? { ...c, title: a.title } : c)));
    case "removeChat":
      return {
        ...mapChats(d, (cs) => cs.filter((c) => c.id !== a.chatId)),
        ...(d.activeChatId === a.chatId ? { activeChatId: undefined } : {}),
      };
  }
}
