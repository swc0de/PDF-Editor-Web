// Password protection with qpdf (WebAssembly, AES-256).
// - An unprotected document: save a protected *copy* (open password and/or
//   an owner password with permissions). The open document stays editable.
// - A protected document: remove the protection (needs the owner password),
//   as an undo step; the document then becomes editable.
import { h } from '../dom.js';
import { t } from '../../i18n/index.js';
import { openDialog, createModal } from '../dialog.js';
import { toast } from '../toast.js';
import { downloadBytes } from '../save.js';
import { encryptPdf, decryptPdf, checkPassword, PERMISSION_KEYS } from '../../core/qpdf.js';

const busy = (title) => createModal({ title, body: [h('p.muted', { role: 'status' }, t('protect.working'))], footer: [] });

export function protectedName(name) {
  const base = name.replace(/\.pdf$/i, '');
  return `${base.endsWith('-protected') ? base : `${base}-protected`}.pdf`;
}

export async function openPasswordDialog(app) {
  const tab = app.activeTab;
  if (!tab) return toast(t('protect.needsDocument'));
  if (tab.model.readOnly === 'encrypted') return removeProtection(app, tab);
  return addProtection(app, tab);
}

async function addProtection(app, tab) {
  const pw = (name, label) => h('label.field', h('span.field-label', label), h('input.input', { type: 'password', name, autocomplete: 'new-password' }));
  const useOpen = h('input', { type: 'checkbox', name: 'useOpen', checked: true });
  const useOwner = h('input', { type: 'checkbox', name: 'useOwner' });
  const openFields = h('div.protect-group', pw('user', t('protect.openPassword')), pw('user2', t('protect.confirm')));
  const perms = PERMISSION_KEYS.map((k) => h('label.check', h('input', { type: 'checkbox', name: `perm-${k}`, checked: k !== 'edit' }), t(`protect.perm.${k}`)));
  const ownerFields = h('div.protect-group', pw('owner', t('protect.ownerPassword')), pw('owner2', t('protect.confirm')),
    h('fieldset.protect-perms', h('legend', t('protect.permissions')), perms));
  const error = h('p.field-error', { role: 'alert' });
  const sync = () => {
    openFields.hidden = !useOpen.checked;
    ownerFields.hidden = !useOwner.checked;
  };
  useOpen.addEventListener('change', sync);
  useOwner.addEventListener('change', sync);
  sync();
  const values = await openDialog({
    title: t('protect.title'),
    className: 'protect-dialog',
    body: [
      h('p.muted', t('protect.intro')),
      h('label.check', useOpen, t('protect.requireOpen')), openFields,
      h('label.check', useOwner, t('protect.restrict')), ownerFields,
      error,
    ],
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('protect.save'), primary: true },
    ],
    onSubmit: (form) => {
      const f = new FormData(form);
      const user = useOpen.checked ? String(f.get('user') ?? '') : '';
      const owner = useOwner.checked ? String(f.get('owner') ?? '') : '';
      let msg = '';
      if (!useOpen.checked && !useOwner.checked) msg = t('protect.errorNothing');
      else if (useOpen.checked && !user) msg = t('protect.errorOpenEmpty');
      else if (useOpen.checked && user !== f.get('user2')) msg = t('protect.errorMismatch');
      else if (useOwner.checked && !owner) msg = t('protect.errorOwnerEmpty');
      else if (useOwner.checked && owner !== f.get('owner2')) msg = t('protect.errorMismatch');
      else if (useOwner.checked && owner === user) msg = t('protect.errorSame');
      error.textContent = msg;
      if (msg) return undefined;
      const permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, useOwner.checked ? !!f.get(`perm-${k}`) : true]));
      // Without restrictions the open password is also the owner password, so
      // whoever knows it keeps full rights (and can remove the protection).
      return { userPassword: user, ownerPassword: owner || user, permissions };
    },
  });
  if (!values) return;
  const modal = busy(t('protect.title'));
  try {
    const bytes = await encryptPdf(tab.bytes, values);
    downloadBytes(bytes, protectedName(tab.name));
    toast(t('protect.saved', { name: protectedName(tab.name) }));
  } catch (err) {
    toast(t('protect.failed', { message: err.message }), { kind: 'error' });
  } finally {
    modal.close();
  }
}

async function removeProtection(app, tab) {
  // The opened file's bytes (still encrypted) are the first history entry.
  const original = tab.model.bytes;
  let known = tab.password ?? '';
  const check = await checkPassword(original, known).catch(() => ({ kind: null, info: '' }));
  const method = /AESv3|256/i.test(check.info) ? 'AES-256' : /AESv2|AES/i.test(check.info) ? 'AES-128' : /RC4/i.test(check.info) ? 'RC4' : '';
  const needOwner = check.kind !== 'owner';
  const ownerInput = h('input.input', { type: 'password', name: 'owner', autocomplete: 'current-password' });
  const error = h('p.field-error', { role: 'alert' });
  const ok = await openDialog({
    title: t('protect.removeTitle'),
    className: 'protect-dialog',
    body: [
      h('p', method ? t('protect.isProtectedWith', { method }) : t('protect.isProtected')),
      h('p.muted', t('protect.removeIntro')),
      needOwner ? h('label.field', h('span.field-label', t('protect.ownerPassword')), ownerInput, h('span.field-help', t('protect.ownerNeeded'))) : null,
      error,
    ],
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('protect.remove'), primary: true },
    ],
    onSubmit: () => {
      if (needOwner) {
        if (!ownerInput.value) {
          error.textContent = t('protect.errorOwnerEmpty');
          return undefined;
        }
        known = ownerInput.value;
      }
      return true;
    },
  });
  if (!ok) return;
  const modal = busy(t('protect.removeTitle'));
  try {
    if (needOwner) {
      const again = await checkPassword(original, known);
      if (again.kind !== 'owner') {
        toast(t('protect.wrongOwner'), { kind: 'error' });
        return;
      }
    }
    const bytes = await decryptPdf(original, known);
    await tab.model.commitBytes(bytes, { label: t('step.removeProtection'), readOnly: null });
    toast(t('protect.removed'));
  } catch (err) {
    toast(t('protect.failed', { message: err.message }), { kind: 'error' });
  } finally {
    modal.close();
  }
}
