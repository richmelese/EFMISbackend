import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobFailure } from './entities/job-failure.entity';
import { JobsService } from './jobs.service';
import { HotStateService } from './hot-state.service';
import { JobsController } from './jobs.controller';

/** Queue/worker abstraction + hot-state cache (Redis when configured). Global. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([JobFailure])],
  controllers: [JobsController],
  providers: [JobsService, HotStateService],
  exports: [JobsService, HotStateService]
})
export class JobsModule {}
