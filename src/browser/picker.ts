/** Design mode: element picker injected into the side browser page, and the context sent to the agent. */

/** Stable, unique CSS selector for `el`. Self-contained: it is also injected into pages via toString(). */
export function cssSelector(el: Element): string {
  const doc = el.ownerDocument;
  const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c));
  const uniq = (s: string) => { try { return doc.querySelectorAll(s).length === 1; } catch { return false; } };
  // Generated / state classes make poor selectors.
  const good = (c: string) => !/^(is-|has-|hover|active|focus|selected|open|css-|sc-|jsx-|svelte-|ng-)|[:[\]/@]|\d{4,}|^[a-z]{1,2}\d|[A-Za-z0-9]{8,}_/.test(c) && !/^[a-zA-Z]+-[a-zA-Z0-9]{5,}$/.test(c) || /^(btn|button|card|nav|header|footer|hero|title|logo|menu)/.test(c);
  const tag = el.tagName.toLowerCase();
  if (el.id && !/\d{3,}|:/.test(el.id) && uniq("#" + esc(el.id))) return "#" + esc(el.id);
  for (const a of ["data-testid", "data-test", "data-cy", "data-qa", "name", "aria-label"]) {
    const v = el.getAttribute(a);
    if (v && v.length < 80) { const s = `${tag}[${a}="${v.replace(/["\\]/g, "\\$&")}"]`; if (uniq(s)) return s; }
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== doc.documentElement) {
    const c: Element = cur;
    if (c !== el && c.id && !/\d{3,}|:/.test(c.id) && uniq("#" + esc(c.id))) { parts.unshift("#" + esc(c.id)); break; }
    let part = c.tagName.toLowerCase();
    const cls = Array.from(c.classList).filter(good).slice(0, 2);
    part += cls.map((x) => "." + esc(x)).join("");
    const p = c.parentElement;
    if (p) {
      const sibs = Array.from(p.children);
      if (sibs.filter((s) => s.matches(part)).length > 1) part += `:nth-of-type(${sibs.filter((s) => s.tagName === c.tagName).indexOf(c) + 1})`;
    }
    parts.unshift(part);
    const sel = parts.join(" > ");
    if (uniq(sel)) return sel;
    cur = p;
  }
  return parts.join(" > ");
}

export type Pick = {
  selector: string; tag: string; text: string; html: string;
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>; source?: string;
  page: { url: string; title: string; width: number; height: number; scrollY: number };
};

/** Style properties worth showing the agent. */
export const STYLE_KEYS = ["display", "position", "width", "height", "margin", "padding", "color", "background-color", "background-image", "border", "border-radius", "box-shadow", "font-family", "font-size", "font-weight", "line-height", "text-align", "gap", "flex-direction", "justify-content", "align-items", "opacity"];

