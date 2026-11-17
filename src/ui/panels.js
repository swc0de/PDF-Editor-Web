// Side-panel registry. Every panel exists from M2 with an honest empty state;
// the milestone that builds a panel calls implementPanel(id, { render }).

export const PANELS = [
  { id: 'pages', icon: 'grid', milestone: 'M3' },
  { id: 'bookmarks', icon: 'bookmark', milestone: 'M3' },
  { id: 'layers', icon: 'layers', milestone: 'M7' },
  { id: 'fields', icon: 'textInput', milestone: 'M9' },
  { id: 'comments', icon: 'messageSquare', milestone: 'M8' },
  { id: 'attachments', icon: 'paperclip', milestone: 'M7' },
  { id: 'properties', icon: 'info', milestone: 'M7' },
  { id: 'history', icon: 'history', milestone: 'M4' },
].map((p) => ({ ...p, label: `panel.${p.id}.label`, render: null }));

export function getPanel(id) {
  return PANELS.find((p) => p.id === id) ?? null;
}

/**
 * @param {string} id
 * @param {{ render: (container: HTMLElement, tab: object) => (void | (() => void)) }} impl
 *   render() fills the container for a document tab and may return a cleanup.
 */
export function implementPanel(id, impl) {
  const panel = getPanel(id);
  if (!panel) throw new Error(`Unknown panel: ${id}`);
  Object.assign(panel, impl);
}
