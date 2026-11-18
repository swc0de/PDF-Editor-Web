// Small fuzzy matcher for the command palette.
// Returns a score (higher is better) or -Infinity for no match.

const isBoundary = (text, i) => i === 0 || /[\s\-_.:/()&]/.test(text[i - 1]) ||
  (text[i] !== text[i].toLowerCase() && text[i - 1] === text[i - 1].toLowerCase());

export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const lower = text.toLowerCase();

  // Contiguous substring: best, especially at a word start.
  const idx = lower.indexOf(q);
  if (idx >= 0) {
    return 1000 - idx * 2 + (isBoundary(text, idx) ? 200 : 0) + (idx === 0 ? 100 : 0) - (text.length - q.length) * 0.5;
  }

  // Every word of the query found as a substring (any order).
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => lower.includes(w))) {
    return 600 - (text.length - q.length) * 0.5;
  }

  // Scattered-letter matches are noise for very short queries.
  if (q.replace(/\s+/g, '').length < 3) return -Infinity;

  // Subsequence: reward consecutive runs and word-start hits.
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q.replace(/\s+/g, '')) {
    let found = -1;
    for (let i = ti; i < lower.length; i++) {
      if (lower[i] === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return -Infinity;
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 8 + (isBoundary(text, found) ? 15 : 0) - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score;
}
