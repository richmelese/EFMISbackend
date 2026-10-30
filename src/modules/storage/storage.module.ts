import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageRetention } from './entities/storage-retention.entity';
import { StorageService } from './storage.service';

/** File storage on MinIO (platform module, MINIO_STORAGE_PLAN.md). */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([StorageRetention])],
  providers: [StorageService],
  exports: [StorageService]
})
export class StorageModule {}
