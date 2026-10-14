import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { CreateUserDto, ListUsersQueryDto, ReasonDto, ResetPasswordDto, UpdateUserDto } from './dto/user.dto';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { UsersService } from './users.service';
import { RbacService } from './rbac.service';

@ApiTags('Users (REQ-1.7-001)')
@ApiBearerAuth()
@Controller('users')
@RequirePermissions('users:manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Search users (q, role, active, regionId) with pagination' })
  list(@Query() q: ListUsersQueryDto) {
    return this.users.list(q);
  }

  @Post()
  @ApiOperation({ summary: 'Create a user: role + validated scope; temporary password generated (shown once) unless given' })
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.users.create(dto, user, ctx);
  }

  @Get(':id')
  @ApiOperation({ summary: 'User detail with effective permissions' })
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit profile, role or scope (audited old/new)' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.users.update(id, dto, user, ctx);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Deactivate (reason required); signs the user out everywhere' })
  deactivate(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.users.deactivate(id, dto.reason, user, ctx);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reactivate a deactivated user' })
  reactivate(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.users.reactivate(id, user, ctx);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a temporary password (must change at next sign-in); revokes all sessions' })
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.users.resetPassword(id, dto, user, ctx);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign the user out on every device' })
  revokeSessions(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.users.revokeSessions(id, user, ctx);
  }

  @Get(':id/audit')
  @ApiOperation({ summary: 'Changes made to this user and their security events' })
  audit(@Param('id') id: string) {
    return this.users.userAudit(id);
  }
}

@ApiTags('Roles & permissions (REQ-1.7-001)')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly rbac: RbacService) {}

  @Get('permissions')
  @RequirePermissions('roles:manage', 'users:manage')
  @ApiOperation({ summary: 'Permission catalogue (grouped, with descriptions)' })
  permissions() {
    return this.rbac.listPermissions();
  }

  @Get('roles')
  @RequirePermissions('roles:manage', 'users:manage')
  @ApiOperation({ summary: 'Roles with their permissions and user counts' })
  roles() {
    return this.rbac.listRoles();
  }

  @Get('roles/:id')
  @RequirePermissions('roles:manage', 'users:manage')
  @ApiOperation({ summary: 'Role detail' })
  role(@Param('id') id: string) {
    return this.rbac.getRole(id);
  }

  @Post('roles')
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Create a custom role based on a system role (data scope) with its own permission set' })
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.rbac.createRole(user, dto, ctx);
  }

  @Patch('roles/:id')
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Rename / (de)activate a role or replace its permission set (audited: added/removed)' })
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.rbac.updateRole(user, id, dto, ctx);
  }

  @Delete('roles/:id')
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Delete an unused custom role' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.rbac.deleteRole(user, id, ctx);
  }
}
