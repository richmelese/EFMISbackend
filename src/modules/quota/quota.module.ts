import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseOrder, QuotaAdjustmentRequest, QuotaAllocation, QuotaAmendment, QuotaLetter, QuotaRun } from './entities/quota.entities';
import { DemandDocument } from '../national/entities/demand-document.entities';
import { QuotaEngineService } from './quota-engine.service';
import { QuotaRunsService } from './quota-runs.service';
import { QuotaService } from './quota.service';
import { QuotaLettersService } from './quota-letters.service';
import { QuotaController } from './quota.controller';

/** Quota allocation (REQ-1.4-001..010). Exports QuotaService (allocationToFrontend) for the USSD module. */
@Module({
  imports: [TypeOrmModule.forFeature([QuotaRun, QuotaAdjustmentRequest, QuotaAllocation, QuotaAmendment, QuotaLetter, PurchaseOrder, DemandDocument])],
  controllers: [QuotaController],
  providers: [QuotaEngineService, QuotaRunsService, QuotaService, QuotaLettersService],
  exports: [QuotaService, QuotaEngineService]
})
export class QuotaModule {}
