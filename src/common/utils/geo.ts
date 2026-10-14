// Geospatial helpers (WGS-84, kilometres).

export type LatLng = [number, number];

const R = 6371; // km
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const isValidCoordinate = (lat: unknown, lng: unknown): boolean =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);

/** Ray-casting point-in-polygon (polygon as ring of [lat, lng]). */
export function pointInPolygon(p: LatLng, polygon: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersect = yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Shortest distance (km) from a point to a segment, using a local equirectangular projection (fine for corridors). */
function pointToSegmentKm(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = 111.32 * Math.cos(rad(p[0]));
  const ky = 110.574;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

/** Distance (km) from a point to a polyline. */
export function distanceToPolylineKm(p: LatLng, line: LatLng[]): number {
  if (!line.length) return Infinity;
  if (line.length === 1) return haversineKm(p, line[0]);
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i++) min = Math.min(min, pointToSegmentKm(p, line[i], line[i + 1]));
  return min;
}

/** Length of a polyline in km. */
export function polylineLengthKm(line: LatLng[]): number {
  let d = 0;
  for (let i = 0; i < line.length - 1; i++) d += haversineKm(line[i], line[i + 1]);
  return d;
}

/**
 * Remaining distance along a polyline from the vertex closest to `p` to the end (km) — used for route-based ETA when
 * no routing provider is configured.
 */
export function remainingAlongPolylineKm(p: LatLng, line: LatLng[]): number {
  if (line.length < 2) return line.length ? haversineKm(p, line[0]) : 0;
  let best = 0, bestD = Infinity;
  line.forEach((v, i) => { const d = haversineKm(p, v); if (d < bestD) { bestD = d; best = i; } });
  return bestD + polylineLengthKm(line.slice(best));
}
