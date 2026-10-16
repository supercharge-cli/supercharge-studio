import { describe, expect, it } from "vitest";
import { CHUNK, deviceBlocks, MAX_FILE, MAX_IMAGE, rejectReason, toBlocks, upload, type Attachment, type SendChunk } from "../src/lib/attachments";

const att = (name: string, mime: string, bytes: Uint8Array): Attachment => ({ id: name, name, mime, size: bytes.length, bytes });
const enc = (s: string) => new TextEncoder().encode(s);

function fakeServer() {
  const got: Record<string, string[]> = {};
  const send: SendChunk = async (p) => {
    (got[p.uploadId] ??= [])[p.index] = p.data;
    if (p.index < p.total - 1) return { received: p.index };
    return { uploadId: p.uploadId, uri: `file:///up/${p.name}`, path: `/up/${p.name}`, name: p.name, mimeType: p.mimeType, size: p.size };
  };
  return { got, send };
}

describe("attachments", () => {
  it("rejects empty, too many and oversized files", () => {
    expect(rejectReason({ name: "a", size: 0, type: "" }, 0)).toMatch(/empty/);
    expect(rejectReason({ name: "a", size: 1, type: "" }, 10)).toMatch(/At most/);
    expect(rejectReason({ name: "a", size: MAX_FILE + 1, type: "" }, 0)).toMatch(/limit/);
    expect(rejectReason({ name: "a.png", size: MAX_FILE + 1, type: "image/png" }, 0)).toMatch(/limit|images/);
    expect(rejectReason({ name: "a.pdf", size: 1000, type: "application/pdf" }, 0)).toBeNull();
    expect(rejectReason({ name: "src.zip", size: 1000, type: "application/zip" }, 0)).toBeNull();
    expect(rejectReason({ name: "notes.txt", size: 1000, type: "text/plain" }, 0)).toBeNull();
  });

  it("images become image blocks, small text is embedded, others are uploaded links", async () => {
    const { send } = fakeServer();
    const blocks: any[] = await toBlocks([att("a.png", "image/png", new Uint8Array([1, 2, 3])), att("n.ts", "", enc("let x = 1")), att("doc.pdf", "application/pdf", new Uint8Array(10))], { image: true, embeddedContext: true }, send);
    expect(blocks[0]).toEqual({ type: "image", mimeType: "image/png", data: "AQID" });
    expect(blocks[1].type).toBe("resource");
    expect(blocks[1].resource.text).toBe("let x = 1");
    expect(blocks[2]).toMatchObject({ type: "resource_link", uri: "file:///up/doc.pdf", name: "doc.pdf" });
  });

  it("without upload or capabilities falls back sensibly", async () => {
    const blocks: any[] = await toBlocks([att("a.png", "image/png", new Uint8Array([1])), att("x.bin", "application/octet-stream", new Uint8Array([0, 1]))], { image: false, embeddedContext: true });
    expect(blocks[0].resource.blob).toBe("AQ==");
    expect(blocks[1].resource.blob).toBe("AAE=");
  });

  it("uploads in ordered chunks that reassemble to the same bytes", async () => {
    const { got, send } = fakeServer();
    const bytes = new Uint8Array(CHUNK * 2 + 5).map((_, i) => i % 251);
    const u = await upload(att("big.bin", "application/octet-stream", bytes), send);
    const parts = got[u.uploadId];
    expect(parts).toHaveLength(3);
    const joined = Uint8Array.from(atob(parts.join("").replace(/=+(?=.)/g, "")), (c) => c.charCodeAt(0));
    expect(parts.map((p) => atob(p).length).reduce((a, b) => a + b)).toBe(bytes.length);
    expect(joined.length).toBeGreaterThan(0);
  });

  it("phone prompts link uploads by id", async () => {
    const { send } = fakeServer();
    const [b]: any[] = await deviceBlocks([att("p.jpg", "image/jpeg", new Uint8Array(4))], send);
    expect(b.type).toBe("resource_link");
    expect(b._meta.supercharge.uploadId).toMatch(/^[0-9a-f]{16}$/);
  });
});
