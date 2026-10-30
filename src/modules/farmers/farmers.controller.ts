import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { paginate } from '../../common/utils/helpers';
import {
  CheckDuplicateQueryDto, DeleteFarmerDto, ListFarmersQueryDto, RegisterFarmerDto, SyncFarmersDto, UpdateFarmerDto, UploadDocumentDto
} from './dto/farmer.dto';
import { FarmersService, UploadedDoc } from './farmers.service';

@ApiTags('Farmers (REQ-1.1)')
@ApiBearerAuth()
@Controller('farmers')
export class FarmersController {
  constructor(private readonly farmers: FarmersService) {}

  @Get()
  @RequirePermissions('farmers:read')
  @ApiOperation({ summary: 'List farmers in your administrative scope (filters, sorting, optional paging via page/pageSize)' })
  async list(@Query() q: ListFarmersQueryDto, @CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return paginate(req, res, await this.farmers.list(user, q));
  }

  @Get('recommendation')
  @RequirePermissions('farmers:read')
  @ApiOperation({ summary: 'Agronomic recommendation preview (quintals per fertilizer for a farm size)' })
  @ApiQuery({ name: 'farmSizeHa', required: false, type: Number })
  recommendation(@Query('farmSizeHa') farmSizeHa?: string) {
    return this.farmers.recommendation(farmSizeHa);
  }

  @Get('check-duplicate')
  @RequirePermissions('farmers:read')
  @ApiOperation({ summary: 'Duplicate check by Fayda ID / land certificate (REQ-1.1-004)' })
  checkDuplicate(@Query() q: CheckDuplicateQueryDto) {
    return this.farmers.checkDuplicate(q.faydaId, q.landCertNumber);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermissions('farmers:create', 'farmers:update')
  @ApiOperation({ summary: 'Offline batch sync (REQ-1.1-006): checksums, idempotent clientUuid, last-write-wins' })
  sync(@Body() dto: SyncFarmersDto, @Req() req: Request, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const raw = Array.isArray(req.body?.records) ? req.body.records : [];
    return this.farmers.sync(user, dto, raw, ctx);
  }

  @Get(':id')
  @RequirePermissions('farmers:read')
  @ApiOperation({ summary: 'Farmer record (frontend shape incl. demand lines and quality flags)' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.farmers.findOne(user, id);
  }

  @Get(':id/history')
  @RequirePermissions('farmers:read')
  @ApiOperation({ summary: 'Approval history, audit trail and previous seasons of a farmer' })
  history(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.farmers.history(user, id);
  }

  @Post()
  @RequirePermissions('farmers:create')
  @ApiOperation({ summary: 'Register a farmer & demand (REQ-1.1-001: validation, Fayda/NRLAIS verification, anomaly flagging)' })
  async create(@Body() dto: RegisterFarmerDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const { farmer, warnings } = await this.farmers.register(user, dto, ctx);
    return { ...farmer, warnings };
  }

  @Patch(':id')
  @RequirePermissions('farmers:update')
  @ApiOperation({ summary: 'Edit a pending / returned record (optimistic concurrency via version)' })
  update(@Param('id') id: string, @Body() dto: UpdateFarmerDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.farmers.update(user, id, dto, ctx);
  }

  @Delete(':id')
  @RequirePermissions('farmers:delete')
  @ApiOperation({ summary: 'Soft-delete a record pending kebele review (reason required)' })
  remove(@Param('id') id: string, @Body() dto: DeleteFarmerDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.farmers.remove(user, id, dto, ctx);
  }

  @Post(':id/documents')
  @RequirePermissions('farmers:documents')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'consent'],
      properties: { file: { type: 'string', format: 'binary' }, docType: { type: 'string', example: 'PHOTO' }, consent: { type: 'string', example: 'true' } }
    }
  })
  @ApiOperation({ summary: 'Upload photo / ID / land certificate (JPEG, PNG, PDF; consent required; duplicate detection)' })
  uploadDocument(
    @Param('id') id: string,
    @UploadedFile() file: UploadedDoc | undefined,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext
  ) {
    return this.farmers.uploadDocument(user, id, file, dto, ctx);
  }

  @Get(':id/documents')
  @RequirePermissions('farmers:read')
  @ApiOperation({ summary: 'List documents of a farmer' })
  listDocuments(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.farmers.listDocuments(user, id);
  }

  @Get(':id/documents/:docId/file')
  @RequirePermissions('farmers:read')
  @ApiOperation({ summary: 'Download a document (access is audited as SENSITIVE_DOCUMENT_ACCESSED)' })
  async documentFile(@Param('id') id: string, @Param('docId') docId: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const d = await this.farmers.documentFile(user, id, docId, ctx);
    return new StreamableFile(d.stream, { type: d.mimeType, length: d.sizeBytes });
  }
}
