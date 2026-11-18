// OCR text layer (worker). Signature: (PDFLib, doc, args, { helpers }).

/**
 * Add an invisible text layer (render mode 3) over recognized words, so the
 * page can be searched, selected and copied. Replaces an earlier OCR layer on
 * the same page. args.pages: [{ page, words: [{ text, x, y, dx, dy, w, size }] }]
 * where (x, y) is the start of the word's baseline in PDF space, (dx, dy) the
 * unit text direction, w its length along it and size the font size.
 */
export async function addTextLayer(PDFLib, doc, args, { helpers: H }) {
  const { PDFName, PDFArray, PDFStream, PDFRef, PDFBool } = PDFLib;
  const N = (n) => PDFName.of(n);
  const ctx = doc.context;
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const emb = PDFLib.StandardFontEmbedder.for('Helvetica');
  const f = (n) => (Math.round(n * 1000) / 1000).toString();
  const affected = [];
  let words = 0;
  for (const { page: index, words: list } of args.pages) {
    const page = doc.getPage(index);
    H.removeOcrLayer(PDFLib, doc, page);
    const key = page.node.newFontDictionary('OCRText', font.ref);
    const ops = ['BT', '3 Tr'];
    for (const wd of list) {
      // The standard font can only encode WinAnsi; anything else becomes '?'.
      const text = [...String(wd.text)].map((ch) => (emb.encoding.canEncodeUnicodeCodePoint(ch.codePointAt(0)) ? ch : '?')).join('');
      if (!text || !(wd.w > 0) || !(wd.size > 0)) continue;
      const at1 = emb.widthOfTextAtSize(text, 1) || 1;
      const sx = wd.w / at1; // stretch so the word spans exactly its box
      const nx = -wd.dy;
      const ny = wd.dx;
      ops.push(`${f(wd.dx * sx)} ${f(wd.dy * sx)} ${f(nx * wd.size)} ${f(ny * wd.size)} ${f(wd.x)} ${f(wd.y)} Tm /${key.asString().slice(1)} 1 Tf ${emb.encodeText(`${text} `).toString()} Tj`);
      words++;
    }
    ops.push('ET');
    const mark = (contents) => {
      const stream = ctx.flateStream(contents);
      stream.dict.set(N('PDFEditorOCR'), PDFBool.True);
      return ctx.register(stream);
    };
    // Keep the page's own graphics state from leaking into the text layer.
    page.node.wrapContentStreams(mark('q'), mark('Q'));
    page.node.addContentStream(mark(ops.join('\n')));
    affected.push(index);
  }
  return { affected, value: { words } };
}
