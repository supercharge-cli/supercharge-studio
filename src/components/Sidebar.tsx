import { useState } from "react";
import type { AppData, TreeAction } from "../lib/store";
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
};

/** Inline text input: Enter commits, Escape / blur cancels. */
function Inline({ initial = "", placeholder, onDone }: { initial?: string; placeholder?: string; onDone: (v: string | null) => void }) {
  const [v, set] = useState(initial);
  return (
    <input
      autoFocus
      className="inline"
      data-testid="inline-input"
      value={v}
      placeholder={placeholder}
      onChange={(e) => set(e.target.value)}
      onBlur={() => onDone(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v.trim() || null);
        if (e.key === "Escape") onDone(null);
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
  | null;

export function Sidebar(p: Props) {
  const [ed, setEd] = useState<Editing>(null);
  if (p.collapsed)
    return (
      <aside className="sidebar collapsed">
        <button className="icon" title="Expand sidebar" data-testid="expand-sidebar" onClick={p.onToggle}><Icon name="panelLeft" size={18} /></button>
        <button className="icon" title="Settings" onClick={p.onSettings}><Icon name="settings" size={18} /></button>
      </aside>
    );
  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="side-head">
        <span className="logo"><Icon name="bolt" size={16} /></span><strong>Supercharge Studio</strong>
        <div style={{ flex: 1 }} />
        <button className="icon" title="New group" data-testid="add-group" onClick={() => setEd({ kind: "newGroup" })}><Icon name="plus" /></button>
        <button className="icon" title="Collapse sidebar" data-testid="collapse-sidebar" onClick={p.onToggle}><Icon name="panelLeft" /></button>
      </div>
      <nav className="tree">
        {p.data.groups.map((g) => (
          <section key={g.id} className="group" data-testid="group">
            <div className="group-head">
              {ed?.kind === "renameGroup" && ed.id === g.id ? (
                <Inline initial={g.name} onDone={(v) => (v && p.onTree({ type: "renameGroup", groupId: g.id, name: v }), setEd(null))} />
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
              <Inline placeholder="Project name" onDone={(v) => setEd(v ? { kind: "newProjectCwd", groupId: g.id, name: v } : null)} />
            )}
            {ed?.kind === "newProjectCwd" && ed.groupId === g.id && (
              <Inline placeholder="Absolute folder, e.g. /home/me/code/app" onDone={(v) => (v && p.onTree({ type: "addProject", groupId: g.id, name: ed.name, cwd: v }), setEd(null))} />
            )}
            {!g.collapsed &&
              g.projects.map((proj) => (
                <div key={proj.id} data-testid="project" className={`project ${proj.id === p.data.activeProjectId ? "active" : ""}`}>
                  <div className="project-head">
                    {ed?.kind === "renameProject" && ed.id === proj.id ? (
                      <Inline initial={proj.name} onDone={(v) => (v && p.onTree({ type: "renameProject", projectId: proj.id, name: v }), setEd(null))} />
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
                        <Inline initial={c.title} onDone={(v) => (v && p.onTree({ type: "renameChat", chatId: c.id, title: v }), setEd(null))} />
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
        {ed?.kind === "newGroup" && <Inline placeholder="Group name" onDone={(v) => (v && p.onTree({ type: "addGroup", name: v }), setEd(null))} />}
      </nav>
      <div className="side-foot">
        <button className="secondary" data-testid="open-settings" onClick={p.onSettings}><Icon name="settings" /> Settings</button>
      </div>
    </aside>
  );
}
