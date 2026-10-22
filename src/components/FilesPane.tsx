import { useEffect, useMemo, useState } from "react";
import { FileEntry, projectDir, projectFiles, projectReadText } from "../lib/desktop";
import { Icon } from "./Icon";
import { fileIcon } from "../lib/fileIcons";

type Node = { name: string; path: string; dir: boolean; ignored?: boolean; partial?: boolean; children: Node[] };

function tree(entries: FileEntry[]): Node[] {
  const dirs = new Map<string, Node>();
  const roots: Node[] = [];
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const e of sorted) {
    const path = e.path;
    const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
    const slash = trimmed.lastIndexOf("/");
    const name = slash < 0 ? trimmed : trimmed.slice(slash + 1);
    const parent = slash < 0 ? "" : trimmed.slice(0, slash + 1);
    const node: Node = { name, path, dir: e.dir, ignored: e.ignored, partial: e.partial, children: [] };
    if (e.dir) dirs.set(path, node);
    const folder = parent ? dirs.get(parent) : undefined;
    if (folder) folder.children.push(node);
    else roots.push(node);
  }
  const order = (nodes: Node[]) => {
    nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    nodes.forEach((n) => order(n.children));
  };
  order(roots);
  return roots;
}

function Row({ node, depth, open, toggle, selected, onOpen }: { node: Node; depth: number; open: Set<string>; toggle: (p: string) => void; selected: string; onOpen: (n: Node) => void }) {
  const expanded = open.has(node.path);
  return (
    <>
      <button
        className={`file-row ${selected === node.path ? "on" : ""} ${node.ignored ? "ignored" : ""}`}
        data-path={node.path}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (node.dir ? toggle(node.path) : onOpen(node))}
      >
        <svg className="file-ico" width="15" height="15" aria-hidden="true"><use href={`/icons/files.svg#${fileIcon(node.name, node.dir, expanded)}`} /></svg>
        <span>{node.name}</span>
      </button>
      {node.dir && expanded && node.partial && <div className="muted small file-more" style={{ paddingLeft: 22 + depth * 14 }}>Loading…</div>}
      {node.dir && expanded && !node.partial && node.children.length === 0 && <div className="muted small file-more" style={{ paddingLeft: 22 + depth * 14 }}>Empty</div>}
      {node.dir && expanded && node.children.map((c) => (
        <Row key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} selected={selected} onOpen={onOpen} />
      ))}
    </>
  );
}

/** Project files in the right panel. Click a file to read it. */
export function FilesPane({ cwd }: { cwd?: string }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [body, setBody] = useState("");
  const [reading, setReading] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);

  useEffect(() => {
    if (!cwd) { setEntries([]); setError("Open a project to see its files."); return; }
    let stop = false;
    setError("");
    void projectFiles(cwd).then((list) => { if (!stop) setEntries(list); }, (e) => { if (!stop) setError(String(e?.message ?? e)); });
    return () => { stop = true; };
  }, [cwd]);

  const nodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ign = showIgnored ? [] : entries.filter((e) => e.ignored).map((e) => e.path);
    const visible = ign.length ? entries.filter((e) => !e.ignored && !ign.some((p) => p.endsWith("/") && e.path.startsWith(p))) : entries;
    const list = q ? visible.filter((e) => !e.dir && e.path.toLowerCase().includes(q)) : visible;
    return tree(q ? list.map((e) => ({ ...e, dir: false })) : list);
  }, [entries, query, showIgnored]);
  const ignoredCount = useMemo(() => entries.filter((e) => e.ignored).length, [entries]);
  const partialCount = useMemo(() => entries.filter((e) => e.partial && !e.ignored).length, [entries]);

  /** Load a folder the full listing left unread (depth/size cap or ignored). */
  const expandPartial = (path: string) => {
    if (!cwd) return;
    void projectDir(cwd, path).then(
      (kids) => setEntries((cur) => {
        const have = new Set(cur.map((e) => e.path));
        const inherit = cur.find((e) => e.path === path)?.ignored;
        return [...cur.map((e) => (e.path === path ? { ...e, partial: false } : e)), ...kids.filter((k) => !have.has(k.path)).map((k) => (inherit ? { ...k, ignored: true } : k))];
      }),
      () => setEntries((cur) => cur.map((e) => (e.path === path ? { ...e, partial: false } : e))),
    );
  };

  const read = (node: Node) => {
    if (!cwd) return;
    setSelected(node.path);
    setReading(node.path);
    setBody("");
    void projectReadText(cwd, node.path).then(
      (text) => { setBody(text); setReading(""); },
      (e) => { setBody(String(e?.message ?? e)); setReading(""); },
    );
  };

  const toggle = (path: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(path)) next.delete(path);
    else { next.add(path); if (entries.find((e) => e.path === path)?.partial) expandPartial(path); }
    return next;
  });

  return (
    <div className="files-pane" data-testid="files-pane">
      <input className="file-find" placeholder="Filter files" aria-label="Filter files" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="files-split">
        <div className="file-tree" role="tree">
          {(ignoredCount > 0 || partialCount > 0) && (
            <div className="file-meta muted small" data-testid="files-meta">
              {ignoredCount > 0 && <label><input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} data-testid="files-show-ignored" /> Show ignored ({ignoredCount})</label>}
              {partialCount > 0 && <span title="Large or deep project: these folders load when you open them">{partialCount} {partialCount === 1 ? "folder loads" : "folders load"} on open</span>}
            </div>
          )}
          {error && <p className="muted small">{error}</p>}
          {!error && nodes.length === 0 && <p className="muted small">No files.</p>}
          {nodes.map((n) => <Row key={n.path} node={n} depth={0} open={open} toggle={toggle} selected={selected} onOpen={read} />)}
        </div>
        <pre className="file-view" data-testid="file-view">{reading ? "Reading…" : body || "Select a file to read it."}</pre>
      </div>
    </div>
  );
}
