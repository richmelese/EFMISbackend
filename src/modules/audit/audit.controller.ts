import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { nowStamp, paginate, toCsv } from '../../common/utils/helpers';
import { AuditQuery, AuditService } from './audit.service';

@ApiTags('Audit Trail (REQ-1.7-002)')
@ApiBearerAuth()
@Controller('audit')
@RequirePermissions('audit:read')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Search the audit trail (user, action, target, role, from, to, q, limit; page/pageSize)' })
  async list(@Query() q: AuditQuery, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return paginate(req, res, await this.audit.list(q));
  }

  @Get('verify')
  @ApiOperation({ summary: 'Verify the SHA-256 hash chain (tamper detection)' })
  verify() {
    return this.audit.verifyChain();
  }

  @Get('export')
  @ApiOperation({ summary: 'Export audit trail as CSV' })
  async export(@Query() q: AuditQuery, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext, @Res() res: Response) {
    const rows = await this.audit.list({ ...q, limit: 5000 });
    await this.audit.record(user, 'DATA_EXPORT', 'AUDIT_TRAIL', { rows: rows.length }, ctx);
    res.attachment(`efmis-audit-${nowStamp().slice(0, 10)}.csv`).type('text/csv')
      .send(toCsv(['ID', 'Timestamp', 'User', 'Role', 'Action', 'Target', 'IP', 'Hash', 'Details'],
        rows.map(r => [r.id, r.timestamp, r.user, r.role, r.action, r.target, r.ip, r.hash, r.details ? JSON.stringify(r.details) : ''])));
  }
}
