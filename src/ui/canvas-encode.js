// Encode a canvas to an image Blob reliably.
//
// Chromium runs canvas.toBlob() encoding in idle time; on a busy page its
// callback can be postponed for many seconds (we saw thumbnails stall). So we
// give toBlob() a short head start and otherwise encode synchronously with
// toDataURL() — a small thumbnail costs a few milliseconds.

export async function canvasToBlob(canvas, type = 'image/png', { timeout = 800 } = {}) {
  const viaToBlob = new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type);
    } catch {
      resolve(null);
    }
  });
  const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeout));
  const result = await Promise.race([viaToBlob, timer]);
  if (result && result !== 'timeout') return result;
  const dataUrl = canvas.toDataURL(type);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
