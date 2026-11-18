// M9 — forms and signatures.
import { readFileSync } from 'node:fs';
import { PDFDocument, decodePDFRawStream } from 'pdf-lib';
import { test, expect, openApp, openFixture, pageIn, shot } from './helpers.mjs';

const panel = (page) => page.locator('#side-panel');
const lastLabel = (page) => page.evaluate(() => window.pdfEditor.app.activeTab.model.history.current.label);
async function stepDone(page, label) {
  await expect.poll(() => lastLabel(page)).toBe(label);
  await page.waitForFunction(() => !window.pdfEditor.app.activeTab.model.busy);
}
/** Start a tool (without waiting for it: some open dialogs). */
const run = (page, id) => page.evaluate((id) => { window.pdfEditor.registry.getTool(id).run({ app: window.pdfEditor.app }); }, id);

/** Widget annotations pdf.js reads from page n of the active tab. */
const widgets = (page, n = 1) => page.evaluate(async (n) => {
  const proxy = await window.pdfEditor.app.activeTab.pdf.getPage(n);
  return (await proxy.getAnnotations()).filter((a) => a.subtype === 'Widget').map((a) => ({
    id: a.id, name: a.fieldName, type: a.fieldType, value: a.fieldValue, rect: [...a.rect], required: !!a.required, options: a.options?.map((o) => o.exportValue) ?? null,
  }));
}, n);
const stamps = (page, n = 1) => page.evaluate(async (n) => {
  const proxy = await window.pdfEditor.app.activeTab.pdf.getPage(n);
  return (await proxy.getAnnotations()).filter((a) => a.subtype === 'Stamp').map((a) => ({ id: a.id, rect: [...a.rect], hasAppearance: a.hasAppearance, contents: a.contentsObj?.str }));
}, n);

async function save(page, name) {
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return path;
}

async function reopen(page, path, name) {
  await page.evaluate(() => document.querySelectorAll('.viewer').forEach((v) => v.classList.add('stale-viewer')));
  await page.setInputFiles('#file-input', path);
  await page.waitForSelector('.viewer-host:not([hidden]) .viewer:not(.stale-viewer) .page[data-page-number="1"][data-state="rendered"]');
  await expect(page.getByRole('tab', { name: new RegExp(name) })).toHaveAttribute('aria-selected', 'true');
}

