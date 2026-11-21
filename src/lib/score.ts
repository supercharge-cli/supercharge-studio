/** Fuzzy subsequence score (higher is better), -1 if no match. */
export function score(q: string, s: string): number {
  q = q.toLowerCase();
  s = s.toLowerCase();
  if (!q) return 0;
  let i = 0, sc = 0, prev = -2;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) {
      sc += j === prev + 1 ? 3 : 1;
      if (j === 0 || /[\s/·-]/.test(s[j - 1])) sc += 2;
      prev = j;
      i++;
    }
  }
  return i === q.length ? sc : -1;
}
