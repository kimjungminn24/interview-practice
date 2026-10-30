// 인라인 SVG 아이콘 (24×24, 1.5px 선)
const P = (d) => `<path d="${d}"/>`;

const ICONS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/>' + P('M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6'),
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
  play: P('M8 5v14l11-7z'),
  pause: P('M8 5v14M16 5v14'),
  listen: P('M4 9.5v5h3.5L12 18V6L7.5 9.5H4z') + P('M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11'),
  close: P('M6 6l12 12M18 6L6 18'),
  plus: P('M12 5v14M5 12h14'),
  link: P('M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1') + P('M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1'),
  follow: P('M6 4v8a3 3 0 0 0 3 3h9') + P('M14 11l4 4-4 4'),
  check: P('M5 12.5l4.5 4.5L19 7'),
  dash: P('M6 12h12'),
  chevron: P('M6 9l6 6 6-6'),
  back: P('M15 6l-6 6 6 6'),
  more: '<circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="6"/>' + P('M20 20l-4.5-4.5'),
  retry: P('M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4'),
};

export const ICON_NAMES = Object.keys(ICONS);

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** icon('mic') → '<svg class="i" …>…</svg>' */
export function icon(name, { size = 18, label } = {}) {
  const body = ICONS[name] || '';
  const a11y = label ? `role="img" aria-label="${escAttr(label)}"` : 'aria-hidden="true" focusable="false"';
  return `<svg class="i i-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`;
}