/** Drag on page n between two points in page-relative CSS px. */
async function drag(page, n, from, to) {
  const pb = await pageIn(page, n).boundingBox();
  await page.mouse.move(pb.x + from[0], pb.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(pb.x + to[0], pb.y + to[1], { steps: 6 });
  await page.mouse.up();
}

const host = (page) => page.locator('.viewer-host:not([hidden])');

test.describe('forms and signatures', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
  });

  test('fill every field kind, undo in place, save and reopen keeps the values', async ({ page }) => {
    await openFixture(page, 'forms.pdf');
    const h = host(page);
    await expect(h.getByRole('textbox', { name: 'full_name' })).toHaveValue('Ada Lovelace');
    await expect(h.getByRole('checkbox', { name: 'subscribe' })).toBeChecked();
    await expect(h.getByRole('radio', { name: 'plan: pro' })).toBeChecked();
    await expect(h.getByRole('combobox', { name: 'country' })).toHaveValue('France');

    await h.getByRole('textbox', { name: 'full_name' }).fill('Grace Hopper');
    await page.keyboard.press('Tab');
    await stepDone(page, 'Fill full_name');
    // Focus moved on to the next field and stays there through the reload.
    await expect(h.getByRole('textbox', { name: 'notes' })).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Line A\nLine B');
    await page.keyboard.press('Tab');
    await stepDone(page, 'Fill notes');
    await h.getByRole('checkbox', { name: 'subscribe' }).click();
    await stepDone(page, 'Fill subscribe');
    await h.getByRole('radio', { name: 'plan: team' }).click();
    await stepDone(page, 'Fill plan');
    await h.getByRole('combobox', { name: 'country' }).selectOption('Japan');
    await stepDone(page, 'Fill country');
    await h.getByRole('listbox', { name: 'interests' }).selectOption(['Music', 'Poetry']);
    await stepDone(page, 'Fill interests');

    // Undo restores the previous value in the control; redo brings it back.
    await page.locator('.viewer-host:not([hidden]) .viewer').focus();
    await page.keyboard.press('Control+z');
    await stepDone(page, 'Fill country');
    await expect(h.getByRole('listbox', { name: 'interests' })).toHaveValues(['Maths', 'Engines']);
    await page.keyboard.press('Control+Shift+Z');
    await stepDone(page, 'Fill interests');
    await expect(h.getByRole('listbox', { name: 'interests' })).toHaveValues(['Music', 'Poetry']);
    await shot(page, 'm9-fill-light');

    const path = await save(page, 'filled.pdf');
    // Appearances were regenerated, so other viewers show the new values.
    const doc = await PDFDocument.load(readFileSync(path));
    const ap = (name) => {
      const w = doc.getForm().getField(name).acroField.getWidgets()[0];
      return new TextDecoder('latin1').decode(decodePDFRawStream(doc.context.lookup(w.getNormalAppearance())).decode());
    };
    expect(ap('full_name')).toContain(`<${Buffer.from('Grace Hopper').toString('hex').toUpperCase()}>`);

    await reopen(page, path, 'filled\\.pdf');
    const read = await widgets(page);
    const value = (n) => read.find((w) => w.name === n).value;
    expect(value('full_name')).toBe('Grace Hopper');
    expect(value('notes')).toBe('Line A\nLine B');
    expect(value('subscribe')).toBe('Off');
    expect(value('plan')).toBe('team');
    expect(value('country')).toEqual(['Japan']);
    expect(value('interests')).toEqual(['Music', 'Poetry']);
    await expect(host(page).getByRole('textbox', { name: 'full_name' })).toHaveValue('Grace Hopper');
    await expect(host(page).getByRole('radio', { name: 'plan: team' })).toBeChecked();
    await expect(host(page).getByRole('checkbox', { name: 'subscribe' })).not.toBeChecked();
  });

  test('Fields panel lists fields, jumps to them, highlights; Tab continues on the next page', async ({ page }) => {
    await openFixture(page, 'forms.pdf');
    await run(page, 'fill-form');
    await expect(panel(page).locator('.side-panel-title')).toHaveText('Fields');
    const rows = panel(page).locator('.field-row');
    await expect(rows).toHaveCount(8);
    await expect(rows.first()).toContainText('full_name');
    await expect(rows.first()).toContainText('Ada Lovelace');
    await expect(host(page).getByRole('textbox', { name: 'full_name' })).toBeFocused();
    await rows.filter({ hasText: 'country' }).click();
    await expect(host(page).getByRole('combobox', { name: 'country' })).toBeFocused();
    // Values in the panel follow edits.
    await host(page).getByRole('combobox', { name: 'country' }).selectOption('Canada');
    await stepDone(page, 'Fill country');
    await expect(rows.filter({ hasText: 'country' })).toContainText('Canada');

    // Highlight fields toggle (remembered).
    await expect(host(page)).toHaveClass(/highlight-fields/);
    await panel(page).getByLabel('Highlight fields').uncheck();
    await expect(host(page)).not.toHaveClass(/highlight-fields/);
    expect(await page.evaluate(() => window.pdfEditor.app.forms.highlight)).toBe(false);
    await panel(page).getByLabel('Highlight fields').check();

    // Tab order across pages: fields on pages 1 and 3 of another document.
    await openFixture(page, 'multipage.pdf');
    await page.evaluate(async () => {
      const app = window.pdfEditor.app;
      const tab = app.activeTab;
      await app.edit(tab, 'addField', { page: 0, kind: 'text', rect: [100, 600, 300, 624], name: 'first' }, 'Add Text field');
      await app.edit(tab, 'addField', { page: 2, kind: 'text', rect: [100, 600, 300, 624], name: 'third' }, 'Add Text field');
    });
    await stepDone(page, 'Add Text field');
    await expect(host(page).getByRole('textbox', { name: 'first' })).toBeVisible();
    await host(page).getByRole('textbox', { name: 'first' }).focus();
    await page.keyboard.press('Tab');
    await expect(host(page).getByRole('textbox', { name: 'third' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(host(page).getByRole('textbox', { name: 'first' })).toBeFocused();
  });

  test('prepare a form: add, edit, move and delete fields; the saved form is fillable', async ({ page }) => {
    await openFixture(page, 'multipage.pdf');
    await run(page, 'prepare-form');
    const bar = page.locator('.form-toolbar');
    await expect(bar).toBeVisible();

    await bar.getByRole('button', { name: 'Add text field' }).click();
    await drag(page, 1, [100, 380], [320, 404]);
    await stepDone(page, 'Add Text field');
    await expect(page.locator('.field-selection')).toBeVisible();
    await bar.getByRole('button', { name: 'Properties…' }).click();
    let dialog = page.getByRole('dialog', { name: 'Text field properties' });
    await dialog.getByLabel('Name', { exact: true }).fill('bad.name');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('alert')).toContainText('can’t contain');
    await dialog.getByLabel('Name', { exact: true }).fill('email');
    await dialog.getByLabel('Required').check();
    await dialog.getByLabel('Default value').fill('me@example.com');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await stepDone(page, 'Edit field Text 1');

    // Dropdown: its properties open right away for the options.
    await bar.getByRole('button', { name: 'Add dropdown' }).click();
    await drag(page, 1, [100, 440], [260, 464]);
    dialog = page.getByRole('dialog', { name: 'Dropdown properties' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Options').fill('Red\nGreen\nBlue');
    await dialog.getByLabel('Default value').selectOption('Green');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await stepDone(page, 'Edit field Dropdown 1');

    await bar.getByRole('button', { name: 'Add checkbox' }).click();
    await drag(page, 1, [100, 500], [100, 500]);
    await stepDone(page, 'Add Checkbox');
    await bar.getByRole('button', { name: 'Add signature field' }).click();
    await drag(page, 1, [100, 540], [300, 590]);
    await stepDone(page, 'Add Signature field');
    await shot(page, 'm9-prepare-light');

    // Move the email field.
    const before = (await widgets(page)).find((w) => w.name === 'email').rect;
    await bar.getByRole('button', { name: 'Select fields' }).click();
    const email = host(page).locator('.form-field[data-field-name="email"]');
    const eb = await email.boundingBox();
    await page.mouse.move(eb.x + 20, eb.y + 8);
    await page.mouse.down();
    await page.mouse.move(eb.x + 60, eb.y + 8, { steps: 5 });
    await page.mouse.up();
    await stepDone(page, 'Move field email');
    const after = (await widgets(page)).find((w) => w.name === 'email').rect;
    expect(after[0]).toBeGreaterThan(before[0] + 20);

    // Delete the checkbox with the keyboard; undo/redo.
    const cb = host(page).locator('.form-field[data-field-name="Checkbox 1"]');
    await cb.click();
    await expect(bar.locator('.form-selected-name')).toHaveText('Checkbox 1');
    await page.keyboard.press('Delete');
    await stepDone(page, 'Delete field Checkbox 1');
    await expect(cb).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(cb).toHaveCount(1);
    await page.keyboard.press('Control+Shift+Z');
    await expect(cb).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden();

    // Saved and reopened: the new fields work.
    const path = await save(page, 'prepared.pdf');
    await reopen(page, path, 'prepared\\.pdf');
    const read = await widgets(page);
    expect(read.map((w) => w.name).sort()).toEqual(['Dropdown 1', 'Signature 1', 'email']);
    expect(read.find((w) => w.name === 'email')).toMatchObject({ value: 'me@example.com', required: true });
    expect(read.find((w) => w.name === 'Dropdown 1')).toMatchObject({ value: ['Green'], options: ['Red', 'Green', 'Blue'] });
    await host(page).getByRole('textbox', { name: 'email' }).fill('grace@example.com');
    await page.keyboard.press('Enter');
    await stepDone(page, 'Fill email');
    await host(page).getByRole('combobox', { name: 'Dropdown 1' }).selectOption('Blue');
    await stepDone(page, 'Fill Dropdown 1');
    expect((await widgets(page)).find((w) => w.name === 'email').value).toBe('grace@example.com');
  });

  test('signatures: draw, place, move; sign a field with a saved signature; it saves', async ({ page }) => {
    await page.evaluate(() => window.pdfEditor.storage.clearAll());
    await openFixture(page, 'forms.pdf');
    await run(page, 'add-signature');
    const dialog = page.getByRole('dialog', { name: 'Add signature' });
    await expect(dialog).toContainText('not a digital (cryptographic) signature');
    const place = dialog.getByRole('button', { name: 'Place signature' });
    await expect(place).toBeDisabled();
    const pad = dialog.locator('.sig-pad');
    const b = await pad.boundingBox();
    await page.mouse.move(b.x + 40, b.y + 100);
    await page.mouse.down();
    for (const [x, y] of [[80, 50], [120, 120], [160, 60], [220, 110], [300, 70]]) await page.mouse.move(b.x + x, b.y + y, { steps: 4 });
    await page.mouse.up();
    await expect(place).toBeEnabled();
    await shot(page, 'm9-signature-dialog-light');
    await place.click();
    await expect(page.locator('.sig-place-hint')).toBeVisible();
    const pb = await pageIn(page, 1).boundingBox();
    await page.mouse.move(pb.x + 500, pb.y + 300);
    await expect(page.locator('.sig-ghost')).toBeVisible();
    await page.mouse.click(pb.x + 500, pb.y + 300);
    await stepDone(page, 'Add signature');
    let list = await stamps(page);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ hasAppearance: true, contents: 'Visual signature' });
    // Placed signatures are selected, and can be moved like any annotation.
    await expect(page.locator('.annot-selection')).toBeVisible();
    const fb = await page.locator('.annot-selection').boundingBox();
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    await page.mouse.move(fb.x + fb.width / 2 - 60, fb.y + fb.height / 2, { steps: 5 });
    await page.mouse.up();
    await stepDone(page, 'Move Signature');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Signature field: the saved signature is offered; it lands inside the field.
    await host(page).getByRole('button', { name: 'Sign signature' }).click();
    const saved = dialog.getByRole('button', { name: 'Use this signature' });
    await expect(saved).toHaveCount(1);
    await saved.click();
    await stepDone(page, 'Sign signature');
    list = await stamps(page);
    expect(list).toHaveLength(2);
    const field = (await widgets(page)).find((w) => w.name === 'signature').rect;
    const inField = list.find((s) => s.rect[0] >= field[0] - 0.5 && s.rect[2] <= field[2] + 0.5 && s.rect[1] >= field[1] - 0.5 && s.rect[3] <= field[3] + 0.5);
    expect(inField).toBeTruthy();

    // Typed signature.
    await run(page, 'add-signature');
    await dialog.getByRole('tab', { name: 'Type' }).click();
    await dialog.getByLabel('Your name').fill('Ada Lovelace');
    await dialog.getByRole('radio').nth(1).click();
    await expect(dialog.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('button', { name: 'Place signature' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sig-place-hint')).toHaveCount(0);

    const path = await save(page, 'signed.pdf');
    await reopen(page, path, 'signed\\.pdf');
    expect((await stamps(page)).filter((s) => s.hasAppearance)).toHaveLength(2);
    await page.evaluate(() => window.pdfEditor.app.showPanel('comments'));
    await expect(panel(page).locator('.comment-thread').first()).toHaveAttribute('aria-label', /^Signature by/);
  });

  test('flatten form is one undoable step', async ({ page }) => {
    await openFixture(page, 'forms.pdf');
    await run(page, 'flatten-form');
    const dialog = page.getByRole('dialog', { name: 'Flatten form?' });
    await expect(dialog).toContainText('8 fields');
    await dialog.getByRole('button', { name: 'Flatten' }).click();
    await stepDone(page, 'Flatten form');
    await expect(host(page).locator('.form-field')).toHaveCount(0);
    expect(await widgets(page)).toHaveLength(0);
    const text = await page.evaluate(async () => {
      const proxy = await window.pdfEditor.app.activeTab.pdf.getPage(1);
      return (await proxy.getTextContent()).items.map((i) => i.str).join(' ');
    });
    expect(text).toContain('Ada Lovelace');
    await page.keyboard.press('Control+z');
    await expect(host(page).locator('.form-field')).toHaveCount(10); // 8 fields, the radio group has 3 widgets
  });

  test('screenshots: dark theme', async ({ page }) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await openFixture(page, 'forms.pdf');
    await run(page, 'fill-form');
    await expect(host(page).getByRole('textbox', { name: 'full_name' })).toBeFocused();
    await shot(page, 'm9-fill-dark');
    await run(page, 'prepare-form');
    await host(page).locator('.form-field[data-field-name="country"]').click();
    await shot(page, 'm9-prepare-dark');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await run(page, 'add-signature');
    await page.getByRole('dialog', { name: 'Add signature' }).getByRole('tab', { name: 'Type' }).click();
    await shot(page, 'm9-signature-dialog-dark');
    await page.keyboard.press('Escape');
  });
});
