import type { AppData } from "../lib/store";

type Props = {
  data: AppData;
  collapsed: boolean;
  onToggle: () => void;
  onSelectChat: (projectId: string, chatId: string) => void;
  onNewChat: (projectId: string) => void;
  onAddGroup: () => void;
  onAddProject: (groupId: string) => void;
  onToggleGroup: (groupId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onSettings: () => void;
};

export function Sidebar(p: Props) {
  if (p.collapsed)
    return (
      <aside className="sidebar collapsed">
        <button className="icon" title="Expand sidebar" onClick={p.onToggle}>»</button>
        <button className="icon" title="Settings" onClick={p.onSettings}>⚙</button>
      </aside>
    );
  return (
    <aside className="sidebar">
      <div className="side-head">
        <strong>Supercharge Studio</strong>
        <div style={{ flex: 1 }} />
        <button className="icon" title="New group" onClick={p.onAddGroup}>＋</button>
        <button className="icon" title="Collapse sidebar" onClick={p.onToggle}>«</button>
      </div>
      <nav className="tree">
        {p.data.groups.map((g) => (
          <section key={g.id} className="group">
            <div className="group-head">
              <button className="link" onClick={() => p.onToggleGroup(g.id)}>
                {g.collapsed ? "▸" : "▾"} {g.name}
              </button>
              <button className="icon sm" title="Add project" onClick={() => p.onAddProject(g.id)}>＋</button>
            </div>
            {!g.collapsed &&
              g.projects.map((proj) => (
                <div key={proj.id} className={`project ${proj.id === p.data.activeProjectId ? "active" : ""}`}>
                  <div className="project-head">
                    <span title={proj.cwd}>{proj.name}</span>
                    <div style={{ flex: 1 }} />
                    <button className="icon sm" title="New chat" onClick={() => p.onNewChat(proj.id)}>✎</button>
                    <button className="icon sm" title="Remove project" onClick={() => p.onRemoveProject(proj.id)}>×</button>
                  </div>
                  {proj.chats.map((c) => (
                    <button
                      key={c.id}
                      className={`chat ${c.id === p.data.activeChatId ? "active" : ""}`}
                      onClick={() => p.onSelectChat(proj.id, c.id)}
                    >
                      {c.title}
                    </button>
                  ))}
                </div>
              ))}
          </section>
        ))}
      </nav>
      <div className="side-foot">
        <button className="secondary" onClick={p.onSettings}>⚙ Settings</button>
      </div>
    </aside>
  );
}
