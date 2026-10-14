// GPS fleet emulator (development / demo only — stop it when real trackers are installed).
// Behaves like a Teltonika FMB tracker in every truck that has a GPS device: keeps a TCP link to the GPS Tracking
// Platform (Traccar, port 5027) and sends a real Codec 8 AVL record every --interval seconds. Positions therefore
// travel the production path: tracker → Traccar → EFMIS webhook → map, geofences, ETA, arrival.
//   - truck on a moving trip  → drives along its trip route from its last position at --speed km/h
//   - any other truck         → parked at its last known position (ignition on, speed 0), still reporting
//
//   node tools/gps-emulator.mjs [--api http://localhost:4000/api] [--host 127.0.0.1] [--port 5027] [--interval 10] [--speed 50]
import net from 'node:net';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const API = arg('api', 'http://localhost:4000/api');
const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', 5027));
const INTERVAL_S = Number(arg('interval', 10));
const SPEED_KMH = Number(arg('speed', 50));
const MOVING = ['DISPATCHED', 'IN_PROGRESS', 'RETURNING'];

// ------------------------------------------------------------------ Codec 8
function crc16ibm(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}
function avlPacket({ lat, lng, speed, angle, ts }) {
  const head = Buffer.alloc(9);
  head.writeBigUInt64BE(BigInt(ts), 0);
  const gps = Buffer.alloc(15);
  gps.writeInt32BE(Math.round(lng * 1e7), 0);
  gps.writeInt32BE(Math.round(lat * 1e7), 4);
  gps.writeInt16BE(1700, 8);
  gps.writeUInt16BE(Math.round(angle) % 360, 10);
  gps.writeUInt8(12, 12);
  gps.writeUInt16BE(Math.round(speed), 13);
  const io = Buffer.from([0, 2, 2, 239, 1, 240, speed > 0 ? 1 : 0, 0, 0, 0]); // ignition on, movement
  const data = Buffer.concat([Buffer.from([0x08, 1]), head, gps, io, Buffer.from([1])]);
  const pre = Buffer.alloc(8);
  pre.writeUInt32BE(data.length, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16ibm(data), 0);
  return Buffer.concat([pre, data, crc]);
}

