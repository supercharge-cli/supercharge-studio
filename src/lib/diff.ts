/** Small line diff (LCS) for tool-call diffs. Falls back to a plain replace for huge inputs. */
export type DiffLine = { t: " " | "+" | "-"; s: string; a?: number; b?: number };
export type Hunk = { lines: DiffLine[] };

export function diffLines(oldText: string | null | undefined, newText: string): DiffLine[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");
  if (!oldText) return b.map((s, i) => ({ t: "+", s, b: i + 1 }));
  // Trim common prefix/suffix to keep the DP small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid: DiffLine[] = [];
  if (A.length * B.length > 4_000_000) {
    A.forEach((s) => mid.push({ t: "-", s }));
    B.forEach((s) => mid.push({ t: "+", s }));
  } else {
    const n = A.length, m = B.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { mid.push({ t: " ", s: A[i] }); i++; j++; }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { mid.push({ t: "-", s: A[i] }); i++; }
      else { mid.push({ t: "+", s: B[j] }); j++; }
    }
  }
  const out: DiffLine[] = [...a.slice(0, pre).map((s) => ({ t: " " as const, s })), ...mid, ...a.slice(a.length - suf).map((s) => ({ t: " " as const, s }))];
  let x = 0, y = 0;
  for (const l of out) {
    if (l.t !== "+") l.a = ++x;
    if (l.t !== "-") l.b = ++y;
  }
  return out;
}

/** Group changes into hunks with `ctx` context lines. */
export function hunks(lines: DiffLine[], ctx = 3): Hunk[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.t !== " ") for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = 1;
  });
  const out: Hunk[] = [];
  let cur: DiffLine[] | null = null;
  lines.forEach((l, i) => {
    if (keep[i]) (cur ??= []).push(l);
    else if (cur) { out.push({ lines: cur }); cur = null; }
  });
  if (cur) out.push({ lines: cur });
  return out;
}

export const diffStats = (lines: DiffLine[]) => ({ add: lines.filter((l) => l.t === "+").length, del: lines.filter((l) => l.t === "-").length });
