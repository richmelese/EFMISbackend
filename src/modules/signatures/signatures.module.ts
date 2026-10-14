import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Signature } from './entities/signature.entity';
import { User } from '../users/entities/user.entity';
import { SignaturesService } from './signatures.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Signature, User])],
  providers: [SignaturesService],
  exports: [SignaturesService]
})
export class SignaturesModule {}
