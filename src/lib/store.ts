/** Local app data: groups → projects → chats. Persisted to localStorage. */
export type Chat = { id: string; title: string; sessionId?: string; createdAt: number };
export type Project = { id: string; name: string; cwd: string; chats: Chat[] };
export type Group = { id: string; name: string; collapsed?: boolean; projects: Project[] };
export type Settings = {
  bind: string;
  secret: string;
  transport: "ws" | "stdio";
  autoStart: boolean;
  alwaysApprove: boolean;
};
export type AppData = { groups: Group[]; settings: Settings; activeProjectId?: string; activeChatId?: string };

const KEY = "supercharge-studio/v1";
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const defaultData = (): AppData => ({
  groups: [{ id: uid(), name: "Personal", projects: [{ id: uid(), name: "workspace", cwd: "/workspace", chats: [] }] }],
  settings: { bind: "127.0.0.1:2419", secret: "dev-secret", transport: "ws", autoStart: true, alwaysApprove: true },
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
