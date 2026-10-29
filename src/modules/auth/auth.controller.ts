import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards, Version } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AllowPendingPasswordChange, CurrentUser, Public, ReqCtx } from '../../common/decorators';
import { ChangePasswordDto } from '../users/dto/user.dto';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { ChangePinDto, DemoLoginDto, LoginDto, OtpRequestDto, OtpVerifyDto, UpdateMeDto } from './dto/auth.dto';
import { RealtimeTicketDto } from './realtime-ticket';

@ApiTags('Auth (REQ-1.7-001)')
@Controller('auth')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly users: UsersService, private readonly config: ConfigService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email/phone + password login' })
  login(@Body() dto: LoginDto, @ReqCtx() ctx: RequestContext) {
    return this.auth.login(dto, ctx);
  }

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a 6-digit OTP for Fayda ID or phone login (devOtp returned in DEMO_MODE)' })
  requestOtp(@Body() dto: OtpRequestDto) {
    return this.auth.requestOtp(dto);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify OTP and sign in' })
  verifyOtp(@Body() dto: OtpVerifyDto, @ReqCtx() ctx: RequestContext) {
    return this.auth.verifyOtp(dto, ctx);
  }

  @Public()
  @Post('demo-login')
  @HttpCode(200)
  @Throttle({ default: { limit: 1000, ttl: 60_000 } })
  @ApiOperation({ summary: '1-click persona login by role (DEMO_MODE only)' })
  demoLogin(@Body() dto: DemoLoginDto, @ReqCtx() ctx: RequestContext) {
    return this.auth.demoLogin(dto.role, ctx);
  }

  @ApiBearerAuth()
  @Get('me')
  @AllowPendingPasswordChange()
  async me(@CurrentUser() user: AuthUser) {
    const role = await this.users.roleInfo(user.roleId || user.role);
    return { ...user, roleLevel: role?.level, sessionIdleMinutes: this.config.get('sessionIdleMinutes') };
  }

  @ApiBearerAuth()
  @Post('me/password')
  @HttpCode(200)
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: 'Change own password (required after a temporary password); signs out all sessions' })
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @ReqCtx() ctx: RequestContext) {
    return this.users.changeOwnPassword(user, dto, ctx);
  }

  @ApiBearerAuth()
  @Patch('me')
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    if (dto.preferredLanguage) await this.users.repo.update({ id: user.id }, { preferredLanguage: dto.preferredLanguage });
    return this.users.findActive(user.id);
  }

  @ApiBearerAuth()
  @Post('me/pin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change e-signature PIN' })
  changePin(@CurrentUser() user: AuthUser, @Body() dto: ChangePinDto, @ReqCtx() ctx: RequestContext) {
    return this.auth.changePin(user, dto, ctx);
  }

  @ApiBearerAuth()
  @Version('1')
  @Post('realtime-ticket')
  @HttpCode(200)
  @ApiOperation({ summary: 'Short-lived (60 s) ticket for opening the realtime socket; rejected by the REST API' })
  @ApiOkResponse({ type: RealtimeTicketDto })
  realtimeTicket(@CurrentUser() user: AuthUser): Promise<RealtimeTicketDto> {
    return this.auth.realtimeTicket(user);
  }

  @ApiBearerAuth()
  @Post('logout')
  @AllowPendingPasswordChange()
  @HttpCode(200)
  logout(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.auth.logout(user, ctx);
  }
}
