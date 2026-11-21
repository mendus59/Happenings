// An area on a Leaflet map that the user can reshape: drag a corner to move it, drag the
// small dot on an edge to add a corner there, double-click (or long-press) a corner to
// remove it, and drag the ✥ to move the whole area.
import L from 'leaflet';
import { MAX_BOX, MAX_POINTS, boxPoints, boxSizeKm } from '../../shared/geo.js';

export const toBounds = (b) => L.latLngBounds([b.s, b.w], [b.n, b.e]);

const KM_PER_MI = 1.609344;
export const sizeText = (b) => {
  const { tall, wide } = boxSizeKm(b);
  return `About ${Math.round(wide / KM_PER_MI)} × ${Math.round(tall / KM_PER_MI)} miles`;
};

const bboxOf = (pts) => ({
  s: Math.min(...pts.map((p) => p[0])),
  n: Math.max(...pts.map((p) => p[0])),
  w: Math.min(...pts.map((p) => p[1])),
  e: Math.max(...pts.map((p) => p[1])),
});
const boxFrom = (pts) => ({ ...bboxOf(pts), pts: pts.map((p) => [...p]) });

/**
 * createBoxEditor(map, { color, onChange }) -> { box, set(box), edit(on), remove() }
 * box is { s, w, n, e, pts }. onChange(box) fires while dragging and after each change.
 */
export function createBoxEditor(map, { color = '#2f6b4f', onChange = () => {} } = {}) {
  let pts = null;
  let editing = false;
  let shape = null;
  let handles = [];

  const style = () =>
    editing
      ? { color, weight: 3, dashArray: '6 6', fillOpacity: 0.08, interactive: false }
      : { color, weight: 2, fillOpacity: 0.03, interactive: false };

  const marker = (ll, cls, title, size, html = '') => {
    const m = L.marker(ll, {
      draggable: true,
      keyboard: false,
      icon: L.divIcon({ className: `nb-handle ${cls}`, iconSize: [size, size], html }),
      title,
    }).addTo(map);
    m.getElement()?.style.setProperty('--box-color', color);
    handles.push(m);
    return m;
  };

  /** Keep a dragged corner close enough to the others that the area stays within MAX_BOX. */
  function clampCorner(i, ll) {
    const others = pts.filter((_, j) => j !== i);
    const b = bboxOf(others);
    return [
      Math.min(Math.max(ll.lat, b.n - MAX_BOX.lat), b.s + MAX_BOX.lat),
      Math.min(Math.max(ll.lng, b.e - MAX_BOX.lon), b.w + MAX_BOX.lon),
    ];
  }

  function redraw() {
    if (!pts) return;
    shape?.setLatLngs(pts);
  }

  function changed() {
    redraw();
    onChange(boxFrom(pts));
  }

  function removeHandles() {
    for (const h of handles) h.remove();
    handles = [];
  }

  function addHandles() {
    removeHandles();
    if (!pts) return;
    pts.forEach((p, i) => {
      const m = marker(p, 'nb-vertex', pts.length > 3 ? 'Drag to reshape. Double-click to remove this corner.' : 'Drag to reshape', 18);
      m.on('drag', () => {
        pts[i] = clampCorner(i, m.getLatLng());
        redraw();
        onChange(boxFrom(pts));
      });
      m.on('dragend', () => {
        m.setLatLng(pts[i]);
        addHandles();
        changed();
      });
      const drop = (e) => {
        L.DomEvent.stop(e);
        if (pts.length <= 3) return;
        pts.splice(i, 1);
        addHandles();
        changed();
      };
      m.on('dblclick', drop);
      m.on('contextmenu', drop);
    });
    if (pts.length < MAX_POINTS) {
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        const m = marker([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], 'nb-mid', 'Drag to add a corner here', 12);
        let at = -1;
        m.on('dragstart', () => {
          at = i + 1;
          pts.splice(at, 0, [m.getLatLng().lat, m.getLatLng().lng]);
        });
        m.on('drag', () => {
          pts[at] = clampCorner(at, m.getLatLng());
          redraw();
          onChange(boxFrom(pts));
        });
        m.on('dragend', () => {
          addHandles();
          changed();
        });
      });
    }
    const b = bboxOf(pts);
    const mv = marker([(b.s + b.n) / 2, (b.w + b.e) / 2], 'nb-move', 'Drag to move this area', 26, '✥');
    let start = null;
    mv.on('dragstart', () => {
      start = { pts: pts.map((p) => [...p]), at: mv.getLatLng() };
    });
    mv.on('drag', () => {
      const ll = mv.getLatLng();
      const dLat = ll.lat - start.at.lat;
      const dLon = ll.lng - start.at.lng;
      pts = start.pts.map((p) => [p[0] + dLat, p[1] + dLon]);
      for (const h of handles) if (h !== mv) h.setOpacity(0);
      redraw();
      onChange(boxFrom(pts));
    });
    mv.on('dragend', () => {
      addHandles();
      changed();
    });
  }

  const api = {
    get box() {
      return pts ? boxFrom(pts) : null;
    },
    set(b) {
      pts = b ? boxPoints(b) : null;
      if (!pts) {
        api.remove();
        return api;
      }
      if (!shape) shape = L.polygon(pts, style()).addTo(map);
      redraw();
      if (editing) addHandles();
      return api;
    },
    edit(on) {
      editing = !!on;
      shape?.setStyle(style());
      if (editing && pts) addHandles();
      else removeHandles();
      return api;
    },
    remove() {
      removeHandles();
      shape?.remove();
      shape = null;
    },
  };
  return api;
}
