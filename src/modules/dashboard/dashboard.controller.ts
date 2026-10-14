import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '../../common/decorators';
import { AuthUser } from '../../common/types/auth-user';
import { DashboardService } from './dashboard.service';
import { CopilotAskDto } from './dto/copilot.dto';

@ApiTags('Dashboards (REQ-1.6-001)')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('meta')
  @Public()
  @ApiOperation({ summary: 'Public metadata: system metadata, roles, fertilizer types, languages' })
  meta() {
    return this.svc.meta();
  }

  @Get('bootstrap')
  @ApiOperation({ summary: 'Complete EFMIS_DATA object scoped to the caller (role / permissions / administrative area)' })
  bootstrap(@CurrentUser() user: AuthUser) {
    return this.svc.bootstrap(user);
  }

  @Get('dashboard/overview')
  @ApiOperation({ summary: 'Landing KPIs (HeroStats) and workflow pipeline' })
  overview() {
    return this.svc.overview();
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Role-based dashboard widgets' })
  dashboard(@CurrentUser() user: AuthUser) {
    return this.svc.dashboard(user);
  }

  @Post('copilot/ask')
  @HttpCode(200)
  @ApiOperation({ summary: 'EFMIS Copilot: rule-based answers from live data { reply, action, time }' })
  ask(@Body() dto: CopilotAskDto) {
    return this.svc.ask(dto);
  }
}
