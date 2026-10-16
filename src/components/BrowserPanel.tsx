import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { browser } from "../browser/bridge";
import { isDesktop } from "../lib/desktop";
import { browserVisible, scanDocument, useOverlayCount } from "../browser/visibility";
import type { PlanEntry } from "../acp/types";
import { FilesPane } from "./FilesPane";
import { Icon } from "./Icon";
// Computer / dev / design mode UI loads when first used.
const tools = () => import("./BrowserTools");
const ComputerStage = lazy(() => tools().then((m) => ({ default: m.ComputerStage })));
const DevDrawer = lazy(() => tools().then((m) => ({ default: m.DevDrawer })));
const screenSize = () => ({ width: Math.round(window.screen?.width || 1920), height: Math.round(window.screen?.height || 1080) });
import type { Size } from "../browser/viewport";
// The terminal pulls in xterm; load it only when the tab is opened.
const TerminalPane = lazy(() => import("./TerminalPane").then((m) => ({ default: m.TerminalPane })));

const ChangesPane = lazy(() => import("./ChangesPane").then((m) => ({ default: m.ChangesPane })));
import { git, gitAvailable } from "../lib/git";

type PanelTab = "browser" | "plan" | "terminal" | "files" | "changes";

/** Right panel: browser, plan, project files, and one or more local terminals. */
export function BrowserPanel({ plan, sessionId, cwd, focus, onClose }: { plan: PlanEntry[]; sessionId?: string; cwd?: string; focus?: { tab: PanelTab; n: number } | null; onClose: () => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(browser.url === "about:blank" ? "https://superchargeai.in" : browser.url);
  const [tab, setTab] = useState<PanelTab>(focus?.tab ?? "browser");
  const [terms, setTerms] = useState<{ id: string; title: string }[]>([{ id: "t1", title: "Terminal 1" }]);
  const [activeTerm, setActiveTerm] = useState("t1");
  const [picker, setPicker] = useState(false);
  // Changed-file count for the Changes tab badge.
  const [nChanges, setNChanges] = useState(0);
  useEffect(() => {
    if (!cwd || !gitAvailable()) return;
    let gone = false;
    const on = () => void git.status(cwd).then((s) => { if (!gone) setNChanges(s.repo ? s.files.length : 0); }).catch(() => {});
    on();
    const t = setInterval(on, 8000);
    window.addEventListener("sc-changes-refresh", on);
    return () => { gone = true; clearInterval(t); window.removeEventListener("sc-changes-refresh", on); };
  }, [cwd]);
  const termFocus = useRef<number | null>(null);
  const aside = useRef<HTMLElement>(null);
  const overlays = useOverlayCount();
  const [shown, setShown] = useState(true);
  const shownRef = useRef(true);
  // Computer mode viewport (null = page fits the panel), dev drawer, design mode.
  const [vp, setVp] = useState<Size | null>(null);
  const vpRef = useRef<Size | null>(null);
  vpRef.current = vp;
  const stage = useRef<HTMLDivElement>(null);
  const [dev, setDev] = useState(false);
  const [design, setDesign] = useState(false);
  const designOn = design && tab === "browser" && !picker && isDesktop();
  useEffect(() => {
    if (!designOn) return;
    let stop: (() => void) | undefined, gone = false;
    void tools().then((m) => { if (!gone) stop = m.startDesign(setDesign); });
    return () => { gone = true; stop?.(); };
  }, [designOn]);
  useEffect(() => {
    browser.onViewport = (v) => { setTab("browser"); setPicker(false); setVp(v); };
    return () => { browser.onViewport = undefined; browser.viewport = null; };
  }, []);
  const firstVp = useRef(true);
  useEffect(() => {
    browser.viewport = vp;
    if (firstVp.current) { firstVp.current = false; return; }
    if (vp) return; // ComputerStage places the view and sets the zoom.
    const r = slotRect();
    void browser.setZoom(1).then(() => r && browser.setBounds(r));
  }, [vp]);
  useEffect(() => { if (tab !== "browser" || picker) setVp(null); }, [tab, picker]);
  const slotRect = () => {
    if (vpRef.current) return null;
    const r = slot.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) } : null;
  };
  // One rule for the native view: it is shown only when nothing covers its area.
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const scan = scanDocument(document, aside.current);
      const r = (vpRef.current ? stage.current : slot.current)?.getBoundingClientRect();
      setShown(browserVisible({ tab, picker, overlays, ...scan, bounds: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null }));
    };
    const later = () => { if (!raf) raf = requestAnimationFrame(check); };
    check();
    const mo = new MutationObserver(later);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", later);
    const ro = slot.current ? new ResizeObserver(later) : null;
    if (slot.current) ro!.observe(slot.current);
    return () => { mo.disconnect(); ro?.disconnect(); window.removeEventListener("resize", later); if (raf) cancelAnimationFrame(raf); };
  }, [tab, picker, overlays, vp]);
  useEffect(() => {
    shownRef.current = shown;
    if (tab !== "browser" || picker) return;
    const r = slotRect();
    // Show first, then re-send bounds so the native view lands in the right place.
    void (async () => {
      await browser.setVisible(shown);
      if (shown && r) await browser.setBounds(r);
    })();
  }, [shown]);
  useEffect(() => {
    if (!focus) return;
    setPicker(false);
    setTab(focus.tab);
    if (focus.tab !== "terminal") return;
    // The first request only shows the shell. Each later request opens another one.
    if (termFocus.current == null) { termFocus.current = focus.n; if (!terms.length) addTerm(); return; }
    if (termFocus.current === focus.n) return;
    termFocus.current = focus.n;
    const id = `t${focus.n}`;
    setTerms((cur) => cur.some((t) => t.id === id) ? cur : [...cur, { id, title: `Terminal ${cur.length + 1}` }]);
    setActiveTerm(id);
  }, [focus]);
  function addTerm() {
    const id = `t${Date.now()}`;
    setTerms((cur) => [...cur, { id, title: `Terminal ${cur.length + 1}` }]);
    setActiveTerm(id);
    setTab("terminal");
  }
  const closeTerm = (id: string) => {
    const next = terms.filter((t) => t.id !== id);
    setTerms(next);
    if (activeTerm === id) setActiveTerm(next.length ? next[next.length - 1].id : "");
    if (!next.length && tab === "terminal") setTab("browser");
  };
  useEffect(() => {
    // The agent used a browser tool while the Tools tab was showing: switch to the browser.
    browser.showBrowserTab = () => setTab("browser");
    return () => { browser.showBrowserTab = undefined; };
  }, []);

  useEffect(() => {
    const l = (u: string) => setUrl(u);
    browser.listeners.add(l);
    return () => void browser.listeners.delete(l);
  }, []);

  // Keep the native webview glued to the placeholder div.
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el || tab !== "browser" || picker) {
      void browser.hide();
      return;
    }
    const rect = () => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
    };
    // Hide first if something already covers the panel, so it never flashes on top.
    void (async () => {
      if (!shownRef.current) await browser.setVisible(false);
      await browser.open(url, rect()).catch(() => {});
      if (shownRef.current) await browser.setVisible(true);
    })();
    const resize = () => { if (!vpRef.current) void browser.setBounds(rect()); };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    window.addEventListener("resize", resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
      void browser.hide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, picker]);

  return (
    <aside className="rpanel" ref={aside}>
      <div className="tabs">
        <button className={tab === "browser" ? "on" : ""} onClick={() => { setPicker(false); setTab("browser"); }}><Icon name="globe" size={14} /> Browser</button>
        <button data-testid="plan-tab" className={tab === "plan" ? "on" : ""} onClick={() => { setPicker(false); setTab("plan"); }}><Icon name="file" size={14} /> Plan{plan.length ? ` (${plan.length})` : ""}</button>
        {gitAvailable() && <button data-testid="changes-tab" className={tab === "changes" ? "on" : ""} onClick={() => { setPicker(false); setTab("changes"); }}><Icon name="code" size={14} /> Changes{nChanges ? <span className="tab-badge" data-testid="changes-badge">{nChanges}</span> : null}</button>}
        {isDesktop() && <button data-testid="files-tab" className={tab === "files" ? "on" : ""} onClick={() => { setPicker(false); setTab("files"); }}><Icon name="folder" size={14} /> File tree</button>}
        {isDesktop() && terms.map((t) => (
          <button key={t.id} data-testid="terminal-tab" className={tab === "terminal" && t.id === activeTerm ? "on" : ""} onClick={() => { setPicker(false); setActiveTerm(t.id); setTab("terminal"); }}>
            <Icon name="terminal" size={14} /> {t.title}
            <span className="term-x" role="button" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); closeTerm(t.id); }}>×</span>
          </button>
        ))}
        <button className="icon" data-testid="panel-add" title="Open a tab" aria-expanded={picker} onClick={() => setPicker((v) => !v)}><Icon name="plus" size={16} /></button>
        <div style={{ flex: 1 }} />
        <button className="icon" onClick={onClose} title="Close panel"><Icon name="x" /></button>
      </div>
      {picker && (
        <div className="tab-picker" data-testid="tab-picker">
          <h3>Open tab</h3>
          <p>Choose a tab to open in the side pane.</p>
          <div className="tab-picker-grid">
            {([
              ["changes", "code", "Changes"],
              ["files", "folder", "File tree"],
              ["plan", "file", "Plan"],
              ["terminal", "terminal", "Terminal"],
              ["browser", "globe", "Browser"],
            ] as const).filter(([id]) => isDesktop() || id === "browser" || id === "plan" || (id === "changes" && gitAvailable())).map(([id, icon, label]) => (
              <button key={id} onClick={() => { setPicker(false); if (id === "terminal") addTerm(); else setTab(id); }}>
                <Icon name={icon} size={18} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {isDesktop() && terms.length > 0 && (
        // Shells stay mounted (and running) while another tab is showing; they are only hidden.
        <div className="term-stack" hidden={picker || tab !== "terminal"}>
          <Suspense fallback={null}>
            {terms.map((t) => <TerminalPane key={t.id} id={t.id} cwd={cwd} active={!picker && tab === "terminal" && t.id === activeTerm} />)}
          </Suspense>
        </div>
      )}
      {picker ? null : tab === "changes" && gitAvailable() ? <Suspense fallback={null}><ChangesPane cwd={cwd} onCount={setNChanges} /></Suspense> : tab === "files" && isDesktop() ? <FilesPane cwd={cwd} /> : tab === "terminal" ? null : tab === "browser" ? (
        <>
          <form
            className="urlbar"
            onSubmit={(e) => {
              e.preventDefault();
              void browser.navigate(url);
            }}
          >
            <Icon name="globe" size={14} />
            <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Address" />
            <span className="bm-tools">
              <button type="button" className={`icon sm${vp ? " on" : ""}`} data-testid="computer-toggle" aria-pressed={!!vp} title="Computer mode: open the page at a desktop size" onClick={() => setVp((v) => (v ? null : screenSize()))}><Icon name="monitor" size={14} /></button>
              <button type="button" className={`icon sm${dev ? " on" : ""}`} data-testid="dev-toggle" aria-pressed={dev} title="Dev mode: console and network" onClick={() => setDev((v) => !v)}><Icon name="code" size={14} /></button>
              <button type="button" className={`icon sm${design ? " on" : ""}`} data-testid="design-toggle" aria-pressed={design} title="Design mode: pick elements to change (Shift = several, Esc = stop)" onClick={() => setDesign((v) => !v)}><Icon name="cursor" size={14} /></button>
            </span>
          </form>
          {design && <div className="bm-hint small" data-testid="design-hint">Click an element to attach it to your message. Shift+click picks several, Enter attaches them, Esc stops.</div>}
          {/* The slot stays mounted in computer mode so the native view (page and session) is kept. */}
          <div ref={slot} className={`webslot${vp ? " computer" : ""}`}>
            {!isDesktop() && !vp && <iframe title="browser" src={url} sandbox="allow-scripts allow-forms allow-same-origin" />}
            {vp && <Suspense fallback={null}><ComputerStage vp={vp} stage={stage} onSize={setVp} /></Suspense>}
          </div>
          <Suspense fallback={null}>{dev && <DevDrawer />}</Suspense>
        </>
      ) : (
        <div className="plan-panel" data-testid="plan-panel">
          {plan.length === 0 ? <div className="empty small"><Icon name="file" size={22} /><p>The agent's plan for this chat will appear here.</p></div> :
            <ol>{plan.map((entry, index) => <li key={`${index}-${entry.content}`} className={`plan-step ${entry.status}`}><span className="plan-mark">{entry.status === "completed" ? <Icon name="check" size={13} /> : index + 1}</span><div><span>{entry.content}</span><small>{(entry.status ?? "pending").replaceAll("_", " ")}</small></div></li>)}</ol>}
        </div>
      )}
    </aside>
  );
}
