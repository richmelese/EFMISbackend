import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxMessage } from './entities/outbox-message.entity';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxMessage])],
  providers: [OutboxService],
  exports: [OutboxService]
})
export class OutboxModule {}
