import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { QTY } from '../../../../common/utils/decimal';

/**
 * Warehouse / depot / union store (Logistics doc §13; also feeds the EFMIS "warehouseUtilization" dashboard).
 * kind: CENTRAL_HUB | REGIONAL_DEPOT | UNION_STORE | PC_STORE | PORT
 * status: ACTIVE | INACTIVE | MAINTENANCE
 */
@Entity('warehouses')
export class Warehouse {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 30 }) code: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 160 }) name: string;
  @Column({ type: 'varchar', length: 20, default: 'REGIONAL_DEPOT' }) kind: string;
  @Column({ type: 'text', nullable: true }) address: string | null;
  @Column({ type: 'double precision', nullable: true }) latitude: number | null;
  @Column({ type: 'double precision', nullable: true }) longitude: number | null;
  @Column(QTY()) capacityMt: number;
  @Column({ type: 'varchar', length: 40, nullable: true }) regionId: string | null;
  @Column({ type: 'varchar', length: 12, default: 'ACTIVE' }) status: string;
  @Column({ type: 'int', default: 0 }) sort: number;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** Product (fertilizer blend). sku matches fertilizer type codes: NPS, NPSB, UREA, DAP, NPK_ZN … */
@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 30 }) sku: string;
  @Column({ type: 'varchar', length: 160 }) name: string;
  /** MT (stock is kept in metric tons; 1 MT = 10 quintals = 20 bags of 50 kg) */
  @Column({ type: 'varchar', length: 10, default: 'MT' }) unit: string;
  /** Cargo category used for vehicle-type eligibility, e.g. BAGGED_FERTILIZER */
  @Column({ type: 'varchar', length: 30, default: 'BAGGED_FERTILIZER' }) cargoType: string;
  @Column({ type: 'boolean', default: true }) active: boolean;
}

/** Current balance per warehouse × product. available = onHand − reserved. */
@Entity('inventory_balances')
export class InventoryBalance {
  @PrimaryColumn({ type: 'uuid' }) warehouseId: string;
  @PrimaryColumn({ type: 'uuid' }) productId: string;
  @Column(QTY({ default: 0 })) onHandQuantity: number;
  @Column(QTY({ default: 0 })) reservedQuantity: number;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/**
 * Append-only inventory ledger. Every balance change is a row here.
 * type: RECEIPT | DISPATCH | RESERVE | RELEASE | ADJUSTMENT | RETURN | DAMAGE | DELIVERY_RECEIPT | LOADING_DISCREPANCY | TRANSFER_IN | TRANSFER_OUT
 * onHandDelta / reservedDelta are the signed effects on the balance.
 * referenceType: SHIPMENT | TRIP | DELIVERY | MANUAL | FEED
 */
@Entity('inventory_transactions')
@Index(['warehouseId', 'productId'])
@Index(['referenceType', 'referenceId'])
export class InventoryTransaction {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'varchar', length: 24 }) type: string;
  /** Absolute quantity of the movement (MT) */
  @Column(QTY()) quantity: number;
  @Column(QTY({ default: 0 })) onHandDelta: number;
  @Column(QTY({ default: 0 })) reservedDelta: number;
  @Column(QTY()) onHandAfter: number;
  @Column(QTY()) reservedAfter: number;
  @Column({ type: 'varchar', length: 12, nullable: true }) referenceType: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) referenceId: string | null;
  /** Lot moved (null only for legacy rows written before lots existed) */
  @Index() @Column({ type: 'uuid', nullable: true }) lotId: string | null;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  @Column({ type: 'varchar', length: 160 }) createdBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/**
 * Stock lot (batch / QR lot) in a warehouse. The product balance (InventoryBalance) is always the sum of its lots.
 * qcStatus: PASSED (usable) | PENDING (awaiting quality control) | HELD (quality hold) | REJECTED.
 * Only PASSED, unexpired lots can be reserved; loading is blocked when an allocated lot is no longer PASSED.
 */
@Entity('inventory_lots')
@Index(['warehouseId', 'productId', 'lotNumber'], { unique: true })
@Index(['warehouseId', 'productId', 'qcStatus'])
export class InventoryLot {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'varchar', length: 64 }) lotNumber: string;
  @Column({ type: 'varchar', length: 12, default: 'PASSED' }) qcStatus: string;
  /** ECAE certificate of conformity / lab report reference */
  @Column({ type: 'varchar', length: 80, nullable: true }) qcReference: string | null;
  @Column({ type: 'text', nullable: true }) qcNotes: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) qcDecidedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) qcDecidedAt: Date | null;
  @Column({ type: 'date', nullable: true }) expiryDate: string | null;
  @Column(QTY({ default: 0 })) onHandQuantity: number;
  @Column(QTY({ default: 0 })) reservedQuantity: number;
  /** Lot this stock came from (transfer / delivery) — chain of custody across warehouses */
  @Column({ type: 'uuid', nullable: true }) sourceLotId: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) receivedAt: Date;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** Which lots a reservation (shipment) holds, and how much of it was loaded. */
@Entity('inventory_allocations')
@Index(['referenceType', 'referenceId'])
@Index(['lotId'])
export class InventoryAllocation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 12 }) referenceType: string;
  @Column({ type: 'varchar', length: 60 }) referenceId: string;
  @Column({ type: 'uuid' }) lotId: string;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column(QTY({ default: 0 })) reservedQuantity: number;
  @Column(QTY({ default: 0 })) consumedQuantity: number;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
