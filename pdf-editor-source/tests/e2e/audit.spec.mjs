// M12 — UI accessibility audit with axe-core (WCAG 2.1 A/AA, incl. colour
// contrast) over every screen, panel, toolbar and dialog, in both themes.
import { createRequire } from 'node:module';
import { test, expect, openApp, openFixture } from './helpers.mjs';

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');

async function audit(page, name) {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: AXE });
  // Let transitions settle (axe measures computed colours).
  await page.waitForTimeout(150);
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      // The PDF's own content (canvas, invisible text-selection layer) isn't our UI.
      exclude: [['.textLayer'], ['.page-canvas'], ['.tile-layer']],
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.slice(0, 6).map((n) => `${n.target.join(' ')} — ${n.failureSummary.split('\n').slice(1, 3).join(' ').trim()}`),
      count: v.nodes.length,
    }));
  });
  return result.map((v) => ({ screen: name, ...v }));
}

const cmd = (page, id) => page.evaluate((id) => { window.pdfEditor.commands.getCommand(id).run(); }, id);
const tool = (page, id) => page.evaluate((id) => { window.pdfEditor.registry.getTool(id).run({ app: window.pdfEditor.app }); }, id);
const panel = (page, id) => page.evaluate((id) => window.pdfEditor.app.showPanel(id), id);
const closeDialogs = (page) => page.evaluate(() => {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  for (const d of document.querySelectorAll('dialog')) d.remove();
});

for (const theme of ['light', 'dark']) {
  test(`axe: every screen in the ${theme} theme meets WCAG 2.1 AA`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page);
    const found = [];
    const run = async (name, setup) => {
      await setup?.();
      found.push(...(await audit(page, name)));
    };
    await run('home');
    await openFixture(page, 'annotations.pdf');
    for (const id of ['pages', 'bookmarks', 'layers', 'fields', 'comments', 'attachments', 'properties', 'history']) {
      await run(`panel:${id}`, async () => {
        await panel(page, id);
        await page.waitForTimeout(300);
      });
    }
    await run('find', async () => {
      await page.keyboard.press('Control+f');
      await page.getByRole('search', { name: 'Find in document' }).getByRole('searchbox').fill('text');
      await page.waitForTimeout(300);
    });
    await page.keyboard.press('Escape');
    await run('editing toolbar', () => tool(page, 'add-text'));
    await run('editing toolbar (select)', () => tool(page, 'comment'));
    await page.evaluate(() => window.pdfEditor.app.annotator.deactivate());
    await openFixture(page, 'forms.pdf');
    await run('form layer + fields', () => panel(page, 'fields'));
    await run('prepare form', () => tool(page, 'prepare-form'));
    await page.evaluate(() => window.pdfEditor.app.formEditor.deactivate());
    await run('redaction toolbar', () => tool(page, 'redact'));
    await page.evaluate(() => window.pdfEditor.app.redactor.deactivate());
    await run('organizer', () => tool(page, 'organize-pages'));
    await page.evaluate(() => window.pdfEditor.app.closeOrganizer());
    const dialogs = [
      ['preferences', () => cmd(page, 'app.preferences')],
      ['about', () => cmd(page, 'help.about')],
      ['shortcuts', () => cmd(page, 'help.shortcuts')],
      ['palette', () => page.keyboard.press('Control+k')],
      ['combine', () => tool(page, 'combine-files')],
      ['split', () => tool(page, 'split-document')],
      ['signature', () => tool(page, 'add-signature')],
      ['sanitize', () => tool(page, 'sanitize')],
      ['password', () => tool(page, 'protect-password')],
      ['print', () => tool(page, 'print')],
      ['ocr', () => tool(page, 'ocr')],
      ['accessibility', () => tool(page, 'accessibility-check')],
    ];
    for (const [name, open] of dialogs) {
      await run(`dialog:${name}`, async () => {
        await open();
        await page.waitForTimeout(500);
      });
      await page.keyboard.press('Escape');
      await closeDialogs(page);
    }
    const summary = found.map((v) => `[${v.screen}] ${v.id} (${v.impact}, ${v.count})\n    ${v.nodes.join('\n    ')}`).join('\n');
    if (found.length) console.log(summary);
    expect(found, summary).toEqual([]);
  });
}

test('keyboard only: Tab reaches every region with a visible focus ring; tools open from the keyboard', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp(page);
  await openFixture(page, 'forms.pdf');
  await page.evaluate(() => window.pdfEditor.app.showPanel('fields'));
  await page.locator('body').focus();
  const seen = [];
  const noRing = [];
  for (let i = 0; i < 140; i++) {
    await page.keyboard.press('Tab');
    // Splitters fade their bar in (a short transition): sample after it.
    if (await page.evaluate(() => document.activeElement?.classList.contains('splitter'))) await page.waitForTimeout(250);
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const after = getComputedStyle(el, '::after');
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none')
        // Splitters show an accent bar instead.
        || (el.classList.contains('splitter') && after.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(after.width) >= 2);
      const region = el.closest('.topbar, #tools-panel, .viewer-host, .rail, #side-panel, .status-slot, .formLayer')?.className.split(' ')[0] ?? 'other';
      return { region, ring, label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName };
    });
    if (!info) continue;
    seen.push(info.region);
    if (!info.ring) noRing.push(`${info.region}: ${info.label}`);
  }
  for (const region of ['topbar', 'tools-panel', 'viewer-host', 'rail', 'side-panel', 'status-slot']) {
    expect(seen, `Tab reaches ${region}`).toContain(region);
  }
  expect(noRing, 'every focus stop shows a focus ring').toEqual([]);

  // Tools panel: filter, then Enter on a tool.
  await page.locator('#tools-panel').getByRole('searchbox').focus();
  await page.keyboard.type('redact');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('toolbar', { name: 'Redaction tools' })).toBeVisible();
  await page.locator('.viewer-host:not([hidden]) .viewer').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: 'Redaction tools' })).toBeHidden();

  // Command palette → a dialog → Esc returns focus.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('sanitize');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Sanitize document' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1); // focus moved into the dialog
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
