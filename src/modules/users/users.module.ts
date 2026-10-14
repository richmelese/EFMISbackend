import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { PermissionEntity, RoleEntity, RolePermission } from './entities/role.entity';
import { UsersService } from './users.service';
import { RbacService } from './rbac.service';
import { RolesController, UsersController } from './users.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User, RoleEntity, PermissionEntity, RolePermission])],
  controllers: [UsersController, RolesController],
  providers: [UsersService, RbacService],
  exports: [UsersService, RbacService]
})
export class UsersModule {}
