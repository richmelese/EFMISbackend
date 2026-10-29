import { Controller, Get, Param, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { AuthUser } from '../../common/types/auth-user';
import { AdminUnitDetailDto, AdminUnitDto, AdminUnitTreeDto } from './dto/admin-unit.dto';
import { AdminUnitsService } from './admin-units.service';

/** Read-only unit tree for every signed-in user, limited to their own area. Editing units is Phase 1. */
@ApiTags('Admin units (REQ-1.7-001)')
@ApiBearerAuth()
@Controller('admin-units')
export class AdminUnitsController {
  constructor(private readonly units: AdminUnitsService) {}

  @Version('1')
  @Get('tree')
  @ApiOperation({ summary: "The user's unit subtree (the whole country for national roles)" })
  @ApiOkResponse({ type: AdminUnitTreeDto, isArray: true })
  tree(@CurrentUser() user: AuthUser): Promise<AdminUnitTreeDto[]> {
    return this.units.tree(user);
  }

  @Version('1')
  @Get(':id')
  @ApiOperation({ summary: 'One unit with its ancestors (inside or above the user unit)' })
  @ApiOkResponse({ type: AdminUnitDetailDto })
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<AdminUnitDetailDto> {
    return this.units.detail(user, id);
  }

  @Version('1')
  @Get(':id/children')
  @ApiOperation({ summary: 'Direct children of a unit inside the user unit' })
  @ApiOkResponse({ type: AdminUnitDto, isArray: true })
  children(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<AdminUnitDto[]> {
    return this.units.childrenFor(user, id);
  }
}
