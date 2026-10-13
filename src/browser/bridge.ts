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

export const BROWSER_OPS = ["navigate", "snapshot", "screenshot", "click", "type", "press_key", "select_option", "hover", "scroll", "wait_for", "tabs", "eval", "back", "forward", "reload"];
export const BROWSER_METHODS = BROWSER_OPS.map(
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
    if (a.ref != null) {
      const el = document.querySelector('[data-sc-ref="' + a.ref + '"]');
      if (el) return el;
      throw new Error("ref " + a.ref + " not found (the page changed): take a new browser_snapshot");
    }
    if (a.selector) { const el = document.querySelector(a.selector); if (el) return el; throw new Error("no element matches " + a.selector); }
    if (a.text) {
      const t = String(a.text).toLowerCase();
      for (const el of document.querySelectorAll('a,button,input,textarea,select,summary,label,[role],[onclick],[tabindex]'))
        if (__sc.name(el).toLowerCase().includes(t) && __sc.visible(el)) return el;
      throw new Error("no element with text " + JSON.stringify(a.text));
    }
    throw new Error("give ref (from browser_snapshot), selector or text");
  },
  visible(el) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; },
  role(el) {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase(), ty = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'input') return ({ button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox' })[ty] || (ty === 'hidden' ? 'none' : 'textbox');
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    return ({ nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', dialog: 'dialog', img: 'img', ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', option: 'option', label: 'label', p: 'paragraph' })[t] || '';
  },
  name(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) { const s = by.split(/\\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ').trim(); if (s) return s; }
    const al = el.getAttribute('aria-label'); if (al) return al.trim();
    if (el.labels && el.labels.length) return [...el.labels].map((l) => l.innerText).join(' ').trim();
    if (el.tagName === 'IMG') return el.alt || el.title || '';
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return el.value || el.type;
    const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return (txt || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 100);
  },
  snapshot() {
    document.querySelectorAll('[data-sc-ref]').forEach((e) => e.removeAttribute('data-sc-ref'));
    let n = 0; const els = []; const lines = [];
    const INTER = new Set(['link','button','textbox','searchbox','checkbox','radio','combobox','listbox','slider','switch','tab','menuitem','option','spinbutton']);
    const KEEP = new Set(['heading','navigation','main','banner','contentinfo','complementary','form','dialog','img','list','table','alert','status']);
    const walk = (node, depth) => {
      if (n >= 400 || lines.length > 1500) return;
      for (const el of node.children) {
        if (!(el instanceof HTMLElement) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(el.tagName)) continue;
        if (el.getAttribute('aria-hidden') === 'true' || !__sc.visible(el) && !el.children.length) continue;
        const role = __sc.role(el);
        const inter = INTER.has(role) || el.isContentEditable && !el.parentElement?.isContentEditable || (el.hasAttribute('onclick') && role === '');
        let d = depth;
        if (inter && __sc.visible(el)) {
          const ref = ++n; el.setAttribute('data-sc-ref', String(ref));
          const name = __sc.name(el);
          const st = [];
          if (el.disabled) st.push('disabled');
          if (el.checked || el.getAttribute('aria-checked') === 'true') st.push('checked');
          if (el.getAttribute('aria-expanded')) st.push('expanded=' + el.getAttribute('aria-expanded'));
          if (document.activeElement === el) st.push('focused');
          const val = 'value' in el && role !== 'button' && el.value ? String(el.value).slice(0, 80) : '';
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > innerHeight) st.push('offscreen');
          lines.push('  '.repeat(depth) + '- ' + (role || 'clickable') + (name ? ' ' + JSON.stringify(name) : '') + (val ? ' value=' + JSON.stringify(val) : '') + (el.href ? ' href=' + el.getAttribute('href') : '') + (st.length ? ' [' + st.join(', ') + ']' : '') + ' [ref=' + ref + ']');
          els.push({ ref, role: role || 'clickable', name, tag: el.tagName.toLowerCase(), type: el.type || undefined, value: val || undefined, href: el.href || undefined, text: name });
          if (role !== 'combobox' && role !== 'listbox') continue;
          d = depth + 1;
        } else if (KEEP.has(role) && __sc.visible(el)) {
          const name = role === 'heading' || role === 'img' || role === 'alert' ? __sc.name(el) : (el.getAttribute('aria-label') || '');
          lines.push('  '.repeat(depth) + '- ' + role + (role === 'heading' ? ' (h' + (el.tagName[1] || '') + ')' : '') + (name ? ' ' + JSON.stringify(name.slice(0, 120)) : ''));
          if (role === 'heading' || role === 'img') continue;
          d = depth + 1;
        } else if (!el.children.length || [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 1)) {
          const t = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').replace(/\\s+/g, ' ').trim();
          if (t && __sc.visible(el)) lines.push('  '.repeat(depth) + '- text ' + JSON.stringify(t.slice(0, 200)));
        }
        walk(el, d);
      }
    };
    walk(document.body || document.documentElement, 0);
    return { url: location.href, title: document.title, tree: lines.join('\\n'), elements: els, text: (document.body?.innerText || '').slice(0, 4000),
      scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight } };
  },
  click(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'pointerdown', 'mousedown']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
    el.focus?.();
    for (const t of ['pointerup', 'mouseup']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
    el.click();
    return true;
  },
  key(el, key) {
    const o = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    if (go && key === 'Enter' && el.form && el.tagName !== 'TEXTAREA') el.form.requestSubmit();
    if (go && key === 'Tab') { const f = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter((e) => !e.disabled && __sc.visible(e)); f[(f.indexOf(el) + 1) % f.length]?.focus(); }
    return true;
  }
})`;

/** Script sent to the page: installs helpers, then evaluates `expression`. */
export const wrapScript = (expression: string) => `(${HELPERS.trim()}, (${expression}))`;

export class BrowserController {
  url = "about:blank";
  bounds: Bounds | null = null;
  listeners = new Set<(url: string) => void>();
  /** Set by the app: show the browser panel (the agent asked for the browser while it was closed). */
  onNeedPanel?: () => void;
  /** Set by the panel: switch it to its Browser tab. */
  showBrowserTab?: () => void;
  /** Virtual tabs (one native view; switching tabs loads that tab's page). */
  tabs: string[] = [];
  tab = 0;
  private waiters: (() => void)[] = [];

  /** Make sure the side browser exists, opening the panel if needed. */
  async ensureOpen(timeoutMs = 5000) {
    if (!isDesktop() || this.bounds) return;
    this.onNeedPanel?.();
    this.showBrowserTab?.();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("The browser panel could not be opened")), timeoutMs);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  private emit() {
    this.listeners.forEach((l) => l(this.url));
  }

  async open(url: string, bounds: Bounds) {
    this.bounds = bounds;
    this.url = url;
    if (isDesktop()) await invoke("browser_open", { url, bounds });
    if (!this.tabs.length) this.tabs = [url];
    this.emit();
    const w = this.waiters.splice(0);
    w.forEach((f) => f());
  }
  async setBounds(bounds: Bounds) {
    this.bounds = bounds;
    if (isDesktop()) await invoke("browser_set_bounds", { bounds }).catch(() => {});
  }
  async setVisible(visible: boolean) {
    if (isDesktop()) await invoke("browser_set_visible", { visible }).catch(() => {});
  }
  async hide() {
    // The native view is destroyed; forget its place so the next agent call reopens the panel.
    this.bounds = null;
    if (isDesktop()) await invoke("browser_close").catch(() => {});
  }
  async navigate(url: string) {
    url = url.trim();
    if (!url) throw new Error("url is required");
    if (!/^([a-z][a-z0-9+.-]*:\/\/|data:|about:)/i.test(url)) url = /^(localhost|127\.|\[::1\])/.test(url) ? `http://${url}` : `https://${url}`;
    this.url = url;
    if (this.tabs.length) this.tabs[this.tab] = url; else this.tabs = [url];
    if (isDesktop()) {
      await this.ensureOpen();
      if (this.bounds) await invoke("browser_open", { url, bounds: this.bounds });
      else await invoke("browser_navigate", { url });
      this.emit();
      await new Promise((r) => setTimeout(r, 150));
      await this.settle(10000);
      return this.pageInfo();
    }
    this.emit();
    return { url };
  }
  private async pageInfo() {
    const i = await this.evaluate("({ url: location.href, title: document.title })").catch(() => ({ url: this.url, title: "" }));
    if (i?.url && i.url !== this.url) { this.url = i.url; if (this.tabs.length) this.tabs[this.tab] = i.url; this.emit(); }
    return i;
  }
  /** After an action: let navigation/re-render settle, then report where we are. */
  private async after(ok: unknown) {
    await new Promise((r) => setTimeout(r, 250));
    await this.settle(5000);
    return { ok: !!ok, ...(await this.pageInfo()) };
  }
  async evaluate(expression: string): Promise<any> {
    if (!isDesktop()) throw new Error("Side browser control needs the desktop app");
    if (!this.bounds) await this.ensureOpen();
    const raw = await invoke<string>("browser_eval", { script: wrapScript(expression) });
    const out = JSON.parse(raw);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }

  /** Wait (briefly) until the page finished loading, so captures are not blank. */
  async settle(timeoutMs = 4000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const st = await this.evaluate("document.readyState").catch(() => "loading");
      if (st === "complete") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 120)); // one more paint
  }

  /** Native capture of the visible area, normalized for vision models; falls back to a text snapshot. */
  async screenshot(): Promise<ScreenshotResult | { fallback: "snapshot"; error: string; [k: string]: unknown }> {
    try {
      if (!isDesktop()) throw new Error("Screenshots need the desktop app");
      await this.settle();
      const png = await invoke<string>("browser_screenshot");
      const img = await normalizeImage(png).catch(() => ({ mimeType: "image/png", data: png, width: 0, height: 0 }));
      const meta = await this.evaluate("({ url: location.href, title: document.title })").catch(() => ({ url: this.url, title: "" }));
      return { ...img, ...meta };
    } catch (e: any) {
      const snap = await this.evaluate("__sc.snapshot()").catch(() => ({}));
      return { fallback: "snapshot", error: String(e?.message ?? e), ...snap };
    }
  }

  /** Run one browser operation by short name (shared by ACP extensions and MCP tools). */
  async run(op: string, p: any): Promise<any> {
    const target = JSON.stringify({ ref: p?.ref ?? null, selector: p?.selector ?? null, text: p?.element_text ?? null });
    switch (op) {
      case "navigate":
        return this.navigate(String(p?.url ?? ""));
      case "snapshot":
        return this.evaluate("__sc.snapshot()");
      case "screenshot":
        return this.screenshot();
      case "click":
        return this.after(await this.evaluate(`__sc.click(__sc.find(${target}))`));
      case "hover":
        return { ok: await this.evaluate(`(() => { const el = __sc.find(${target}); el.scrollIntoView({ block: 'center' }); for (const t of ['pointerover','mouseover','mouseenter','pointermove','mousemove']) el.dispatchEvent(new MouseEvent(t, { bubbles: t !== 'mouseenter' })); return true; })()`) };
      case "type": {
        const text = JSON.stringify(String(p?.text ?? ""));
        const ok = await this.evaluate(
          `(() => { const el = __sc.find(${target}); el.scrollIntoView({ block: 'center' }); el.focus();
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
            const v = ${p?.append ? `(el.value ?? '') + ${text}` : text};
            if (proto) Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); else if (el.isContentEditable) el.textContent = v; else throw new Error('element is not editable');
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${text}, inputType: 'insertText' })); el.dispatchEvent(new Event('change', { bubbles: true }));
            ${p?.submit ? "__sc.key(el, 'Enter');" : ""}
            return true; })()`,
        );
        return p?.submit ? this.after(ok) : { ok };
      }
      case "press_key": {
        const key = JSON.stringify(String(p?.key ?? "Enter"));
        const hasTarget = p?.ref != null || p?.selector || p?.element_text;
        return this.after(await this.evaluate(`__sc.key(${hasTarget ? `__sc.find(${target})` : "document.activeElement || document.body"}, ${key})`));
      }
      case "select_option": {
        const vals = JSON.stringify((Array.isArray(p?.values) ? p.values : [p?.value ?? p?.values]).filter((x: unknown) => x != null).map(String));
        return { ok: true, selected: await this.evaluate(`(() => { const el = __sc.find(${target}); if (el.tagName !== 'SELECT') throw new Error('not a <select>'); const want = ${vals};
          for (const o of el.options) o.selected = want.includes(o.value) || want.includes(o.text.trim());
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          return [...el.selectedOptions].map((o) => o.value); })()`) };
      }
      case "scroll": {
        const to = p?.ref != null || p?.selector || p?.element_text;
        return { ok: await this.evaluate(to ? `(__sc.find(${target}).scrollIntoView({ block: 'center' }), true)` : `(window.scrollBy(0, ${Number(p?.dy ?? 600)}), true)`), y: await this.evaluate("Math.round(scrollY)") };
      }
      case "wait_for": {
        const ms = Math.min(30000, Math.max(0, Number(p?.timeout_ms ?? 10000)));
        if (p?.time != null && p?.text == null && p?.text_gone == null && p?.selector == null) {
          await new Promise((r) => setTimeout(r, Math.min(30000, Number(p.time) * 1000)));
          return { ok: true };
        }
        const cond = `(() => { const b = document.body?.innerText || '';
          ${p?.text != null ? `if (!b.includes(${JSON.stringify(String(p.text))})) return false;` : ""}
          ${p?.text_gone != null ? `if (b.includes(${JSON.stringify(String(p.text_gone))})) return false;` : ""}
          ${p?.selector != null ? `if (!document.querySelector(${JSON.stringify(String(p.selector))})) return false;` : ""}
          return true; })()`;
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (await this.evaluate(cond).catch(() => false)) return { ok: true, ...(await this.pageInfo()) };
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error(`timed out after ${ms} ms waiting for ${JSON.stringify({ text: p?.text, text_gone: p?.text_gone, selector: p?.selector })}`);
      }
      case "tabs": {
        const action = String(p?.action ?? "list");
        if (!this.tabs.length) this.tabs = [this.url];
        if (action === "new") { this.tabs.push("about:blank"); this.tab = this.tabs.length - 1; if (p?.url) await this.navigate(String(p.url)); }
        else if (action === "select") { const i = Number(p?.index); if (!(i >= 0 && i < this.tabs.length)) throw new Error("no such tab"); this.tab = i; await this.navigate(this.tabs[i]); }
        else if (action === "close") { const i = p?.index != null ? Number(p.index) : this.tab; this.tabs.splice(i, 1); if (!this.tabs.length) this.tabs = ["about:blank"]; this.tab = Math.min(this.tab, this.tabs.length - 1); await this.navigate(this.tabs[this.tab]); }
        return { tabs: this.tabs.map((url, i) => ({ index: i, url, current: i === this.tab })) };
      }
      case "eval":
        return { value: await this.evaluate(String(p?.expression ?? "undefined")) };
      case "back":
        return this.after(await this.evaluate("(history.back(), true)"));
      case "forward":
        return this.after(await this.evaluate("(history.forward(), true)"));
      case "reload":
        return this.after(await this.evaluate("(setTimeout(() => location.reload(), 0), true)"));
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
        result = mcpContent(out);
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

export type ScreenshotResult = { mimeType: string; data: string; width: number; height: number; url?: string; title?: string };

/** Longest side sent to the model; keeps text legible while staying small. */
export const MAX_SIDE = 1280;
const MAX_PNG_BYTES = 900_000;

/** Fit within MAX_SIDE; keep PNG (sharp text) unless large, then use high-quality JPEG. */
export async function normalizeImage(pngB64: string, maxSide = MAX_SIDE): Promise<ScreenshotResult> {
  const img = new Image();
  img.src = `data:image/png;base64,${pngB64}`;
  await img.decode();
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  if (scale === 1 && pngB64.length * 0.75 <= MAX_PNG_BYTES) return { mimeType: "image/png", data: pngB64, width: w, height: h };
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, w, h);
  let url = c.toDataURL("image/png");
  if (url.length * 0.75 > MAX_PNG_BYTES) url = c.toDataURL("image/jpeg", 0.88);
  const [head, data] = url.split(",");
  return { mimeType: head.slice(5, head.indexOf(";")), data, width: w, height: h };
}

/** MCP tool result: images become an image block plus a short caption. */
export function mcpContent(out: any) {
  if (out && typeof out.data === "string" && out.mimeType) {
    const cap = `Screenshot of ${out.url ?? "the side browser"}${out.title ? ` ("${out.title}")` : ""}${out.width ? `, ${out.width}×${out.height}px` : ""}.`;
    return { content: [{ type: "image", data: out.data, mimeType: out.mimeType }, { type: "text", text: cap }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

export const browser = new BrowserController();
