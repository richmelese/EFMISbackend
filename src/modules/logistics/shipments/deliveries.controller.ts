import { Controller, Get, Param, ParseUUIDPipe, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import * as fs from 'fs';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { DeliveriesService } from './deliveries.service';

@ApiTags('Logistics · Shipments')
@ApiBearerAuth()
@Controller({ path: 'deliveries', version: '1' })
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get(':id/proof')
  @RequirePermissions('deliveries:confirm', 'drivers:sensitive')
  @ApiOperation({ summary: 'Download the proof of delivery (private storage; access audited as DELIVERY_PROOF_ACCESSED)' })
  async proof(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const f = await this.deliveries.proof(user, id, ctx);
    return new StreamableFile(fs.createReadStream(f.path), { type: f.mimeType, disposition: `inline; filename="${f.fileName}"` });
  }
}