/** Page script: installs the picker (idempotent). Selections are read back with PICK_TAKE. */
export const pickerScript = () => `(() => {
  if (window.__scPick) { window.__scPick.on = true; return true; }
  const cssSelector = ${cssSelector.toString()};
  const KEYS = ${JSON.stringify(STYLE_KEYS)};
  const P = (window.__scPick = { on: true, sel: [], out: [], commit: 0, exit: false });
  const mk = (c) => { const d = document.createElement('div'); d.setAttribute('data-sc-pick', ''); d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;' + c; document.documentElement.appendChild(d); return d; };
  const hov = mk('outline:2px solid #7c5cff;background:rgba(124,92,255,.12);display:none');
  const lab = mk('background:#7c5cff;color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:4px;display:none;white-space:nowrap');
  let marks = [];
  const place = (d, r) => { d.style.left = r.left + 'px'; d.style.top = r.top + 'px'; d.style.width = r.width + 'px'; d.style.height = r.height + 'px'; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
  const redraw = () => { marks.forEach((m) => m.remove()); marks = P.sel.map((el) => { const m = mk('outline:2px dashed #ff8a00'); place(m, el.getBoundingClientRect()); return m; }); };
  const src = (el) => {
    if (!/^(localhost|127\\.|0\\.0\\.0\\.0|\\[::1\\])/.test(location.hostname)) return undefined;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      for (const a of ['data-source', 'data-source-file', 'data-inspector-relative-path', 'data-sc-source', 'data-file']) {
        const v = e.getAttribute(a); if (v) return v + (e.getAttribute('data-inspector-line') ? ':' + e.getAttribute('data-inspector-line') : '');
      }
      if (e.__svelte_meta && e.__svelte_meta.loc) return e.__svelte_meta.loc.file + ':' + e.__svelte_meta.loc.line;
      if (e.__vueParentComponent && e.__vueParentComponent.type && e.__vueParentComponent.type.__file) return e.__vueParentComponent.type.__file;
      const fk = Object.keys(e).find((k) => k.startsWith('__reactFiber$'));
      for (let f = fk && e[fk]; f; f = f.return) if (f._debugSource) return f._debugSource.fileName + ':' + f._debugSource.lineNumber;
    }
    return undefined;
  };
  const info = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el), styles = {};
    for (const k of KEYS) { const v = cs.getPropertyValue(k); if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[k] = v; }
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style,svg *').forEach((x) => x.remove());
    let html = c.outerHTML.replace(/\\s+/g, ' ');
    if (html.length > 1500) html = html.slice(0, 1500) + ' …';
    return { selector: cssSelector(el), tag: el.tagName.toLowerCase(), text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200), html,
      box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }, styles, source: src(el),
      page: { url: location.href, title: document.title, width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY) } };
  };
  const target = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && !el.hasAttribute('data-sc-pick') ? el : null; };
  const stop = (e) => { if (!P.on) return false; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return true; };
  addEventListener('mousemove', (e) => {
    if (!P.on) { hov.style.display = lab.style.display = 'none'; return; }
    const el = target(e); if (!el) return;
    const r = el.getBoundingClientRect(); place(hov, r); hov.style.display = 'block';
    lab.textContent = name(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height); lab.style.display = 'block';
    lab.style.left = Math.max(0, r.left) + 'px'; lab.style.top = (r.top > 20 ? r.top - 20 : r.bottom + 2) + 'px';
  }, true);
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu']) addEventListener(t, stop, true);
  const commit = () => { if (!P.sel.length) return; P.out = P.sel.map(info); P.commit++; P.sel = []; redraw(); };
  addEventListener('click', (e) => {
    if (!stop(e)) return;
    const el = target(e); if (!el) return;
    const i = P.sel.indexOf(el);
    if (e.shiftKey) { if (i >= 0) P.sel.splice(i, 1); else P.sel.push(el); redraw(); return; }
    if (i < 0) P.sel.push(el);
    commit();
  }, true);
  addEventListener('keydown', (e) => {
    if (!P.on) return;
    if (e.key === 'Escape') { stop(e); P.sel = []; redraw(); P.on = false; P.exit = true; hov.style.display = lab.style.display = 'none'; }
    else if (e.key === 'Enter') { stop(e); commit(); }
  }, true);
  addEventListener('scroll', () => P.sel.length && redraw(), true);
  P.hide = (h) => { for (const d of [hov, lab, ...marks]) d.style.visibility = h ? 'hidden' : ''; };
  P.off = () => { P.on = false; P.sel = []; redraw(); hov.style.display = lab.style.display = 'none'; };
  return true;
})()`;

/** Page expression: new committed picks (once), and whether the user pressed Esc. */
export const PICK_TAKE = `(() => { const P = window.__scPick; if (!P) return { missing: true }; const r = { commit: P.commit, picks: P.out, exit: P.exit }; P.out = []; P.exit = false; return r; })()`;
export const PICK_OFF = `(window.__scPick && window.__scPick.off(), true)`;

/** Markdown context for one or more picked elements (sent as a text attachment). */
export function designMarkdown(picks: Pick[]): string {
  const p0 = picks[0]?.page;
  const head = `# Selected element${picks.length > 1 ? "s" : ""} in the side browser\n\nPage: ${p0?.url ?? ""}${p0?.title ? ` ("${p0.title}")` : ""}, viewport ${p0?.width}×${p0?.height} CSS px, scrolled to y=${p0?.scrollY ?? 0}.\n`;
  return head + picks.map((p, i) => [
    `\n## ${i + 1}. \`${p.selector}\``,
    p.source ? `Source (best guess): \`${p.source}\`` : "",
    `Box: x=${p.box.x} y=${p.box.y} ${p.box.width}×${p.box.height} (CSS px, viewport)`,
    p.text ? `Text: ${JSON.stringify(p.text)}` : "",
    `Computed styles:\n${Object.entries(p.styles).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
    "HTML:\n```html\n" + p.html.replace(/```/g, "ˋˋˋ") + "\n```",
  ].filter(Boolean).join("\n")).join("\n");
}

/** File name for a pick, like `button.primary.md`. */
export function pickName(p: Pick, ext: string): string {
  const last = p.selector.split(/\s*>\s*/).pop() || p.tag;
  return (last.replace(/:nth-of-type\((\d+)\)/g, "-$1").replace(/[^\w.#-]+/g, "").replace(/^[#.]+/, "") || p.tag).slice(0, 40) + ext;
}
