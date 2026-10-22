import { useEffect, useState } from "react";
import { invoke, isDesktop } from "./desktop";

/** Editor-grade highlighting runs in the native shell (grammars live there, not in the JS bundle).
 *  Returns `<span class="tN">` HTML with escaped text, or null for unknown languages / plain web mode. */
const cache = new Map<string, Promise<string | null>>();
export function highlight(code: string, lang: string): Promise<string | null> {
  if (!isDesktop() || !lang || code.length > 512 * 1024) return Promise.resolve(null);
  const key = `${lang}\u0000${code}`;
  let p = cache.get(key);
  if (!p) {
    p = invoke<string | null>("highlight_code", { code, lang }).catch(() => null);
    cache.set(key, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Highlighted HTML for `code` once ready (null until then, or when there is no grammar). */
export function useHighlight(code: string, lang?: string): string | null {
  const [html, setHtml] = useState<{ k: string; h: string | null } | null>(null);
  const k = `${lang}\u0000${code}`;
  useEffect(() => {
    if (!lang) return;
    let live = true;
    // Streaming replies grow token by token; wait for the block to settle before tokenizing.
    const t = setTimeout(() => void highlight(code, lang).then((h) => live && setHtml({ k, h })), 120);
    return () => { live = false; clearTimeout(t); };
  }, [k]);
  return html && html.k === k ? html.h : null;
}
