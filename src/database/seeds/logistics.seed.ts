// Logistics & Driver Management seed: turns the frontend's static fleet/warehouse data (EFMIS_DATA.logistics) into real
// records — warehouses + inventory ledger, products, vehicle types, trucks + GPS devices, verified drivers, routes,
// geofences, and the four active trips/shipments that the GPS fleet table shows.
import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { EFMIS_DATA } from './data/efmis-data';
import { DEFAULT_LOGISTICS_THRESHOLDS } from '../../modules/logistics/logistics.constants';
import { Setting } from '../../modules/settings/entities/setting.entity';
import { Driver, DriverDocument, DriverTripAssignment } from '../../modules/logistics/drivers/entities/driver.entities';
import { GpsDevice, GpsDeviceAssignment, Truck, TruckLocation, VehicleType } from '../../modules/logistics/fleet/entities/fleet.entities';
import { InventoryBalance, InventoryTransaction, Product, Warehouse } from '../../modules/logistics/warehouses/entities/warehouse.entities';
import { Geofence, Route, RouteMilestone, TripMilestone } from '../../modules/logistics/routing/entities/routing.entities';
import { Shipment, Trip, TripChecklist, TripShipment } from '../../modules/logistics/shipments/entities/shipment.entities';
import { haversineKm, polylineLengthKm, LatLng } from '../../common/utils/geo';
import { StorageService } from '../../modules/storage/storage.service';
import { objectKey } from '../../modules/storage/storage.types';

/** A minimal valid one-page PDF, so seeded driver documents have a real object to download. */
function placeholderPdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, '');
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${text.length + 40}>>stream\nBT /F1 12 Tf 20 60 Td (${text}) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');
}

/** Coordinates of the seeded warehouses (approximate site locations). */
const WAREHOUSES: Array<{ code: string; name: string; kind: string; lat: number; lng: number; capacity?: number; stock?: number; regionId: string | null; address: string }> = [
  { code: 'WH-MOJO', name: 'Mojo Central Mega-Hub', kind: 'CENTRAL_HUB', lat: 8.5873, lng: 39.1213, regionId: 'REG-OROMIA', address: 'Mojo Dry Port, East Shewa' },
  { code: 'WH-NAZRET', name: 'Nazret Buffer Depot', kind: 'REGIONAL_DEPOT', lat: 8.5263, lng: 39.2583, regionId: 'REG-OROMIA', address: 'Adama (Nazret) industrial zone' },
  { code: 'WH-KOMBOLCHA', name: 'Kombolcha Regional Hub', kind: 'REGIONAL_DEPOT', lat: 11.0849, lng: 39.7292, regionId: 'REG-AMHARA', address: 'Kombolcha, South Wollo' },
  { code: 'WH-BAHIRDAR', name: 'Bahir Dar Regional Depot', kind: 'REGIONAL_DEPOT', lat: 11.5742, lng: 37.3614, regionId: 'REG-AMHARA', address: 'Bahir Dar' },
  { code: 'WH-HAWASSA', name: 'Hawassa Buffer Depot', kind: 'REGIONAL_DEPOT', lat: 7.0621, lng: 38.4764, regionId: 'REG-SIDAMA', address: 'Hawassa industrial park road' },
  { code: 'WH-DIREDAWA', name: 'Dire Dawa Warehouse', kind: 'REGIONAL_DEPOT', lat: 9.6009, lng: 41.8501, regionId: null, address: 'Dire Dawa' },
  { code: 'WH-DJIBOUTI', name: 'Djibouti DMP Port Terminal', kind: 'PORT', lat: 11.5951, lng: 43.1253, capacity: 300000, stock: 165000, regionId: null, address: 'Doraleh Multipurpose Port, Djibouti' },
  { code: 'WH-ADAMA-UNION', name: 'Adama Union Store (PC-882 hub)', kind: 'UNION_STORE', lat: 8.5510, lng: 39.2890, capacity: 8000, stock: 2400, regionId: 'REG-OROMIA', address: 'Adama Farmers Cooperative Union' }
];

/** Share of each warehouse's stock per product (sums to 1). */
const STOCK_MIX: Array<[string, number]> = [['NPSB', 0.4], ['UREA', 0.3], ['NPS', 0.2], ['DAP', 0.1]];

