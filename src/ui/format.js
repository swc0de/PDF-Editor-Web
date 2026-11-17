// Formatting helpers for sizes and dates.

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

export function formatRelativeTime(ms, now = Date.now()) {
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  const pick = abs < 60 ? [diff, 'second'] : abs < 3600 ? [diff / 60, 'minute'] : abs < 86400 ? [diff / 3600, 'hour']
    : abs < 604800 ? [diff / 86400, 'day'] : null;
  if (pick && rtf) return rtf.format(Math.round(pick[0]), pick[1]);
  return new Date(ms).toLocaleDateString();
}
