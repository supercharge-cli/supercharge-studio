/** Agent-event notifications: gating (pure) plus delivery on desktop, Android and web. */
export type NotifyKind = "done" | "error" | "permission";
export type NotifyPrefs = { done: boolean; error: boolean; permission: boolean; sound: boolean };
export const defaultNotifyPrefs: NotifyPrefs = { done: true, error: true, permission: true, sound: true };
export type NotifyEvent = { kind: NotifyKind; chatId: string; title: string; body: string };

/**
 * Notify only when the user can't already see it: the window is unfocused / hidden,
 * or a different chat is on screen.
 */
export function shouldNotify(kind: NotifyKind, prefs: NotifyPrefs | undefined, ctx: { focused: boolean; visible: boolean; activeChatId?: string; chatId: string }): boolean {
  const p = { ...defaultNotifyPrefs, ...prefs };
  if (!p[kind]) return false;
  if (!ctx.visible || !ctx.focused) return true;
  return ctx.activeChatId !== ctx.chatId;
}

export const notifyTitle = (kind: NotifyKind, chat: string) =>
  kind === "done" ? `Done · ${chat}` : kind === "error" ? `Error · ${chat}` : `Needs your approval · ${chat}`;

export const clip = (s: string, n = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** Short-lived dedupe so a burst (e.g. several permission prompts) shows one alert per chat+kind. */
export class Deduper {
  private last = new Map<string, number>();
  constructor(private ms = 4000, private now = () => Date.now()) {}
  ok(key: string): boolean {
    const t = this.now(), p = this.last.get(key);
    if (p != null && t - p < this.ms) return false;
    this.last.set(key, t);
    return true;
  }
}

export const pageContext = () => ({
  focused: typeof document !== "undefined" ? document.hasFocus() : true,
  visible: typeof document !== "undefined" ? document.visibilityState !== "hidden" : true,
});
