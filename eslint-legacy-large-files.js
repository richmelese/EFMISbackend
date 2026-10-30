// Files above the 300-line limit when the rule was introduced (Phase 0). Each is split when its roadmap phase rebuilds
// it — remove the entry once the file is under the limit. Do not add new files: split them instead.
module.exports = {
  LEGACY_LARGE_FILES: [
  'src/modules/farmers/farmers.service.ts',
  'src/modules/logistics/drivers/drivers.service.ts',
  'src/modules/logistics/fleet/fleet.service.ts',
  'src/modules/logistics/routing/routing.service.ts',
  'src/modules/logistics/routing/tracking-processor.service.ts',
  'src/modules/logistics/shipments/shipments.service.ts',
  'src/modules/logistics/shipments/trips.service.ts',
  'src/modules/logistics/tracking/tracking.service.ts',
  'src/modules/logistics/warehouses/inventory.service.ts',
  'src/modules/logistics/warehouses/warehouses.service.ts',
  'src/modules/national/national.service.ts',
  'src/modules/quota/quota.service.ts',
  'src/modules/reports/reports.service.ts',
  ]
};
