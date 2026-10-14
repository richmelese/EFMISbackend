import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import * as fs from 'fs';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { DocumentVerificationDto, DOCUMENT_TYPES, UploadDriverDocumentDto } from './dto/driver.dto';
import { DriverDocumentsService, UploadedDriverFile } from './driver-documents.service';

@ApiTags('Logistics — Driver documents')
@ApiBearerAuth()
@Controller({ version: '1' })
export class DriverDocumentsController {
  constructor(private readonly docs: DriverDocumentsService) {}

  @Post('drivers/:id/documents')
  @RequirePermissions('drivers:manage')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'documentType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        documentType: { type: 'string', enum: [...DOCUMENT_TYPES] },
        issuedAt: { type: 'string', example: '2024-01-31' },
        expiresAt: { type: 'string', example: '2028-01-31' }
      }
    }
  })
  @ApiOperation({ summary: 'Upload a driver document (JPEG/PNG/PDF, private storage, sha256 duplicate check)' })
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedDriverFile | undefined,
    @Body() dto: UploadDriverDocumentDto,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext
  ) {
    return this.docs.upload(user, id, file, dto, ctx);
  }

  @Get('drivers/:id/documents')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Driver documents (metadata only)' })
  list(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.docs.list(user, id);
  }

  @Get('driver-documents/:id/file')
  @RequirePermissions('drivers:sensitive')
  @ApiOperation({ summary: 'Download a driver document (restricted; access is audited)' })
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response
  ) {
    const f = await this.docs.file(user, id, ctx);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(fs.createReadStream(f.path), {
      type: f.mimeType,
      length: f.sizeBytes,
      disposition: `attachment; filename="${encodeURIComponent(f.fileName)}"`
    });
  }

  @Patch('driver-documents/:id/verification')
  @RequirePermissions('drivers:verify')
  @ApiOperation({ summary: 'Verify or reject a driver document (reason required for REJECTED)' })
  verification(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DocumentVerificationDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.docs.setVerification(user, id, dto, ctx);
  }
}
