// Layers panel: the document's optional content groups, in the document's
// own order/nesting, with visibility toggles that re-render at once.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { t, tn } from '../../i18n/index.js';
import { implementPanel } from '../panels.js';

export function registerLayersPanel() {
  implementPanel('layers', {
    render(container, tab) {
      const viewer = tab.viewer;
      let disposed = false;
      const showAll = h('button.btn.btn-sm', { type: 'button' }, icon('eye', { size: 14 }), t('layers.showAll'));
      const hideAll = h('button.btn.btn-sm', { type: 'button' }, icon('eyeOff', { size: 14 }), t('layers.hideAll'));
      const reset = h('button.btn.btn-sm.ghost', { type: 'button', title: t('layers.resetHelp') }, t('layers.reset'));
      const toolbar = h('div.panel-toolbar.layers-toolbar', showAll, hideAll, reset);
      const body = h('div.layers-body');
      container.append(toolbar, body);

      async function render() {
        const config = await viewer.ocConfigPromise;
        if (disposed) return;
        const groups = config ? [...config] : [];
        toolbar.hidden = !groups.length;
        if (!groups.length) {
          body.replaceChildren(h('div.empty-state',
            h('div.empty-icon', icon('layers', { size: 22 })),
            h('p.empty-title', t('layers.none')),
            h('p.empty-text', t('layers.noneText'))));
          return;
        }
        const item = (id) => {
          const group = config.getGroup(id);
          if (!group) return null;
          const box = h('input', {
            type: 'checkbox',
            checked: group.visible,
            dataset: { layer: id },
            onchange: (e) => viewer.setLayerVisibility(id, e.target.checked),
          });
          return h('li.layer-item', h('label.layer-label', box, h('span.layer-name', group.name || t('layers.untitled'))));
        };
        const build = (order) => h('ul.layer-list', order.map((entry) => {
          if (typeof entry === 'string') return item(entry);
          if (entry && Array.isArray(entry.order)) {
            return h('li.layer-group', entry.name ? h('span.layer-group-name', entry.name) : null, build(entry.order));
          }
          return null;
        }));
        const order = config.getOrder?.();
        const tree = order?.length ? build(order) : build(groups.map(([id]) => id));
        body.replaceChildren(h('p.muted.layers-count', tn('layers.count', groups.length)), tree);
      }

      showAll.addEventListener('click', async () => setAll(true));
      hideAll.addEventListener('click', async () => setAll(false));
      reset.addEventListener('click', () => viewer.resetLayers());
      async function setAll(visible) {
        const config = await viewer.ocConfigPromise;
        for (const [id] of config ?? []) {
          config.setVisibility(id, visible);
          viewer.layerOverrides.set(id, visible);
        }
        viewer.redrawAll();
      }

      const onChange = () => render();
      viewer.addEventListener('layerschange', onChange);
      tab.addEventListener('docchange', onChange);
      render();
      return () => {
        disposed = true;
        viewer.removeEventListener('layerschange', onChange);
        tab.removeEventListener('docchange', onChange);
      };
    },
  });
}
