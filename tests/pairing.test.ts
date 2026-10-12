import { describe, expect, it } from "vitest";
import { b64, PAIR_ERROR, parsePairUri } from "../src/gateway/crypto";
import { scanContent } from "../src/mobile/scan";

const secret = b64.enc(new Uint8Array(32).fill(7)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const good = `scstudio://pair?u=ws%3A%2F%2F192.168.1.5%3A2420&i=p-58384a9302862be0&k=${secret}&n=My%20PC`;

describe("pairing code parsing", () => {
  it("parses a real code", () => {
    const p = parsePairUri(good);
    expect(p.url).toBe("ws://192.168.1.5:2420");
    expect(p.pairingId).toBe("p-58384a9302862be0");
    expect(p.secret.length).toBe(32);
    expect(p.desktopName).toBe("My PC");
    expect(p.relay).toBeUndefined();
  });
  it("accepts both schemes, a relay, whitespace, padding and surrounding text", () => {
    expect(parsePairUri(good.replace("scstudio:", "supercharge-studio:")).pairingId).toBe("p-58384a9302862be0");
    expect(parsePairUri(`${good}&r=wss%3A%2F%2Frelay.example.com`).relay).toBe("wss://relay.example.com");
    expect(parsePairUri(`  \n${good}\r\n`).url).toBe("ws://192.168.1.5:2420");
    expect(parsePairUri(good.replace(secret, secret + "=")).secret.length).toBe(32);
    expect(parsePairUri(`Pair with: ${good}`).pairingId).toBe("p-58384a9302862be0");
    expect(parsePairUri(encodeURIComponent(good)).pairingId).toBe("p-58384a9302862be0");
    expect(parsePairUri(good.replace("pair?", "pair/?")).pairingId).toBe("p-58384a9302862be0");
  });
  it("defaults the desktop name and caps its length", () => {
    expect(parsePairUri(good.replace("&n=My%20PC", "")).desktopName).toBe("Desktop");
    expect(parsePairUri(good.replace("My%20PC", "x".repeat(500))).desktopName.length).toBe(80);
  });
  const bad: unknown[] = [
    undefined, null, 42, {}, [], "", "   ", "hello", "https://example.com", "WIFI:S:home;T:WPA;P:secret;;",
    "scstudio://pair", "scstudio://pair?", "scstudio://pair?u=&i=&k=",
    good.replace(/&k=[^&]+/, ""), good.replace(/u=[^&]+/, "u=http%3A%2F%2Fx"), good.replace(/u=[^&]+/, "u=ws%3A%2F%2F"),
    good.replace(secret, "short"), good.replace(secret, "!!!!"), good.replace(secret, secret + secret),
    good.replace(/i=[^&]+/, "i=bad%20id%3Cscript%3E"), `${good}&r=javascript%3Aalert(1)`, `${good}&r=wss%3A%2F%2F`,
    "scstudio%3A%2F%2Fpair%3Fu%3D%25E0%25A4%25A", "scstudio://pair?u=%E0%A4%A&i=x&k=y", "x".repeat(5000), good.slice(0, 40), "\u0000\u0001\uffff",
  ];
  it.each(bad.map((b, i) => [i, b]))("rejects bad input #%i with a readable Error", (_i, input) => {
    let err: unknown;
    try { parsePairUri(input); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeGreaterThan(10);
  });
  it("uses the friendly message for unrelated QR codes", () => {
    expect(() => parsePairUri("https://example.com")).toThrow(PAIR_ERROR);
  });
});

describe("scanner result", () => {
  it("extracts only usable text", () => {
    expect(scanContent({ content: good, format: "QR_CODE" })).toBe(good);
    expect(scanContent(good)).toBe(good);
    for (const r of [null, undefined, 1, {}, { content: 5 }, { content: "" }, { content: "  " }, []]) expect(scanContent(r)).toBeNull();
  });
});
