import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { Farmer } from './entities/farmer.entity';
import { FarmerDemand } from './entities/farmer-demand.entity';
import { FarmerDocument } from './entities/farmer-document.entity';
import { FaydaVerification } from './entities/fayda-verification.entity';
import { FarmersService } from './farmers.service';
import { FarmersController } from './farmers.controller';
import { IdentityController } from './identity.controller';
import { RULES } from '../../common/constants/rules';
import { Errors } from '../../common/utils/errors';

@Module({
  imports: [
    TypeOrmModule.forFeature([Farmer, FarmerDemand, FarmerDocument, FaydaVerification]),
    // REQ-1.1-002 uploads: memory storage, size limit from config, JPEG/PNG/PDF only
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: memoryStorage(),
        limits: { fileSize: config.get<number>('maxUploadBytes'), files: 1 },
        fileFilter: (_req: unknown, file: { mimetype: string }, cb: (error: Error | null, accept: boolean) => void) =>
          RULES.uploadMimeTypes.includes(file.mimetype) ? cb(null, true) : cb(Errors.badRequest('Only JPEG, PNG or PDF files are accepted'), false)
      })
    })
  ],
  controllers: [FarmersController, IdentityController],
  providers: [FarmersService],
  exports: [FarmersService, TypeOrmModule]
})
export class FarmersModule {}