/** Corridor waypoints (lat, lng) used as route geometry. */
const CORRIDOR = {
  djiboutiToAdama: [[11.5951, 43.1253], [11.72, 41.83], [11.505, 41.2], [9.35, 40.13], [8.98, 40.17], [8.54, 39.27], [8.5873, 39.1213]] as LatLng[],
  djiboutiToKombolcha: [[11.5951, 43.1253], [11.72, 41.83], [11.75, 40.98], [11.1, 39.95], [11.0849, 39.7292]] as LatLng[],
  djiboutiToHawassa: [[11.5951, 43.1253], [11.72, 41.83], [9.352, 40.125], [8.54, 39.27], [7.92, 38.72], [7.0621, 38.4764]] as LatLng[],
  mojoToAdamaUnion: [[8.5873, 39.1213], [8.541, 39.271], [8.551, 39.289]] as LatLng[]
};

const now = () => new Date();
const hoursFromNow = (h: number) => new Date(Date.now() + h * 36e5);

export async function seedLogistics(m: EntityManager, storage: StorageService): Promise<void> {
  await m.getRepository(Setting).save({ key: 'logisticsThresholds', value: DEFAULT_LOGISTICS_THRESHOLDS, updatedBy: 'seed' });

  // ---- Products ----
  const products = await m.getRepository(Product).save(
    EFMIS_DATA.fertilizerTypes.map((f: any) => ({ sku: f.code, name: f.name, unit: 'MT', cargoType: 'BAGGED_FERTILIZER' }))
  );
  const product = (sku: string) => products.find(p => p.sku === sku)!;

  // ---- Warehouses + opening balances (ledger) ----
  const util: any[] = EFMIS_DATA.logistics.warehouseUtilization;
  const wh: Record<string, Warehouse> = {};
  for (const [i, w] of WAREHOUSES.entries()) {
    const fe = util.find(u => u.name === w.name);
    const capacity = fe?.capacityMT ?? w.capacity!;
    const stock = fe?.currentStockMT ?? w.stock!;
    const saved = await m.getRepository(Warehouse).save({
      code: w.code, name: w.name, kind: w.kind, address: w.address, latitude: w.lat, longitude: w.lng, capacityMt: capacity, regionId: w.regionId, status: 'ACTIVE', sort: i
    });
    wh[w.code] = saved;
    for (const [sku, share] of STOCK_MIX) {
      const qty = Math.round(stock * share);
      await m.getRepository(InventoryBalance).insert({ warehouseId: saved.id, productId: product(sku).id, onHandQuantity: qty, reservedQuantity: 0 });
      await m.getRepository(InventoryTransaction).insert({
        warehouseId: saved.id, productId: product(sku).id, type: 'RECEIPT', quantity: qty, onHandDelta: qty, reservedDelta: 0, onHandAfter: qty, reservedAfter: 0,
        referenceType: 'MANUAL', referenceId: 'OPENING-BALANCE', notes: 'Opening balance migrated from EFMIS warehouse feed', createdBy: 'seed'
      });
    }
  }

  // ---- Geofences: one per warehouse + corridor checkpoints ----
  const gf: Record<string, Geofence> = {};
  for (const w of Object.values(wh)) {
    gf[w.code] = await m.getRepository(Geofence).save({
      name: `${w.name} gate`, kind: w.kind === 'PORT' ? 'PORT' : 'WAREHOUSE', shape: 'CIRCLE', centerLat: w.latitude, centerLng: w.longitude, radiusM: 1500, warehouseId: w.id, minConsecutivePoints: 2
    });
  }
  gf.GALAFI = await m.getRepository(Geofence).save({ name: 'Galafi Border Crossing', kind: 'BORDER', shape: 'CIRCLE', centerLat: 11.72, centerLng: 41.83, radiusM: 2000, minConsecutivePoints: 2 });
  gf.AWASH = await m.getRepository(Geofence).save({ name: 'Awash Weighbridge Checkpoint', kind: 'CHECKPOINT', shape: 'CIRCLE', centerLat: 8.98, centerLng: 40.17, radiusM: 1500, minConsecutivePoints: 2 });
  gf.MILLE = await m.getRepository(Geofence).save({ name: 'Mille Weighbridge', kind: 'CHECKPOINT', shape: 'CIRCLE', centerLat: 11.505, centerLng: 41.2, radiusM: 1500, minConsecutivePoints: 2 });

  // ---- Routes + milestones ----
  const mkRoute = async (code: string, name: string, from: string, to: string, geometry: LatLng[], milestones: Array<[string, Geofence, number]>) => {
    const distanceKm = Math.round(polylineLengthKm(geometry) * 10) / 10;
    const route = await m.getRepository(Route).save({
      code, name, originWarehouseId: wh[from].id, destinationWarehouseId: wh[to].id, geometry, distanceKm,
      estimatedDurationMin: Math.round((distanceKm / DEFAULT_LOGISTICS_THRESHOLDS.averageSpeedKmh) * 60), corridorWidthKm: 3, geometrySource: 'MANUAL', createdBy: 'seed'
    });
    for (const [i, [mname, geofence, offset]] of milestones.entries()) {
      await m.getRepository(RouteMilestone).insert({ routeId: route.id, sequence: i + 1, name: mname, geofenceId: geofence.id, expectedOffsetMin: offset, toleranceMin: 90 });
    }
    return route;
  };
  const routes = {
    djMojo: await mkRoute('RT-DJI-MOJO', 'Djibouti DMP → Mojo Central Hub', 'WH-DJIBOUTI', 'WH-MOJO', CORRIDOR.djiboutiToAdama,
      [['Galafi border', gf.GALAFI, 240], ['Mille weighbridge', gf.MILLE, 330], ['Awash weighbridge', gf.AWASH, 840], ['Mojo hub gate', gf['WH-MOJO'], 1080]]),
    djKombolcha: await mkRoute('RT-DJI-KOMB', 'Djibouti DMP → Kombolcha Hub', 'WH-DJIBOUTI', 'WH-KOMBOLCHA', CORRIDOR.djiboutiToKombolcha,
      [['Galafi border', gf.GALAFI, 240], ['Kombolcha hub gate', gf['WH-KOMBOLCHA'], 900]]),
    djHawassa: await mkRoute('RT-DJI-HAW', 'Djibouti DMP → Hawassa Buffer Depot', 'WH-DJIBOUTI', 'WH-HAWASSA', CORRIDOR.djiboutiToHawassa,
      [['Galafi border', gf.GALAFI, 240], ['Awash weighbridge', gf.AWASH, 840], ['Hawassa depot gate', gf['WH-HAWASSA'], 1500]]),
    mojoUnion: await mkRoute('RT-MOJO-ADU', 'Mojo Central Hub → Adama Union (PC-882)', 'WH-MOJO', 'WH-ADAMA-UNION', CORRIDOR.mojoToAdamaUnion,
      [['Adama Union gate', gf['WH-ADAMA-UNION'], 60]])
  };

  // ---- Vehicle types ----
  const heavy = await m.getRepository(VehicleType).save({ code: 'HGV-40', name: 'Heavy goods truck & trailer (40 MT)', maxCapacityValue: 45, capacityUnit: 'MT', allowedLicenceClasses: ['CE'], cargoTypes: ['BAGGED_FERTILIZER', 'BULK'] });
  const medium = await m.getRepository(VehicleType).save({ code: 'MGV-20', name: 'Medium rigid truck (20 MT)', maxCapacityValue: 25, capacityUnit: 'MT', allowedLicenceClasses: ['C', 'CE'], cargoTypes: ['BAGGED_FERTILIZER'] });

  // ---- Drivers (verified, with licence documents) ----
  const licenceExpiry = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  const driverSpecs: Array<[string, string, string, string, string, string, string, number, string | null]> = [
    // employeeNo, first, last, phone, licenceNo, class, employer, licence expiry days, user id
    ['ESLSE-DRV-0418', 'Tadesse', 'Hailu', '0911804418', 'ET-DL-0418-2019', 'CE', 'ESLSE', 900, 'U-DRV-01'],
    ['ESLSE-DRV-0522', 'Kibret', 'Mengistu', '0911800522', 'ET-DL-0522-2018', 'CE', 'ESLSE', 700, 'U-DRV-02'],
    ['TRN-DRV-1093', 'Ahmed', 'Nur', '0911801093', 'ET-DL-1093-2020', 'CE', 'Awash Transport PLC', 600, null],
    ['TRN-DRV-1381', 'Girma', 'Belay', '0911801381', 'ET-DL-1381-2017', 'CE', 'Abay Logistics PLC', 500, null],
    ['ESLSE-DRV-0610', 'Solomon', 'Kebede', '0911800610', 'ET-DL-0610-2021', 'CE', 'ESLSE', 820, 'U-DRV-03'],
    ['ESLSE-DRV-0733', 'Hana', 'Tesfaye', '0911800733', 'ET-DL-0733-2016', 'C', 'ESLSE', 20, null]
  ];
  const drivers: Driver[] = [];
  for (const [employeeNumber, firstName, lastName, phone, licenceNumber, licenceClass, employer, days, userId] of driverSpecs) {
    const d = await m.getRepository(Driver).save({
      employeeNumber, firstName, lastName, phone, licenceNumber, licenceClass, licenceExpiryDate: licenceExpiry(days), employer, userId,
      verificationStatus: 'VERIFIED', employmentStatus: 'ACTIVE', availabilityStatus: 'AVAILABLE',
      emergencyContactName: `${firstName} family`, emergencyContactPhone: '0911000999', certifications: [{ name: 'Dangerous & bulk cargo handling', expiresAt: licenceExpiry(days + 200) }]
    });
    // a real (placeholder) licence PDF in the driver-documents bucket; no write-once retention for demo data
    const pdf = placeholderPdf(`Demo driving licence ${licenceNumber} - ${firstName} ${lastName}`);
    const hash = createHash('sha256').update(pdf).digest('hex');
    const stored = await storage.put('DRIVER_DOCUMENTS', objectKey(d.id, 'licence-demo.pdf'), pdf, { mimeType: 'application/pdf', sha256: hash });
    await m.getRepository(DriverDocument).insert({
      driverId: d.id, documentType: 'LICENCE', secureStorageKey: stored.key, fileName: `${employeeNumber}-licence.pdf`, mimeType: 'application/pdf',
      sizeBytes: pdf.length, sha256: hash, issuedAt: '2022-01-15', expiresAt: d.licenceExpiryDate, verificationStatus: 'VERIFIED', verifiedBy: 'seed', verifiedAt: now()
    });
    drivers.push(d);
  }

  // ---- Trucks + GPS devices (Teltonika via the GPS Tracking Platform) ----
  const fleet: any[] = EFMIS_DATA.logistics.gpsFleet;
  const truckRows: Truck[] = [];
  const truckSpecs = [
    ...fleet.map((t, i) => ({ fleetCode: t.truckId, plate: t.vehicleNo, ownership: t.truckId.startsWith('ESLSE') ? 'ESLSE' : 'PRIVATE_TRANSPORTER', transporter: t.truckId.startsWith('ESLSE') ? null : drivers[i].employer, lat: t.lat, lng: t.lng, speed: t.speedKmH, imei: `35209310${String(4418 + i).padStart(7, '0')}` })),
    { fleetCode: 'ESLSE-TRK-9100', plate: '3-ET-90011', ownership: 'ESLSE', transporter: null, lat: 8.5873, lng: 39.1213, speed: 0, imei: '352093100009100' }
  ];
  for (const [i, s] of truckSpecs.entries()) {
    const t = await m.getRepository(Truck).save({
      fleetCode: s.fleetCode, plateNumber: s.plate, vehicleTypeId: heavy.id, capacityValue: 42, capacityUnit: 'MT', ownership: s.ownership, transporterName: s.transporter,
      operationalStatus: 'ACTIVE', availabilityStatus: 'AVAILABLE', lastLat: s.lat, lastLng: s.lng, lastSpeedKmh: s.speed, lastHeading: 245, lastPositionAt: now(),
      stationarySince: s.speed === 0 ? new Date(Date.now() - (fleet[i]?.status === 'STOPPED_ALERT' ? 3.6 * 36e5 : 20 * 60e3)) : null
    });
    const device = await m.getRepository(GpsDevice).save({
      provider: 'TRACCAR', providerDeviceId: s.imei, imei: s.imei, model: i % 2 ? 'Teltonika FMC130' : 'Teltonika FMB920', simNumber: `09${String(10000000 + i * 7919).slice(0, 8)}`,
      truckId: t.id, deviceStatus: 'ACTIVE', connectivity: 'ONLINE', lastSeenAt: now(), lastPositionRecordedAt: now()
    });
    await m.getRepository(GpsDeviceAssignment).insert({ deviceId: device.id, truckId: t.id, assignedAt: new Date(Date.now() - 30 * 864e5), assignedBy: 'seed', reason: 'Initial installation' });
    await m.getRepository(TruckLocation).insert({
      truckId: t.id, deviceId: device.id, latitude: s.lat, longitude: s.lng, speedKmh: s.speed, heading: 245, recordedAt: now(), receivedAt: now(), source: 'TRACCAR_WEBHOOK', providerPositionId: `seed-${i}`
    });
    truckRows.push(t);
  }
  void medium;

  // ---- Active trips (the GPS fleet table) ----
  const tripSpecs = [
    { from: 'WH-DJIBOUTI', to: 'WH-MOJO', route: routes.djMojo, sku: 'NPSB', qty: 40, lot: fleet[0].qrLot, status: 'IN_PROGRESS', ship: 'IN_TRANSIT', etaH: 16 + 20 / 60, startedH: -9 },
    { from: 'WH-DJIBOUTI', to: 'WH-KOMBOLCHA', route: routes.djKombolcha, sku: 'UREA', qty: 40, lot: fleet[1].qrLot, status: 'IN_PROGRESS', ship: 'IN_TRANSIT', etaH: 12.75, startedH: -6 },
    { from: 'WH-MOJO', to: 'WH-ADAMA-UNION', route: routes.mojoUnion, sku: 'NPS', qty: 38, lot: fleet[2].qrLot, status: 'UNLOADING', ship: 'ARRIVED', etaH: 0, startedH: -2 },
    { from: 'WH-DJIBOUTI', to: 'WH-HAWASSA', route: routes.djHawassa, sku: 'DAP', qty: 40, lot: fleet[3].qrLot, status: 'IN_PROGRESS', ship: 'IN_TRANSIT', etaH: 22, startedH: -14 }
  ];
  for (const [i, s] of tripSpecs.entries()) {
    const n = 1001 + i;
    const start = hoursFromNow(s.startedH);
    const eta = hoursFromNow(s.etaH);
    const shipment = await m.getRepository(Shipment).save({
      shipmentNumber: `SH-${n}`, customerName: wh[s.to].name, originWarehouseId: wh[s.from].id, destinationWarehouseId: wh[s.to].id, productId: product(s.sku).id,
      cargoDescription: `${s.qty} MT ${s.sku} (Bagged with QR)`, plannedQuantity: s.qty, quantityUnit: 'MT', priority: 'HIGH', plannedPickupAt: start,
      plannedDeliveryAt: hoursFromNow(s.etaH + 4), routeId: s.route.id, qrLot: s.lot, status: s.ship, estimatedArrivalAt: s.etaH ? eta : null,
      reservedQuantity: 0, loadedQuantity: s.qty, createdBy: 'seed'
    });
    // stock already left the origin: ledger DISPATCH entry
    const bal = await m.getRepository(InventoryBalance).findOneByOrFail({ warehouseId: wh[s.from].id, productId: product(s.sku).id });
    const after = bal.onHandQuantity - s.qty;
    await m.getRepository(InventoryBalance).update({ warehouseId: bal.warehouseId, productId: bal.productId }, { onHandQuantity: after });
    await m.getRepository(InventoryTransaction).insert({
      warehouseId: bal.warehouseId, productId: bal.productId, type: 'DISPATCH', quantity: s.qty, onHandDelta: -s.qty, reservedDelta: 0, onHandAfter: after, reservedAfter: bal.reservedQuantity,
      referenceType: 'SHIPMENT', referenceId: shipment.id, notes: `Dispatched on TR-${n}`, createdBy: 'seed'
    });
    const truck = truckRows[i];
    const driver = drivers[i];
    const remaining = s.etaH ? Math.round(haversineKm([truck.lastLat!, truck.lastLng!], [wh[s.to].latitude!, wh[s.to].longitude!]) * 1.3) : 0;
    const trip = await m.getRepository(Trip).save({
      tripNumber: `TR-${n}`, truckId: truck.id, primaryDriverId: driver.id, routeId: s.route.id, plannedStartAt: start, actualStartAt: start,
      estimatedArrivalAt: s.etaH ? eta : null, actualArrivalAt: s.status === 'UNLOADING' ? hoursFromNow(-0.3) : null, status: s.status,
      remainingDistanceKm: remaining, etaComputedAt: now(), etaComputedAtLat: truck.lastLat, etaComputedAtLng: truck.lastLng, createdBy: 'seed'
    });
    await m.getRepository(TripShipment).insert({ tripId: trip.id, shipmentId: shipment.id, stopSequence: 1, loadedQuantity: s.qty, loadingDiscrepancy: 0, loadedAt: start, loadedBy: 'seed' });
    await m.getRepository(TripChecklist).insert({
      tripId: trip.id, items: [{ item: 'Brakes', ok: true }, { item: 'Tyres', ok: true }, { item: 'Lights', ok: true }, { item: 'Tarpaulin cover & seals', ok: true }],
      passed: true, driverAcknowledged: true, completedBy: `${driver.firstName} ${driver.lastName}`
    });
    await m.getRepository(DriverTripAssignment).insert({ driverId: driver.id, tripId: trip.id, assignedAt: hoursFromNow(s.startedH - 3), assignedBy: 'seed', status: 'ACTIVE' });
    await m.getRepository(Driver).update({ id: driver.id }, { availabilityStatus: 'ON_TRIP' });
    await m.getRepository(Truck).update({ id: truck.id }, { availabilityStatus: 'ON_TRIP' });
    await m.getRepository(TruckLocation).update({ truckId: truck.id }, { tripId: trip.id });
    const ms = await m.getRepository(RouteMilestone).find({ where: { routeId: s.route.id }, order: { sequence: 'ASC' } });
    for (const rm of ms) {
      const expectedAt = new Date(start.getTime() + rm.expectedOffsetMin * 60e3);
      const reached = expectedAt < now();
      await m.getRepository(TripMilestone).insert({
        tripId: trip.id, routeMilestoneId: rm.id, sequence: rm.sequence, name: rm.name, geofenceId: rm.geofenceId, expectedAt,
        reachedAt: reached ? expectedAt : null, status: reached ? 'REACHED' : 'PENDING'
      });
    }
  }
}

