import { Body, Controller, Headers, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators';
import { Errors } from '../../common/utils/errors';
import { UssdRequestDto } from './dto/ussd.dto';
import { UssdService } from './ussd.service';

@ApiTags('USSD *804# (REQ-1.4-008)')
@Controller('ussd')
export class UssdController {
  constructor(private readonly svc: UssdService, private readonly config: ConfigService) {}

  @Post()
  @Public()
  @HttpCode(200)
  @ApiConsumes('application/json', 'application/x-www-form-urlencoded')
  @ApiHeader({ name: 'X-USSD-Key', required: false, description: 'Required when USSD_GATEWAY_KEY is configured' })
  @ApiOperation({ summary: 'USSD gateway (text/plain CON/END) or simulator ({ input } -> { screen, sessionEnded })' })
  async ussd(@Body() dto: UssdRequestDto, @Query('lang') qLang: string | undefined, @Headers('x-ussd-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response) {
    const expected = this.config.get<string>('integrations.ussdGatewayKey');
    if (expected && key !== expected) throw Errors.unauthorized('Invalid USSD gateway key');
    const lang = String(dto.lang || qLang || 'en').toLowerCase();
    if (dto.input === undefined) {
      const reply = await this.svc.gateway(dto.text, dto.phoneNumber, lang);
      res.type('text/plain');
      return reply;
    }
    return this.svc.simulator(dto.input, dto.sessionId, dto.phoneNumber, lang);
  }
}
