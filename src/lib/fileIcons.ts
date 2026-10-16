/** Maps a file or folder to a symbol in public/icons/files.svg (MIT, see public/icons/LICENSE.txt). */
const BY_NAME: Record<string, string> = {
  "package.json": "nodejs", "bun.lock": "lock", "bun.lockb": "lock", "package-lock.json": "lock", "yarn.lock": "lock", "pnpm-lock.yaml": "lock", "cargo.lock": "lock",
  "cargo.toml": "rust", dockerfile: "docker", ".gitignore": "git", ".gitattributes": "git", license: "license", "license.md": "license", "license.txt": "license",
  "readme.md": "readme", readme: "readme", ".env": "settings", ".editorconfig": "settings", "tsconfig.json": "settings",
};
const BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "react_ts", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react",
  json: "json", jsonc: "json", md: "markdown", mdx: "markdown", rs: "rust", py: "python", go: "go", html: "html", htm: "html", css: "css", scss: "sass", sass: "sass",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", ico: "image", bmp: "image", svg: "svg", pdf: "pdf",
  zip: "zip", gz: "zip", tgz: "zip", tar: "zip", "7z": "zip", lock: "lock", toml: "toml", yaml: "yaml", yml: "yaml", ini: "settings", conf: "settings", cfg: "settings",
  sh: "console", bash: "console", zsh: "console", ps1: "console", bat: "console", sql: "database", db: "database", sqlite: "database", xml: "xml",
  java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", swift: "swift", kt: "kotlin", kts: "kotlin", rb: "ruby", php: "php", vue: "vue", svelte: "svelte",
  mp4: "video", webm: "video", mov: "video", mp3: "audio", wav: "audio", ogg: "audio", ttf: "font", otf: "font", woff: "font", woff2: "font", txt: "document",
};
export function fileIcon(name: string, dir: boolean, open = false): string {
  if (dir) return open ? "folder-open" : "folder";
  const n = name.toLowerCase();
  if (BY_NAME[n]) return BY_NAME[n];
  if (n.startsWith(".env")) return "settings";
  const dot = n.lastIndexOf(".");
  return (dot > 0 && BY_EXT[n.slice(dot + 1)]) || "document";
}
