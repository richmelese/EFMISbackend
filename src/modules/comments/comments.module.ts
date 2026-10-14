import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Comment } from './entities/comment.entity';
import { User } from '../users/entities/user.entity';
import { CommentsService } from './comments.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Comment, User])],
  providers: [CommentsService],
  exports: [CommentsService]
})
export class CommentsModule {}
