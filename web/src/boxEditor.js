// A rectangle on a Leaflet map that the user can resize (corner handles) and move (middle handle).
import L from 'leaflet';
import { MAX_BOX, boxSizeKm } from '../../shared/geo.js';

export const toBounds = (b) => L.latLngBounds([b.s, b.w], [b.n, b.e]);

const KM_PER_MI = 1.609344;
export const sizeText = (b) => {
  const { tall, wide } = boxSizeKm(b);
  return `About ${Math.round(wide / KM_PER_MI)} × ${Math.round(tall / KM_PER_MI)} miles`;
};

/**
 * createBoxEditor(map, { color, onChange }) -> { box, set(box), edit(on), remove() }
 * onChange(box) fires while dragging and after each drag ends.
 */
export function createBoxEditor(map, { color = '#2f6b4f', onChange = () => {} } = {}) {
  let box = null;
  let editing = false;
  let rect = null;
  let handles = null;

  const style = () =>
    editing
      ? { color, weight: 3, dashArray: '6 6', fillOpacity: 0.08, interactive: false }
      : { color, weight: 2, fillOpacity: 0.03, interactive: false };

  function place(skip) {
    if (!box) return;
    rect?.setBounds(toBounds(box));
    if (!handles) return;
    const pos = { sw: [box.s, box.w], nw: [box.n, box.w], ne: [box.n, box.e], se: [box.s, box.e], move: [(box.s + box.n) / 2, (box.w + box.e) / 2] };
    for (const [name, m] of Object.entries(handles)) if (m !== skip) m.setLatLng(pos[name]);
  }

  function addHandles() {
    const corner = (name) =>
      L.marker([0, 0], {
        draggable: true,
        keyboard: false,
        icon: L.divIcon({ className: `nb-handle nb-${name}`, iconSize: [18, 18], html: '' }),
        title: 'Drag to resize this area',
      });
    handles = {
      sw: corner('sw'),
      nw: corner('nw'),
      ne: corner('ne'),
      se: corner('se'),
      move: L.marker([0, 0], {
        draggable: true,
        keyboard: false,
        icon: L.divIcon({ className: 'nb-handle nb-move', html: '✥', iconSize: [26, 26] }),
        title: 'Drag to move this area',
      }),
    };
    for (const [name, m] of Object.entries(handles)) {
      let start = null;
      m.on('dragstart', () => {
        start = { ...box, at: m.getLatLng() };
      });
      m.on('drag', () => {
        const ll = m.getLatLng();
        const next = { ...box };
        if (name === 'move') {
          const dLat = ll.lat - start.at.lat;
          const dLon = ll.lng - start.at.lng;
          Object.assign(next, { s: start.s + dLat, n: start.n + dLat, w: start.w + dLon, e: start.e + dLon });
        } else {
          if (name[0] === 's') next.s = Math.max(ll.lat, start.n - MAX_BOX.lat);
          else next.n = Math.min(ll.lat, start.s + MAX_BOX.lat);
          if (name[1] === 'w') next.w = Math.max(ll.lng, start.e - MAX_BOX.lon);
          else next.e = Math.min(ll.lng, start.w + MAX_BOX.lon);
        }
        box = next;
        place(m);
        onChange(box);
      });
      m.on('dragend', () => {
        // Corners may have been dragged past each other; put the edges back in order.
        box = { s: Math.min(box.s, box.n), n: Math.max(box.s, box.n), w: Math.min(box.w, box.e), e: Math.max(box.w, box.e) };
        place();
        onChange(box);
      });
      m.addTo(map);
      m.getElement()?.style.setProperty('--box-color', color);
    }
  }

  function removeHandles() {
    if (handles) for (const h of Object.values(handles)) h.remove();
    handles = null;
  }

  const api = {
    get box() {
      return box;
    },
    set(b) {
      box = b ? { s: b.s, w: b.w, n: b.n, e: b.e } : null;
      if (!box) {
        api.remove();
        return api;
      }
      if (!rect) {
        rect = L.rectangle(toBounds(box), style()).addTo(map);
      }
      place();
      return api;
    },
    edit(on) {
      editing = !!on;
      rect?.setStyle(style());
      if (editing && box && !handles) addHandles();
      if (!editing) removeHandles();
      place();
      return api;
    },
    remove() {
      removeHandles();
      rect?.remove();
      rect = null;
    },
  };
  return api;
}
