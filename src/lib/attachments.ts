/**
 * Attachments for prompts (desktop composer and the mobile app).
 * Images → ACP image blocks, small text → embedded resource, anything else → uploaded and sent as
 * a resource_link. Devices upload through `_supercharge/upload` in chunks (see src-tauri/src/uploads.rs).
 */
export type Attachment = { id: string; name: string; mime: string; size: number; bytes: Uint8Array; preview?: string };
export type Uploaded = { uploadId: string; uri: string; path: string; name: string; mimeType: string; size: number };
export type SendChunk = (params: { uploadId: string; name: string; mimeType: string; size: number; index: number; total: number; data: string }) => Promise<any>;

export const MAX_FILE = 25 * 1024 * 1024;
export const MAX_IMAGE = 8 * 1024 * 1024;
export const MAX_EMBED_TEXT = 256 * 1024;
export const MAX_ATTACHMENTS = 10;
export const CHUNK = 160 * 1024;

const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|graphql|proto|lua|r|dart|vue|svelte|env|gitignore|dockerfile|makefile)$/i;
export const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/i.test(mime);
export const isText = (name: string, mime: string) => mime.startsWith("text/") || /json|xml|yaml|toml|javascript|typescript|x-sh/.test(mime) || TEXT_EXT.test(name);

export function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Why a file can't be attached, or null. */
export function rejectReason(f: { name: string; size: number; type: string }, count: number): string | null {
  if (count >= MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} attachments per message.`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (f.size > MAX_FILE) return `${f.name} is ${fmtSize(f.size)}; the limit is ${fmtSize(MAX_FILE)}.`;
  if (isImage(f.type) && f.size > MAX_IMAGE) return `${f.name} is ${fmtSize(f.size)}; images can be up to ${fmtSize(MAX_IMAGE)}.`;
  return null;
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Keep the picked name. A `grok_` prefix (cache or share sheet) becomes `supercharge_`. */
export function attachmentName(name: string, mime: string): string {
  const base = (name || (isImage(mime) ? `pasted-image.${mime.split("/")[1] || "png"}` : "file")).replace(/^grok_/i, "supercharge_");
  return base.replace(/[/\\]/g, "_");
}

export async function fromFile(f: File): Promise<Attachment> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const mime = f.type || (isText(f.name, "") ? "text/plain" : "application/octet-stream");
  return { id: rid(), name: attachmentName(f.name, mime), mime, size: bytes.length, bytes, preview: isImage(mime) ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })) : undefined };
}

/** Upload one attachment in ordered chunks; resolves with where it was saved. */
export async function upload(a: Attachment, send: SendChunk, onProgress?: (done: number) => void): Promise<Uploaded> {
  const total = Math.max(1, Math.ceil(a.bytes.length / CHUNK));
  const uploadId = rid();
  let last: any;
  for (let index = 0; index < total; index++) {
    last = await send({ uploadId, name: a.name, mimeType: a.mime, size: a.size, index, total, data: b64(a.bytes.subarray(index * CHUNK, (index + 1) * CHUNK)) });
    onProgress?.((index + 1) / total);
  }
  return last as Uploaded;
}

export type Caps = { image?: boolean; embeddedContext?: boolean };

/**
 * ACP content blocks for attachments. `send` uploads a file and is used for anything that is not
 * an inline image or small text (when absent, e.g. web mode, files are embedded as blobs).
 */
export async function toBlocks(atts: Attachment[], caps: Caps, send?: SendChunk): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const a of atts) {
    if (isImage(a.mime) && caps.image !== false && a.size <= MAX_IMAGE) {
      out.push({ type: "image", mimeType: a.mime, data: b64(a.bytes) });
      continue;
    }
    if (isText(a.name, a.mime) && a.size <= MAX_EMBED_TEXT && caps.embeddedContext !== false) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(a.bytes);
      if (!text.includes("\u0000")) {
        out.push({ type: "resource", resource: { uri: `attachment:///${encodeURIComponent(a.name)}`, mimeType: a.mime.startsWith("text/") ? a.mime : "text/plain", text } });
        continue;
      }
    }
    if (send) {
      const u = await upload(a, send);
      out.push({ type: "resource_link", uri: u.uri, name: u.name, mimeType: u.mimeType, size: u.size });
    } else {
      out.push({ type: "resource", resource: { uri: `attachment:///${encodeURIComponent(a.name)}`, mimeType: a.mime, blob: b64(a.bytes) } });
    }
  }
  return out;
}

/** Phone side: every attachment is uploaded first (frames are small), then linked by upload id. */
export async function deviceBlocks(atts: Attachment[], send: SendChunk, onProgress?: (i: number, p: number) => void): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const [i, a] of atts.entries()) {
    const u = await upload(a, send, (p) => onProgress?.(i, p));
    out.push({ type: "resource_link", uri: u.uri, name: u.name, mimeType: u.mimeType, size: u.size, _meta: { supercharge: { uploadId: u.uploadId } } });
  }
  return out;
}

/** Short label for a user bubble ("📎 a.png, notes.txt"). */
export const attachmentLabel = (atts: { name: string }[]) => (atts.length ? atts.map((a) => a.name).join(", ") : "");
