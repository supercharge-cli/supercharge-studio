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
 *   _supercharge/browser/screenshot {}                     → { mimeType, data } (base64 PNG)
 *                                    or { fallback: "snapshot", ...snapshot } if capture fails
 *
 * `elements[].ref` values come from the latest snapshot.
 */
import type { AcpClient } from "../acp/client";
import { invoke, isDesktop, listen } from "../lib/desktop";

export const BROWSER_METHODS = ["navigate", "snapshot", "screenshot", "click", "type", "scroll", "eval", "back"].map(
  (m) => `_supercharge/browser/${m}`,
);

export const browserClientMeta = () => ({
  supercharge: { browser: { methods: BROWSER_METHODS, available: isDesktop() } },
});

export type Bounds = { x: number; y: number; width: number; height: number };

/** Page-side helpers, inlined into every evaluated script. */
const HELPERS = `
(window.__sc = window.__sc || {
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
})`;

/** Script sent to the page: installs helpers, then evaluates `expression`. */
export const wrapScript = (expression: string) => `(${HELPERS.trim()}, (${expression}))`;

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
  async setVisible(visible: boolean) {
    if (isDesktop()) await invoke("browser_set_visible", { visible }).catch(() => {});
  }
  async hide() {
    if (isDesktop()) await invoke("browser_close").catch(() => {});
  }
  async navigate(url: string) {
    url = url.trim();
    if (!/^([a-z][a-z0-9+.-]*:\/\/|data:|about:)/i.test(url)) url = `https://${url}`;
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
    const raw = await invoke<string>("browser_eval", { script: wrapScript(expression) });
    const out = JSON.parse(raw);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }

  /** Native PNG capture; falls back to a text snapshot when unavailable. */
  async screenshot(): Promise<{ mimeType: string; data: string } | { fallback: "snapshot"; error: string; [k: string]: unknown }> {
    try {
      if (!isDesktop()) throw new Error("Screenshots need the desktop app");
      const data = await invoke<string>("browser_screenshot");
      return { mimeType: "image/png", data };
    } catch (e: any) {
      const snap = await this.evaluate("__sc.snapshot()").catch(() => ({}));
      return { fallback: "snapshot", error: String(e?.message ?? e), ...snap };
    }
  }

  /** Run one browser operation by short name (shared by ACP extensions and MCP tools). */
  async run(op: string, p: any): Promise<any> {
    const target = JSON.stringify({ ref: p?.ref ?? null, selector: p?.selector ?? null });
    switch (op) {
      case "navigate":
        return this.navigate(String(p?.url ?? ""));
      case "snapshot":
        return this.evaluate("__sc.snapshot()");
      case "screenshot":
        return this.screenshot();
      case "click":
        return { ok: await this.evaluate(`(__sc.find(${target}).click(), true)`) };
      case "type": {
        const text = JSON.stringify(String(p?.text ?? ""));
        return {
          ok: await this.evaluate(
            `(() => { const el = __sc.find(${target}); el.focus();
              const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
              if (set) set.call(el, ${text}); else el.textContent = ${text};
              el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
              ${p?.submit ? "(el.form ? el.form.requestSubmit() : el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));" : ""}
              return true; })()`,
          ),
        };
      }
      case "scroll":
        return { ok: await this.evaluate(`(window.scrollBy(0, ${Number(p?.dy ?? 600)}), true)`) };
      case "eval":
        return { value: await this.evaluate(String(p?.expression ?? "undefined")) };
      case "back":
        return { ok: await this.evaluate("(history.back(), true)") };
      default:
        throw new Error(`unknown browser operation: ${op}`);
    }
  }

  /** Serve MCP tool calls forwarded by the desktop shell (see src-tauri/src/mcp.rs). */
  async serveMcp() {
    return listen<{ id: number; name: string; arguments: any }>("mcp://call", async ({ id, name, arguments: args }) => {
      let result: any;
      try {
        const out = await this.run(name.replace(/^browser_/, ""), args);
        result =
          out && typeof out.data === "string" && out.mimeType
            ? { content: [{ type: "image", data: out.data, mimeType: out.mimeType }] }
            : { content: [{ type: "text", text: JSON.stringify(out) }] };
      } catch (e: any) {
        result = { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] };
      }
      await invoke("mcp_result", { id, result }).catch(() => {});
    });
  }

  /** Register agent → client handlers on an ACP client. */
  attach(client: AcpClient) {
    for (const m of BROWSER_METHODS) {
      const op = m.slice("_supercharge/browser/".length);
      client.handle(m, (p) => this.run(op, p));
    }
  }
}

export const browser = new BrowserController();
