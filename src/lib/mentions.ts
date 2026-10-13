import type { FileEntry } from "./desktop";
import { filterItems, MenuItem } from "./composer";

/** Mentions in a message: `@path` or `@"path with spaces"`, only those that exist in the project. */
export function extractMentions(text: string, files: FileEntry[]): FileEntry[] {
  const known = new Map(files.map((f) => [f.path, f]));
  const out: FileEntry[] = [];
  const re = /(^|\s)@(?:"([^"]+)"|([^\s"]+))/g;
  for (const m of text.matchAll(re)) {
    let p = (m[2] ?? m[3]).replace(/[.,;:!?)]+$/, "");
    const f = known.get(p) ?? known.get(`${p}/`);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

const join = (root: string, rel: string) => `${root.replace(/[\\/]+$/, "")}/${rel}`.replace(/\/+$/, "");
export const fileUri = (abs: string) => {
  const p = abs.replace(/\\/g, "/");
  return `file://${p.startsWith("/") ? "" : "/"}${p.split("/").map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join("/")}`;
};
const MIME: Record<string, string> = { md: "text/markdown", ts: "text/x-typescript", tsx: "text/x-typescript", js: "text/javascript", json: "application/json", rs: "text/x-rust", py: "text/x-python", html: "text/html", css: "text/css", toml: "application/toml", yml: "application/yaml", yaml: "application/yaml" };

/**
 * ACP content blocks for mentioned files: small text files are embedded as resources when the agent
 * accepts embedded context; folders and everything else become resource links.
 */
export async function mentionBlocks(root: string, mentions: FileEntry[], embed: boolean, read: (rel: string) => Promise<string>): Promise<unknown[]> {
  const blocks: unknown[] = [];
  for (const f of mentions.slice(0, 20)) {
    const abs = join(root, f.path);
    const uri = fileUri(abs);
    const name = f.path.replace(/\/$/, "").split("/").pop() || f.path;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const mimeType = f.dir ? "inode/directory" : MIME[ext] ?? "text/plain";
    if (!f.dir && embed) {
      const text = await read(f.path).catch(() => null);
      if (text !== null) { blocks.push({ type: "resource", resource: { uri, mimeType, text } }); continue; }
    }
    blocks.push({ type: "resource_link", uri, name, mimeType });
  }
  return blocks;
}

/** Picker rows: basename matches rank above path-only matches; folders get a trailing slash. */
export function fileItems(files: FileEntry[], q: string): MenuItem[] {
  const items: MenuItem[] = files.map((f) => {
    const base = f.path.replace(/\/$/, "").split("/").pop()! + (f.dir ? "/" : "");
    const dir = f.path.slice(0, f.path.length - base.length);
    return { id: f.path, label: base, detail: dir || undefined, icon: f.dir ? "folder" : "file", value: f.path };
  });
  if (!q) return items.filter((i) => !i.detail).slice(0, 60); // top level first
  if (q.includes("/")) {
    const ql = q.toLowerCase();
    const pref = items.filter((i) => i.value.toLowerCase().startsWith(ql));
    const rest = filterItems(items.filter((i) => !pref.includes(i)).map((i) => ({ ...i, label: i.value })), q, 60).map((i) => ({ ...i, label: i.value.replace(/\/$/, "").split("/").pop()! + (i.value.endsWith("/") ? "/" : "") }));
    return [...pref.slice(0, 60), ...rest].slice(0, 60);
  }
  return filterItems(items, q, 60);
}
