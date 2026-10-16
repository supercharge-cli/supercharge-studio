/** Delivery for agent-event notifications (lazy-loaded). Desktop: notification plugin; web: Notification API. */
import { isDesktop, invoke } from "./desktop";
import { clip, Deduper, pageContext, shouldNotify, notifyTitle, type NotifyEvent, type NotifyPrefs } from "./notify";

const dedupe = new Deduper();
let granted: boolean | null = null;
/** Chat of the last alert; focusing the window soon after opens it (desktop alerts can't report clicks everywhere). */
export let pending: { chatId: string; at: number } | null = null;
export const takePending = (withinMs = 120000) => { const p = pending; pending = null; return p && Date.now() - p.at < withinMs ? p.chatId : null; };

async function permitted(): Promise<boolean> {
  if (granted != null) return granted;
  if (isDesktop()) {
    granted = await invoke<boolean>("plugin:notification|is_permission_granted").catch(() => false);
    if (!granted) granted = (await invoke<string>("plugin:notification|request_permission").catch(() => "denied")) === "granted";
  } else if (typeof Notification !== "undefined") {
    granted = Notification.permission === "granted" || (Notification.permission !== "denied" && (await Notification.requestPermission()) === "granted");
  } else granted = false;
  return granted;
}

export async function deliver(ev: NotifyEvent, prefs: NotifyPrefs | undefined, activeChatId: string | undefined, chatTitle: string): Promise<boolean> {
  if (!shouldNotify(ev.kind, prefs, { ...pageContext(), activeChatId, chatId: ev.chatId })) return false;
  if (!dedupe.ok(`${ev.chatId}:${ev.kind}`)) return false;
  if (!(await permitted())) return false;
  const title = notifyTitle(ev.kind, chatTitle);
  const body = clip(ev.body);
  const sound = prefs?.sound !== false;
  pending = { chatId: ev.chatId, at: Date.now() };
  if (isDesktop()) {
    await invoke("plugin:notification|notify", { options: { title, body, ...(sound ? { sound: "default" } : {}) } }).catch(() => {});
  } else {
    const n = new Notification(title, { body, silent: !sound, tag: `${ev.chatId}:${ev.kind}` });
    n.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent("supercharge:open-chat", { detail: ev.chatId })); n.close(); };
  }
  return true;
}
