import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { browser } from "../browser/bridge";
import { isDesktop } from "../lib/desktop";
import type { PlanEntry } from "../acp/types";
import { Icon } from "./Icon";
import { TerminalPane } from "./TerminalPane";

/** Right panel: browser, the chat plan, and a local terminal. */
export function BrowserPanel({ plan, sessionId, cwd, focus, onClose }: { plan: PlanEntry[]; sessionId?: string; cwd?: string; focus?: number | null; onClose: () => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(browser.url === "about:blank" ? "https://superchargeai.in" : browser.url);
  const [tab, setTab] = useState<"browser" | "plan" | "terminal">(plan.length ? "plan" : "browser");
  useEffect(() => { if (focus) setTab("terminal"); }, [focus]);
  useEffect(() => { setTab(plan.length ? "plan" : "browser"); }, [sessionId]);
  const hadPlan = useRef(plan.length > 0);
  useEffect(() => {
    if (plan.length > 0 && !hadPlan.current) setTab("plan");
    hadPlan.current = plan.length > 0;
  }, [plan]);

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
    if (!el || tab !== "browser") {
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
  }, [tab]);

  return (
    <aside className="rpanel">
      <div className="tabs">
        <button className={tab === "browser" ? "on" : ""} onClick={() => setTab("browser")}><Icon name="globe" size={14} /> Browser</button>
        <button data-testid="plan-tab" className={tab === "plan" ? "on" : ""} onClick={() => setTab("plan")}><Icon name="file" size={14} /> Plan{plan.length ? ` (${plan.length})` : ""}</button>
        {isDesktop() && <button data-testid="terminal-tab" className={tab === "terminal" ? "on" : ""} onClick={() => setTab("terminal")}><Icon name="terminal" size={14} /> Terminal</button>}
        <div style={{ flex: 1 }} />
        <button className="icon" onClick={onClose} title="Close panel"><Icon name="x" /></button>
      </div>
      {tab === "terminal" ? <TerminalPane cwd={cwd} /> : tab === "browser" ? (
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