// ------------------------------------------------------------------ geometry
const R = 6371;
const rad = d => (d * Math.PI) / 180;
function distKm([a1, o1], [a2, o2]) {
  const dLat = rad(a2 - a1), dLng = rad(o2 - o1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing([a1, o1], [a2, o2]) {
  const y = Math.sin(rad(o2 - o1)) * Math.cos(rad(a2));
  const x = Math.cos(rad(a1)) * Math.sin(rad(a2)) - Math.sin(rad(a1)) * Math.cos(rad(a2)) * Math.cos(rad(o2 - o1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
/** Distance along the polyline of the vertex/segment point nearest to p. */
function progressOf(line, p) {
  let best = { d: Infinity, along: 0 }, along = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const seg = distKm(line[i], line[i + 1]);
    for (let k = 0; k <= 20; k++) {
      const f = k / 20;
      const q = [line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f];
      const d = distKm(q, p);
      if (d < best.d) best = { d, along: along + seg * f };
    }
    along += seg;
  }
  return best.along;
}
function pointAt(line, km) {
  let along = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const seg = distKm(line[i], line[i + 1]);
    if (along + seg >= km) {
      const f = seg ? (km - along) / seg : 0;
      return { p: [line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f], heading: bearing(line[i], line[i + 1]), end: false };
    }
    along += seg;
  }
  const n = line.length;
  return { p: line[n - 1], heading: n > 1 ? bearing(line[n - 2], line[n - 1]) : 0, end: true };
}

// ------------------------------------------------------------------ API (fleet plan)
let token = null;
async function api(path) {
  if (!token) {
    const r = await fetch(`${API}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'FLEET_MANAGER' }) });
    if (!r.ok) throw new Error(`login failed (${r.status}) — the emulator needs demo mode`);
    token = (await r.json()).token;
  }
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 401) { token = null; return api(path); }
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

const trackers = new Map(); // imei → state
const routeCache = new Map();

async function refreshPlan() {
  const [devices, active, trips] = await Promise.all([
    api('/v1/gps-devices?pageSize=200'), api('/v1/tracking/active?pageSize=1000'), api('/v1/trips?active=true&pageSize=200')
  ]);
  const positions = new Map((active.items || active).map(t => [t.truckId, t]));
  const tripByTruck = new Map(trips.items.map(t => [t.truckId, t]));
  for (const d of devices.items) {
    if (d.deviceStatus !== 'ACTIVE' || !d.truckId || d.provider !== 'TRACCAR') continue;
    const pos = positions.get(d.truckId);
    const trip = tripByTruck.get(d.truckId);
    let route = null;
    if (trip?.routeId && MOVING.includes(trip.status)) {
      if (!routeCache.has(trip.routeId)) routeCache.set(trip.routeId, (await api(`/v1/routes/${trip.routeId}`)).geometry || null);
      route = routeCache.get(trip.routeId);
    }
    const s = trackers.get(d.providerDeviceId) || { imei: d.providerDeviceId, fleetCode: pos?.fleetCode || d.truck?.fleetCode || d.providerDeviceId };
    const here = s.p || (pos && Number.isFinite(pos.lat) ? [pos.lat, pos.lng] : route ? route[0] : [9.0108, 38.7613]);
    if (route && route.length > 1) {
      if (s.tripId !== trip.id) s.km = progressOf(route, here); // join the route where the truck is
      s.route = route;
      s.tripId = trip.id;
      s.tripNumber = trip.tripNumber;
    } else {
      s.route = null;
      s.tripId = null;
    }
    s.p = here;
    trackers.set(d.providerDeviceId, s);
    if (!s.sock) connect(s);
  }
}

// ------------------------------------------------------------------ tracker links
function connect(s) {
  const sock = net.connect(PORT, HOST);
  s.sock = sock;
  s.ready = false;
  sock.on('connect', () => {
    const id = Buffer.from(s.imei, 'ascii');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(id.length, 0);
    sock.write(Buffer.concat([len, id]));
  });
  sock.on('data', d => {
    if (!s.ready) {
      s.ready = d[0] === 0x01;
      console.log(`${s.fleetCode}: ${s.ready ? 'link up' : 'IMEI rejected (register the device in Traccar)'}`);
      if (s.ready) send(s);
    }
  });
  const retry = () => {
    if (s.sock !== sock) return;
    s.sock = null;
    s.ready = false;
    setTimeout(() => connect(s), 5000);
  };
  sock.on('error', e => console.log(`${s.fleetCode}: ${e.message}`));
  sock.on('close', retry);
}

function send(s) {
  let speed = 0, angle = s.heading || 0;
  if (s.route) {
    const step = (SPEED_KMH * INTERVAL_S) / 3600;
    const at = pointAt(s.route, (s.km || 0) + step);
    s.km = (s.km || 0) + step;
    s.p = at.p;
    angle = at.heading;
    speed = at.end ? 0 : SPEED_KMH + Math.round((Math.random() - 0.5) * 8);
  }
  s.heading = angle;
  s.sock.write(avlPacket({ lat: s.p[0], lng: s.p[1], speed, angle, ts: Date.now() }));
}

// ------------------------------------------------------------------ main loop
await refreshPlan();
console.log(`GPS emulator: ${trackers.size} tracker(s) → ${HOST}:${PORT} every ${INTERVAL_S}s (driving trucks at ${SPEED_KMH} km/h). Ctrl+C to stop.`);
setInterval(() => {
  for (const s of trackers.values()) if (s.ready && s.sock) send(s);
}, INTERVAL_S * 1000);
setInterval(() => refreshPlan().catch(e => console.log(`plan refresh: ${e.message}`)), 5 * 60_000);
setInterval(() => {
  const moving = [...trackers.values()].filter(s => s.route).map(s => `${s.fleetCode}(${s.tripNumber}) ${s.km.toFixed(1)} km`);
  console.log(`${new Date().toISOString()}  online ${[...trackers.values()].filter(s => s.ready).length}/${trackers.size}${moving.length ? ' | driving: ' + moving.join(', ') : ''}`);
}, 60_000);
