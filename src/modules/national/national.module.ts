import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FtwgActionItem, FtwgSession, FtwgVote } from './entities/ftwg.entities';
import { DemandDocument, DocumentSignature } from './entities/demand-document.entities';
import { User } from '../users/entities/user.entity';
import { NationalController } from './national.controller';
import { NationalService } from './national.service';

/** National validation & demand finalisation (REQ-1.3-001..005). Exports NationalService for the dashboard module. */
@Module({
  imports: [TypeOrmModule.forFeature([FtwgSession, FtwgVote, FtwgActionItem, DemandDocument, DocumentSignature, User])],
  controllers: [NationalController],
  providers: [NationalService],
  exports: [NationalService]
})
export class NationalModule {}
