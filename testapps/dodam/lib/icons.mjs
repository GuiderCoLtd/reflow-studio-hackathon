// Simple line icons (24x24 grid, stroked with currentColor). Decorative only:
// every icon is aria-hidden, so controls always carry visible text or a label.
import { raw } from './html.mjs';

function gear() {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const c = (i * 45 * Math.PI) / 180;
    for (const [r, off] of [[7.1, -18], [9.4, -10], [9.4, 10], [7.1, 18]]) {
      const a = c + (off * Math.PI) / 180;
      pts.push(`${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`);
    }
  }
  return `<path d="M${pts.join('L')}Z"/><circle cx="12" cy="12" r="2.9"/>`;
}

const PATHS = {
  home: '<path d="M4 10.4 12 4l8 6.4V19a1 1 0 0 1-1 1h-4.6v-5.6H9.6V20H5a1 1 0 0 1-1-1z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6V12l3 1.9"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 9.6h17M8 3v4M16 3v4"/>',
  calendarPlus: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 9.6h17M8 3v4M16 3v4M12 12.6v5M9.5 15.1h5"/>',
  docCheck: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="m9.2 14.2 2 2 3.8-4"/>',
  receipt: '<path d="M6 3.5h12v17l-2.4-1.5-1.9 1.5-1.8-1.5-1.8 1.5-1.8-1.5L6 20.5z"/><path d="M9 8.2h6M9 11.6h6M9 15h3.6"/>',
  users: '<circle cx="9" cy="8.4" r="3.3"/><path d="M3.4 19.6c.6-3.1 2.8-5 5.6-5s5 1.9 5.6 5"/><path d="M15.4 5.4a3.3 3.3 0 0 1 0 6.1"/><path d="M17.3 14.9c1.6.7 2.8 2.3 3.3 4.7"/>',
  userPlus: '<circle cx="9.5" cy="8.4" r="3.4"/><path d="M3.4 19.6c.7-3.1 3-5 6.1-5 1.3 0 2.5.3 3.5.9"/><path d="M18 13.2v6M15 16.2h6"/>',
  megaphone: '<path d="M4 9.6h3.8L17 4.8v14.4l-9.2-4.8H4z"/><path d="m8 14.6 1.3 4.9h2.6l-1.2-4.4"/><path d="M20 10.2v3.6"/>',
  gear: gear(),
  search: '<circle cx="11" cy="11" r="6.6"/><path d="m20 20-4.3-4.3"/>',
  bell: '<path d="M6.2 9.5a5.8 5.8 0 0 1 11.6 0c0 5.6 2.2 7.4 2.2 7.4H4s2.2-1.8 2.2-7.4"/><path d="M10.2 20.2a2 2 0 0 0 3.6 0"/>',
  chevronDown: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  chevronRight: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  chevronLeft: '<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>',
  x: '<path d="M17.5 6.5l-11 11M6.5 6.5l11 11"/>',
  arrowLeft: '<path d="M19 12H5.5M11 18.5 4.5 12 11 5.5"/>',
  logout: '<path d="M10 4H6.5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2H10"/><path d="m15 8 4 4-4 4M19 12H9.5"/>',
  user: '<circle cx="12" cy="8.4" r="3.8"/><path d="M4.6 20c.9-3.6 3.8-5.8 7.4-5.8s6.5 2.2 7.4 5.8"/>',
  building: '<rect x="4.5" y="3.5" width="15" height="17" rx="1.8"/><path d="M8.6 7.6h1.4M14 7.6h1.4M8.6 11.2h1.4M14 11.2h1.4M8.6 14.8h1.4M14 14.8h1.4M10.4 20.5V18h3.2v2.5"/>',
  paperclip: '<path d="m19.6 11.4-7.5 7.5a4.6 4.6 0 0 1-6.5-6.5l7.7-7.7a3 3 0 0 1 4.3 4.3l-7.6 7.6a1.5 1.5 0 0 1-2.1-2.1l7-7"/>',
  pin: '<path d="M9.2 3.8h5.6l-.9 5.2 3 3v2.2H7.1V12l3-3z"/><path d="M12 14.2v6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.9v.1"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.3 2.6 2.6 4.9-5.4"/>',
  alertCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.1v.1"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  briefcase: '<rect x="3.5" y="7.4" width="17" height="12.1" rx="2.2"/><path d="M9 7.4V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.4M3.5 12.6h17"/>',
  cart: '<path d="M3.5 4.6h2.1l2.1 10a1.6 1.6 0 0 0 1.6 1.3h7.5a1.6 1.6 0 0 0 1.5-1.1L20 8.2H6.4"/><circle cx="9.6" cy="19.4" r="1.2"/><circle cx="17" cy="19.4" r="1.2"/>',
  upload: '<path d="M12 15.4V4.6M7.6 9 12 4.6 16.4 9"/><path d="M4.6 15v3a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-3"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.2"/><path d="m4.2 7.2 7.8 5.9 7.8-5.9"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.6"/><path d="M11 17.4h2"/>',
  shield: '<path d="M12 3.6 5.2 6v5.6c0 4.2 2.9 7.5 6.8 8.8 3.9-1.3 6.8-4.6 6.8-8.8V6z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
  edit: '<path d="M4.5 19.5h3.8L18.6 9.2a2.7 2.7 0 0 0-3.8-3.8L4.5 15.7z"/><path d="m13.4 6.8 3.8 3.8"/>',
  wallet: '<path d="M4.5 7.2A2.2 2.2 0 0 1 6.7 5h10.8v3"/><rect x="4.5" y="8" width="15" height="11" rx="2.2"/><path d="M15.6 13.5h.1"/>',
  coffee: '<path d="M5 9h11v5.5A4.5 4.5 0 0 1 11.5 19h-2A4.5 4.5 0 0 1 5 14.5z"/><path d="M16 10.2h1.4a2.4 2.4 0 0 1 0 4.8H16"/><path d="M8.5 3.8v2.4M12 3.8v2.4"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.6v1.8M12 18.6v1.8M3.6 12h1.8M18.6 12h1.8M6 6l1.3 1.3M16.7 16.7 18 18M6 18l1.3-1.3M16.7 7.3 18 6"/>',
  mapPin: '<path d="M12 20.5s6.5-5.6 6.5-10.7a6.5 6.5 0 0 0-13 0c0 5.1 6.5 10.7 6.5 10.7z"/><circle cx="12" cy="9.8" r="2.3"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  list: '<path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5"/><path d="M4.6 6.5h.1M4.6 12h.1M4.6 17.5h.1"/>',
  hourglass: '<path d="M7 3.8h10M7 20.2h10"/><path d="M8 3.8c0 4.2 4 5.5 4 8.2s-4 4-4 8.2M16 3.8c0 4.2-4 5.5-4 8.2s4 4 4 8.2"/>',
};

export function icon(name, { size = 20, cls = 'ico', stroke = 1.6 } = {}) {
  const body = PATHS[name] || PATHS.info;
  return raw(
    `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`,
  );
}

// Brand mark: two overlapping rounded squares, ink over a light gray.
export function logoMark(size = 28) {
  return raw(
    `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">` +
      '<rect x="11" y="3" width="18" height="18" rx="6" fill="#C7CCD3"/>' +
      '<rect x="3" y="11" width="18" height="18" rx="6" fill="#1B1F24"/>' +
      '</svg>',
  );
}
