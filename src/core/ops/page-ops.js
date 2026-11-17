// Page operations, executed inside the pdf-lib worker.
//
// Each op is a self-contained function `(PDFLib, doc, args) => result` — it
// is serialised with Function.prototype.toString() into the worker, so it
// must not reference anything outside its own body (no imports, no closures).
// Return { affected: number[] | null } — the 0-based pages whose content
// changed (null = "anything may have changed").

export function rotatePages(PDFLib, doc, args) {
  const { pages, delta } = args;
  const count = doc.getPageCount();
  for (const index of pages) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError(`No page ${index + 1}`);
    const page = doc.getPage(index);
    const current = page.getRotation().angle || 0;
    page.setRotation(PDFLib.degrees((((current + delta) % 360) + 360) % 360));
  }
  return { affected: [...pages] };
}
