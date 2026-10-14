import { EntityManager } from 'typeorm';

/**
 * Opening lots for stock that exists without lots (seed data, or balances written before lots existed): one PASSED lot
 * `OPENING-<warehouse>-<sku>` per warehouse × product holding the whole balance, with the open shipment reservations
 * and in-transit loads attached as allocations. Idempotent. (The RBAC/lot migration runs the same SQL.)
 */
export const OPENING_LOTS_SQL = [
  `INSERT INTO inventory_lots (warehouse_id, product_id, lot_number, qc_status, on_hand_quantity, reserved_quantity)
   SELECT b.warehouse_id, b.product_id, 'OPENING-' || w.code || '-' || p.sku, 'PASSED', b.on_hand_quantity, b.reserved_quantity
     FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id JOIN products p ON p.id = b.product_id
    WHERE (b.on_hand_quantity > 0 OR b.reserved_quantity > 0)
      AND NOT EXISTS (SELECT 1 FROM inventory_lots l WHERE l.warehouse_id = b.warehouse_id AND l.product_id = b.product_id)`,
  `INSERT INTO inventory_allocations (reference_type, reference_id, lot_id, warehouse_id, product_id, reserved_quantity, consumed_quantity)
   SELECT 'SHIPMENT', s.id::text, l.id, s.origin_warehouse_id, s.product_id,
          CASE WHEN s.status IN ('IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'CLOSED', 'DELIVERY_FAILED') THEN 0 ELSE s.reserved_quantity END,
          CASE WHEN s.status IN ('IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'CLOSED', 'DELIVERY_FAILED') THEN COALESCE(s.loaded_quantity, 0) ELSE 0 END
     FROM shipments s
     JOIN inventory_lots l ON l.warehouse_id = s.origin_warehouse_id AND l.product_id = s.product_id
          AND l.lot_number LIKE 'OPENING-%'
    WHERE s.product_id IS NOT NULL
      AND (s.reserved_quantity > 0 OR (s.status IN ('IN_TRANSIT', 'ARRIVED') AND COALESCE(s.loaded_quantity, 0) > 0))
      AND NOT EXISTS (SELECT 1 FROM inventory_allocations a WHERE a.reference_type = 'SHIPMENT' AND a.reference_id = s.id::text)`
];

export async function backfillOpeningLots(m: EntityManager): Promise<void> {
  for (const sql of OPENING_LOTS_SQL) await m.query(sql);
}