/** Logistics demo users (password Efmis@2026 / PIN 1234 — hashes supplied by the caller). */
export const LOGISTICS_USERS: Array<[string, string, string, string, string, string, string | null]> = [
  // id, name, email, phone, role, title, warehouse code
  ['U-LOG-01', 'ESLSE Logistics Manager', 'logistics.manager@eslse.gov.et', '0911000021', 'LOGISTICS_MANAGER', 'Logistics Manager, ESLSE', null],
  ['U-DSP-01', 'Corridor Dispatcher', 'dispatch@eslse.gov.et', '0911000022', 'DISPATCHER', 'Dispatcher, Djibouti–Mojo corridor', null],
  ['U-FLT-01', 'Fleet & GPS Manager', 'fleet@eslse.gov.et', '0911000023', 'FLEET_MANAGER', 'Fleet Manager, ESLSE', null],
  ['U-DRV-01', 'Tadesse Hailu', 'tadesse.hailu@eslse.gov.et', '0911804418', 'DRIVER', 'Driver ESLSE-DRV-0418', null],
  ['U-DRV-02', 'Kibret Mengistu', 'kibret.mengistu@eslse.gov.et', '0911800522', 'DRIVER', 'Driver ESLSE-DRV-0522', null],
  ['U-DRV-03', 'Solomon Kebede', 'solomon.kebede@eslse.gov.et', '0911800610', 'DRIVER', 'Driver ESLSE-DRV-0610', null],
  ['U-WHO-01', 'Mojo Hub Warehouse Operator', 'store.mojo@eslse.gov.et', '0911000024', 'WAREHOUSE_OPERATOR', 'Storekeeper, Mojo Central Mega-Hub', 'WH-MOJO'],
  ['U-WHO-02', 'Adama Union Storekeeper', 'store.adamaunion@efmis.gov.et', '0911000025', 'WAREHOUSE_OPERATOR', 'Storekeeper, Adama Union', 'WH-ADAMA-UNION']
];

export const LOGISTICS_ROLES = [
  { id: 'LOGISTICS_MANAGER', name: 'Logistics Manager', level: 'Enterprise', desc: 'Operations, shipments, drivers and fleet oversight' },
  { id: 'DISPATCHER', name: 'Dispatcher', level: 'Enterprise', desc: 'Assign trucks/drivers, dispatch and monitor trips' },
  { id: 'FLEET_MANAGER', name: 'Fleet Manager', level: 'Enterprise', desc: 'Truck/device status, maintenance and GPS device mapping' },
  { id: 'DRIVER', name: 'Driver', level: 'Field', desc: 'Own assigned trips: acceptance, pre-trip checks, incidents' },
  { id: 'WAREHOUSE_OPERATOR', name: 'Warehouse Operator', level: 'Facility', desc: 'Loading, stock movements and receipt confirmation for one warehouse' }
];
