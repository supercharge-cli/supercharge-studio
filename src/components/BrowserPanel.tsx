import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { browser } from "../browser/bridge";
import { isDesktop } from "../lib/desktop";
import type { PlanEntry } from "../acp/types";
import { FilesPane } from "./FilesPane";
import { Icon } from "./Icon";
// The terminal pulls in xterm; load it only when the tab is opened.
const TerminalPane = lazy(() => import("./TerminalPane").then((m) => ({ default: m.TerminalPane })));

type PanelTab = "browser" | "plan" | "terminal" | "files";

/** Right panel: browser, plan, project files, and one or more local terminals. */
export function BrowserPanel({ plan, sessionId, cwd, focus, onClose }: { plan: PlanEntry[]; sessionId?: string; cwd?: string; focus?: { tab: PanelTab; n: number } | null; onClose: () => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(browser.url === "about:blank" ? "https://superchargeai.in" : browser.url);
  const [tab, setTab] = useState<PanelTab>(focus?.tab ?? "browser");
  const [terms, setTerms] = useState<{ id: string; title: string }[]>([{ id: "t1", title: "Terminal 1" }]);
  const [activeTerm, setActiveTerm] = useState("t1");
  const [picker, setPicker] = useState(false);
  const termFocus = useRef<number | null>(null);
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
    void browser.open(url, rect()).catch(() => {});
    const ro = new ResizeObserver(() => void browser.setBounds(rect()));
    ro.observe(el);
    const resize = () => void browser.setBounds(rect());
    window.addEventListener("resize", resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
      void browser.hide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, picker]);

  return (
    <aside className="rpanel">
      <div className="tabs">
        <button className={tab === "browser" ? "on" : ""} onClick={() => { setPicker(false); setTab("browser"); }}><Icon name="globe" size={14} /> Browser</button>
        <button data-testid="plan-tab" className={tab === "plan" ? "on" : ""} onClick={() => { setPicker(false); setTab("plan"); }}><Icon name="file" size={14} /> Plan{plan.length ? ` (${plan.length})` : ""}</button>
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
              ["files", "folder", "File tree"],
              ["plan", "file", "Plan"],
              ["terminal", "terminal", "Terminal"],
              ["browser", "globe", "Browser"],
            ] as const).filter(([id]) => isDesktop() || id === "browser" || id === "plan").map(([id, icon, label]) => (
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
      {picker ? null : tab === "files" && isDesktop() ? <FilesPane cwd={cwd} /> : tab === "terminal" ? null : tab === "browser" ? (
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
          </form>
          <div ref={slot} className="webslot">
            {!isDesktop() && <iframe title="browser" src={url} sandbox="allow-scripts allow-forms allow-same-origin" />}
          </div>
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
