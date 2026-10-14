import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RevokedToken } from '../../auth/entities/revoked-token.entity';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/** Socket.IO gateway (/realtime) + publisher used by every logistics module. Global. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([RevokedToken])],
  providers: [RealtimeService, RealtimeGateway],
  exports: [RealtimeService]
})
export class RealtimeModule {}
