/**
 * Side browser the agent can see and control.
 *
 * The app advertises client-side ACP extension methods in
 * `clientCapabilities._meta.supercharge.browser.methods`; the agent calls them as
 * normal JSON-RPC requests (agent → client):
 *
 *   _supercharge/browser/navigate  { url }                 → { url }
 *   _supercharge/browser/snapshot  {}                      → { url, title, text, elements[] }
 *   _supercharge/browser/click     { ref } | { selector }  → { ok }
 *   _supercharge/browser/type      { ref|selector, text, submit? } → { ok }
 *   _supercharge/browser/scroll    { dy }                  → { ok }
 *   _supercharge/browser/eval      { expression }          → { value }
 *   _supercharge/browser/back      {}                      → { ok }
 *
 * `elements[].ref` values come from the latest snapshot.
 */
import type { AcpClient } from "../acp/client";
import { invoke, isDesktop } from "../lib/desktop";

export const BROWSER_METHODS = ["navigate", "snapshot", "click", "type", "scroll", "eval", "back"].map(
  (m) => `_supercharge/browser/${m}`,
);

export const browserClientMeta = () => ({
  supercharge: { browser: { methods: BROWSER_METHODS, available: isDesktop() } },
});

export type Bounds = { x: number; y: number; width: number; height: number };

/** Page-side helpers, inlined into every evaluated script. */
const HELPERS = `
const __sc = window.__sc || (window.__sc = {
  find(a) {
    if (a.ref != null) { const el = document.querySelector('[data-sc-ref="' + a.ref + '"]'); if (el) return el; }
    if (a.selector) { const el = document.querySelector(a.selector); if (el) return el; }
    throw new Error("element not found");
  },
  snapshot() {
    let n = 0; const els = [];
    for (const el of document.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]')) {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
      const ref = ++n; el.setAttribute('data-sc-ref', String(ref));
      els.push({ ref, tag: el.tagName.toLowerCase(), type: el.type || undefined,
        text: (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 80),
        href: el.href || undefined });
      if (n >= 200) break;
    }
    return { url: location.href, title: document.title, text: (document.body.innerText || '').slice(0, 8000), elements: els };
  }
});`;

export class BrowserController {
  url = "about:blank";
  bounds: Bounds | null = null;
  listeners = new Set<(url: string) => void>();

  private emit() {
    this.listeners.forEach((l) => l(this.url));
  }

  async open(url: string, bounds: Bounds) {
    this.bounds = bounds;
    this.url = url;
    if (isDesktop()) await invoke("browser_open", { url, bounds });
    this.emit();
  }
  async setBounds(bounds: Bounds) {
    this.bounds = bounds;
    if (isDesktop()) await invoke("browser_set_bounds", { bounds }).catch(() => {});
  }
  async hide() {
    if (isDesktop()) await invoke("browser_close").catch(() => {});
  }
  async navigate(url: string) {
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    this.url = url;
    if (isDesktop()) {
      if (this.bounds) await invoke("browser_open", { url, bounds: this.bounds });
      else await invoke("browser_navigate", { url });
    }
    this.emit();
    return { url };
  }
  async evaluate(expression: string): Promise<any> {
    if (!isDesktop()) throw new Error("Side browser control needs the desktop app");
    const raw = await invoke<string>("browser_eval", { script: `(${HELPERS.trim()}, (${expression}))` });
    const out = JSON.parse(raw);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }

  /** Register agent → client handlers on an ACP client. */
  attach(client: AcpClient) {
    const h = (m: string, fn: (p: any) => unknown) => client.handle(`_supercharge/browser/${m}`, fn);
    const target = (p: any) => JSON.stringify({ ref: p?.ref ?? null, selector: p?.selector ?? null });
    h("navigate", (p) => this.navigate(String(p?.url ?? "")));
    h("snapshot", () => this.evaluate("__sc.snapshot()"));
    h("click", async (p) => ({ ok: await this.evaluate(`(__sc.find(${target(p)}).click(), true)`) }));
    h("type", async (p) => ({
      ok: await this.evaluate(
        `(() => { const el = __sc.find(${target(p)}); el.focus();
          const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
          if (set) set.call(el, ${JSON.stringify(String(p?.text ?? ""))}); else el.textContent = ${JSON.stringify(String(p?.text ?? ""))};
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          ${p?.submit ? "(el.form ? el.form.requestSubmit() : el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));" : ""}
          return true; })()`,
      ),
    }));
    h("scroll", async (p) => ({ ok: await this.evaluate(`(window.scrollBy(0, ${Number(p?.dy ?? 600)}), true)`) }));
    h("eval", async (p) => ({ value: await this.evaluate(String(p?.expression ?? "undefined")) }));
    h("back", async () => ({ ok: await this.evaluate("(history.back(), true)") }));
  }
}

export const browser = new BrowserController();
