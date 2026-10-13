import { useRef, useState } from "react";
import { projectsByCwd, relTime, type AppData, type TreeAction } from "../lib/store";
import { Icon } from "./Icon";

type Props = {
  data: AppData;
  collapsed: boolean;
  onToggle: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectChat: (projectId: string, chatId: string) => void;
  onNewChat: (projectId: string) => void;
  onTree: (a: TreeAction) => void;
  onSettings: () => void;
  onUsage?: () => void;
  onPalette?: () => void;
  /** Open a folder as a project (Projects view). */
  onOpenFolder?: (cwd: string) => void;
  onSidebarView?: (v: "projects" | "groups") => void;
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
  if (p.collapsed)
    return (
      <aside className="sidebar collapsed">
        <button className="icon" title="Expand sidebar" data-testid="expand-sidebar" onClick={p.onToggle}><Icon name="panelLeft" size={18} /></button>
        <button className="icon" title="Usage" onClick={p.onUsage}><Icon name="chart" size={18} /></button>
        <button className="icon" title="Settings" onClick={p.onSettings}><Icon name="settings" size={18} /></button>
      </aside>
    );
  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="side-head">
        <span className="logo"><Icon name="bolt" size={16} /></span><strong>Supercharge Studio</strong>
        <div style={{ flex: 1 }} />
        {byFolder
          ? <button className="icon" title="Open a project folder" data-testid="open-folder" onClick={() => setEd({ kind: "openFolder" })}><Icon name="plus" /></button>
          : <button className="icon" title="New group" data-testid="add-group" onClick={() => setEd({ kind: "newGroup" })}><Icon name="plus" /></button>}
        <button className="icon" title="Collapse sidebar" data-testid="collapse-sidebar" onClick={p.onToggle}><Icon name="panelLeft" /></button>
      </div>
      <div className="side-views" role="tablist">
        <button role="tab" data-testid="view-projects" className={byFolder ? "on" : ""} onClick={() => p.onSidebarView?.("projects")}>Projects</button>
        <button role="tab" data-testid="view-groups" className={!byFolder ? "on" : ""} onClick={() => p.onSidebarView?.("groups")}>Groups</button>
        <div style={{ flex: 1 }} />
        {p.onSync && <button className="icon sm" title="Refresh sessions from the Supercharge CLI" data-testid="sync-sessions" onClick={p.onSync}><Icon name="refresh" size={13} className={p.syncing ? "spin" : ""} /></button>}
      </div>
      {byFolder ? <FolderTree p={p} ed={ed} setEd={setEd} /> : (
      <nav className="tree">
        {p.data.groups.map((g) => (
          <section key={g.id} className="group" data-testid="group">
            <div className="group-head">
              {ed?.kind === "renameGroup" && ed.id === g.id ? (
                <Inline key={`rg-${g.id}`} initial={g.name} onDone={(v) => (v && p.onTree({ type: "renameGroup", groupId: g.id, name: v }), setEd(null))} />
              ) : (
                <button className="link" data-testid="group-name" onClick={() => p.onTree({ type: "toggleGroup", groupId: g.id })} onDoubleClick={() => setEd({ kind: "renameGroup", id: g.id })}>
                  <Icon name={g.collapsed ? "chevronRight" : "chevronDown"} size={12} /> {g.name}
                </button>
              )}
              <div className="acts">
                <button className="icon sm" title="Rename group" data-testid="rename-group" onClick={() => setEd({ kind: "renameGroup", id: g.id })}><Icon name="edit" size={13} /></button>
                <button className="icon sm" title="Add project" data-testid="add-project" onClick={() => setEd({ kind: "newProjectName", groupId: g.id })}><Icon name="plus" size={13} /></button>
                <Del title="Delete group" onConfirm={() => p.onTree({ type: "removeGroup", groupId: g.id })} />
              </div>
            </div>
            {ed?.kind === "newProjectName" && ed.groupId === g.id && (
              <Inline key={`np-${g.id}`} placeholder="Project name" onDone={(v) => setEd(v ? { kind: "newProjectCwd", groupId: g.id, name: v } : null)} />
            )}
            {ed?.kind === "newProjectCwd" && ed.groupId === g.id && (
              <Inline key={`nc-${g.id}`} placeholder="Absolute folder, e.g. /home/me/code/app" onDone={(v) => (v && p.onTree({ type: "addProject", groupId: g.id, name: ed.name, cwd: v }), setEd(null))} />
            )}
            {!g.collapsed &&
              g.projects.map((proj) => (
                <div key={proj.id} data-testid="project" className={`project ${proj.id === p.data.activeProjectId ? "active" : ""}`}>
                  <div className="project-head">
                    {ed?.kind === "renameProject" && ed.id === proj.id ? (
                      <Inline key={`rp-${proj.id}`} initial={proj.name} onDone={(v) => (v && p.onTree({ type: "renameProject", projectId: proj.id, name: v }), setEd(null))} />
                    ) : (
                      <button className="link grow" title={proj.cwd} data-testid="project-name" onClick={() => p.onSelectProject(proj.id)}><Icon name="folder" size={14} /> {proj.name}</button>
                    )}
                    <div className="acts">
                      <button className="icon sm" title="New chat" data-testid="new-chat" onClick={() => p.onNewChat(proj.id)}><Icon name="plus" size={13} /></button>
                      <button className="icon sm" title="Rename project" data-testid="rename-project" onClick={() => setEd({ kind: "renameProject", id: proj.id })}><Icon name="edit" size={13} /></button>
                      <Del title="Remove project" onConfirm={() => p.onTree({ type: "removeProject", projectId: proj.id })} />
                    </div>
                  </div>
                  {proj.chats.map((c) => (
                    <div key={c.id} className={`chat ${c.id === p.data.activeChatId ? "active" : ""}`} data-testid="chat">
                      {ed?.kind === "renameChat" && ed.id === c.id ? (
                        <Inline key={`rc-${c.id}`} initial={c.title} onDone={(v) => (v && p.onTree({ type: "renameChat", chatId: c.id, title: v }), setEd(null))} />
                      ) : (
                        <button className="link grow" data-testid="chat-title" onClick={() => p.onSelectChat(proj.id, c.id)} onDoubleClick={() => setEd({ kind: "renameChat", id: c.id })}>{c.title}</button>
                      )}
                      <div className="acts">
                        <button className="icon sm" title="Rename chat" data-testid="rename-chat" onClick={() => setEd({ kind: "renameChat", id: c.id })}><Icon name="edit" size={13} /></button>
                        <Del title="Delete chat" onConfirm={() => p.onTree({ type: "removeChat", chatId: c.id })} />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
          </section>
        ))}
        {p.data.groups.length === 0 && !ed && <div className="side-empty">No groups yet. Use <Icon name="plus" size={12} /> to create one.</div>}
        {ed?.kind === "newGroup" && <Inline key={"ng"} placeholder="Group name" onDone={(v) => (v && p.onTree({ type: "addGroup", name: v }), setEd(null))} />}
      </nav>
      )}
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
              </div>
            </div>
            {isOpen && shown.map(({ projectId, chat: c }) => (
              <div key={c.id} className={`chat ${c.id === p.data.activeChatId ? "active" : ""}`} data-testid="chat" data-session={c.sessionId ?? ""}>
                {ed?.kind === "renameChat" && ed.id === c.id ? (
                  <Inline key={`rc-${c.id}`} initial={c.title} onDone={(v) => (v && p.onTree({ type: "renameChat", chatId: c.id, title: v }), setEd(null))} />
                ) : (
                  <button className="link grow" data-testid="chat-open" title={c.title} onClick={() => p.onSelectChat(projectId, c.id)} onDoubleClick={() => setEd({ kind: "renameChat", id: c.id })}>
                    <span className="chat-t" data-testid="chat-title">{c.title}</span><span className="muted small chat-time" data-testid="chat-time">{relTime(c.updatedAt ?? c.createdAt, now)}</span>
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
