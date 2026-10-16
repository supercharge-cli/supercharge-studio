import { useRef, useState, type PointerEvent as RPE } from "react";
import { isDesktop } from "../lib/desktop";
import { clampSidebar, loadSidebarWidth, projectsByCwd, recentChats, relTime, saveSidebarWidth, SIDEBAR_DEFAULT, type AppData, type TreeAction } from "../lib/store";
import { Icon } from "./Icon";

type Props = {
  data: AppData;
  collapsed: boolean;
  onToggle: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectChat: (projectId: string, chatId: string) => void;
  onNewChat: (projectId: string) => void;
  onNewWorktreeChat?: (projectId: string) => void;
  onTree: (a: TreeAction) => void;
  onSettings: () => void;
  onUsage?: () => void;
  onPalette?: () => void;
  /** Open a folder as a project (Projects view). */
  onOpenFolder?: (cwd: string) => void;
  /** Open the system folder picker (desktop). */
  onBrowse?: () => void;
  onSidebarView?: (v: "projects" | "recents") => void;
  /** Refresh the CLI session list now. */
  onSync?: () => void;
  syncing?: boolean;
};

/** Inline text input: Enter commits, Escape / blur cancels. */
function Inline({ initial = "", placeholder, onDone }: { initial?: string; placeholder?: string; onDone: (v: string | null) => void }) {
  const [v, set] = useState(initial);
  // Removing a focused input fires blur; ignore it once the edit is already settled.
  const settled = useRef(false);
  const finish = (x: string | null) => { if (!settled.current) { settled.current = true; onDone(x); } };
  return (
    <input
      autoFocus
      className="inline"
      data-testid="inline-input"
      value={v}
      placeholder={placeholder}
      onChange={(e) => set(e.target.value)}
      onBlur={() => finish(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(v.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}

/** Two-step delete button. */
function Del({ title, onConfirm }: { title: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <button className="icon sm danger-text" data-testid="confirm-delete" title="Click again to delete" onClick={onConfirm} onBlur={() => setArmed(false)} autoFocus>
      delete?
    </button>
  ) : (
    <button className="icon sm" title={title} data-testid="delete" onClick={() => setArmed(true)}><Icon name="trash" size={13} /></button>
  );
}

type Editing =
  | { kind: "newGroup" }
  | { kind: "renameGroup"; id: string }
  | { kind: "newProjectName"; groupId: string }
  | { kind: "newProjectCwd"; groupId: string; name: string }
  | { kind: "renameProject"; id: string }
  | { kind: "renameChat"; id: string }
  | { kind: "openFolder" }
  | null;

export function Sidebar(p: Props) {
  const [ed, setEd] = useState<Editing>(null);
  const byFolder = (p.data.sidebarView ?? "projects") === "projects";
  const [width, setWidth] = useState(loadSidebarWidth);
  const startDrag = (e: RPE<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    let w = w0;
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => { w = clampSidebar(w0 + ev.clientX - x0); setWidth(w); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.classList.remove("resizing"); saveSidebarWidth(w); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => { setWidth(SIDEBAR_DEFAULT); saveSidebarWidth(SIDEBAR_DEFAULT); };
  if (p.collapsed)
    return (
      <aside className="sidebar collapsed">
        <button className="icon" title="Expand sidebar" data-testid="expand-sidebar" onClick={p.onToggle}><Icon name="panelLeft" size={18} /></button>
        <button className="icon" title="Usage" onClick={p.onUsage}><Icon name="chart" size={18} /></button>
        <button className="icon" title="Settings" onClick={p.onSettings}><Icon name="settings" size={18} /></button>
      </aside>
    );
  return (
    <aside className="sidebar" data-testid="sidebar" style={{ width }}>
      <div className="side-resize" data-testid="sidebar-resize" title="Drag to resize, double-click to reset" onPointerDown={startDrag} onDoubleClick={reset} />
      <div className="side-head">
        <span className="logo"><img src="/logo.png" alt="" /></span><strong>Supercharge Studio</strong>
        <div style={{ flex: 1 }} />
        {byFolder
          ? <button className="icon" title="Open a project folder" data-testid="open-folder" onClick={() => (isDesktop() && p.onBrowse ? p.onBrowse() : setEd({ kind: "openFolder" }))}><Icon name="plus" /></button>
          : null}
        <button className="icon" title="Collapse sidebar" data-testid="collapse-sidebar" onClick={p.onToggle}><Icon name="panelLeft" /></button>
      </div>
      <div className="side-views" role="tablist">
        <button role="tab" data-testid="view-projects" className={byFolder ? "on" : ""} onClick={() => p.onSidebarView?.("projects")}>Projects</button>
        <button role="tab" data-testid="view-recents" className={!byFolder ? "on" : ""} onClick={() => p.onSidebarView?.("recents")}>Recents</button>
        <div style={{ flex: 1 }} />
        {p.onSync && <button className="icon sm" title="Refresh sessions from the Supercharge CLI" data-testid="sync-sessions" onClick={p.onSync}><Icon name="refresh" size={13} className={p.syncing ? "spin" : ""} /></button>}
      </div>
      {byFolder ? <FolderTree p={p} ed={ed} setEd={setEd} /> : <Recents p={p} />}
      <div className="side-foot">
        <button className="side-search" data-testid="open-palette" onClick={p.onPalette} title="Command palette"><Icon name="search" size={14} /><span>Search & commands</span><kbd>Ctrl K</kbd></button>
        <div className="side-foot-row">
          <button className="secondary" data-testid="open-usage" onClick={p.onUsage}><Icon name="chart" /> Usage</button>
          <button className="secondary" data-testid="open-settings" onClick={p.onSettings}><Icon name="settings" /> Settings</button>
        </div>
      </div>
    </aside>
  );
}

/** The CLI's own layout: one project per folder, its chats newest first with relative time. */
function FolderTree({ p, ed, setEd }: { p: Props; ed: Editing; setEd: (e: Editing) => void }) {
  const folders = projectsByCwd(p.data);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const now = Date.now();
  return (
    <nav className="tree" data-testid="folder-tree">
      {ed?.kind === "openFolder" && <Inline key="of" placeholder="Project folder, e.g. /home/me/code/app" onDone={(v) => (v && p.onOpenFolder?.(v), setEd(null))} />}
      {folders.map((f) => {
        const activeHere = f.chats.some((c) => c.chat.id === p.data.activeChatId) || f.projectId === p.data.activeProjectId;
        const isOpen = open[f.cwd] ?? (activeHere || folders.indexOf(f) < 6);
        const shown = more[f.cwd] ? f.chats : f.chats.slice(0, 8);
        return (
          <div key={f.cwd} data-testid="project" data-cwd={f.cwd} className={`project ${activeHere ? "active" : ""}`}>
            <div className="project-head">
              <button className="link grow" title={f.cwd} data-testid="project-name" onClick={() => { setOpen((o) => ({ ...o, [f.cwd]: !isOpen })); p.onSelectProject(f.projectId); }}>
                <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={12} /> <Icon name="folder" size={14} /> {f.name}
              </button>
              <div className="acts">
                <button className="icon sm" title="New chat in this folder" data-testid="new-chat" onClick={() => p.onNewChat(f.projectId)}><Icon name="plus" size={13} /></button>
                {p.onNewWorktreeChat && <button className="icon sm" title="New chat in a new git worktree (runs in parallel on its own branch)" data-testid="new-wt-chat" onClick={() => p.onNewWorktreeChat!(f.projectId)}><Icon name="code" size={13} /></button>}
              </div>
            </div>
            {isOpen && shown.map(({ projectId, chat: c }) => (
              <div key={c.id} className={`chat ${c.id === p.data.activeChatId ? "active" : ""}`} data-testid="chat" data-session={c.sessionId ?? ""}>
                {ed?.kind === "renameChat" && ed.id === c.id ? (
                  <Inline key={`rc-${c.id}`} initial={c.title} onDone={(v) => (v && p.onTree({ type: "renameChat", chatId: c.id, title: v }), setEd(null))} />
                ) : (
                  <button className="link grow" data-testid="chat-open" title={c.title} onClick={() => p.onSelectChat(projectId, c.id)} onDoubleClick={() => setEd({ kind: "renameChat", id: c.id })}>
                    <span className="chat-t" data-testid="chat-title">{c.title}</span>{c.worktree && <span className="wt-badge" data-testid="wt-badge" title={c.worktree.path}>{c.worktree.branch.replace(/^supercharge\//, "")}</span>}<span className="muted small chat-time" data-testid="chat-time">{relTime(c.updatedAt ?? c.createdAt, now)}</span>
                  </button>
                )}
                <div className="acts">
                  <button className="icon sm" title="Rename chat" data-testid="rename-chat" onClick={() => setEd({ kind: "renameChat", id: c.id })}><Icon name="edit" size={13} /></button>
                  <Del title="Remove from sidebar" onConfirm={() => p.onTree({ type: "removeChat", chatId: c.id })} />
                </div>
              </div>
            ))}
            {isOpen && f.chats.length > shown.length && <button className="link small muted more" onClick={() => setMore((m) => ({ ...m, [f.cwd]: true }))}>Show {f.chats.length - shown.length} more</button>}
          </div>
        );
      })}
      {folders.length === 0 && !ed && <div className="side-empty">No projects yet. Use <Icon name="plus" size={12} /> to open a folder.</div>}
    </nav>
  );
}

/** Every chat across projects, newest activity first. */
function Recents({ p }: { p: Props }) {
  const list = recentChats(p.data);
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, 60);
  const now = Date.now();
  return (
    <nav className="tree recents" data-testid="recents">
      {shown.map(({ projectId, projectName, chat: c, at }) => (
        <div key={c.id} className={`chat recent ${c.id === p.data.activeChatId ? "active" : ""}`} data-testid="chat">
          <button className="link grow" data-testid="chat-open" title={c.title} onClick={() => p.onSelectChat(projectId, c.id)}>
            <span className="recent-main"><span className="chat-t" data-testid="chat-title">{c.title}{c.worktree && <span className="wt-badge" title={c.worktree.path}>{c.worktree.branch.replace(/^supercharge\//, "")}</span>}</span><span className="muted small recent-proj">{projectName}</span></span>
            <span className="muted small chat-time" data-testid="chat-time">{relTime(at, now)}</span>
          </button>
        </div>
      ))}
      {list.length > shown.length && <button className="link small muted more" onClick={() => setAll(true)}>Show {list.length - shown.length} more</button>}
      {list.length === 0 && <div className="side-empty">No chats yet.</div>}
    </nav>
  );
}
