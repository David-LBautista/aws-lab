import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Item } from './entities/item.entity.js';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';
import { CognitoAuthGuard } from '../auth/cognito-auth.guard.js';

@Module({
  imports: [TypeOrmModule.forFeature([Item])],
  controllers: [ItemsController],
  providers: [ItemsService, CognitoAuthGuard],
})
export class ItemsModule {}
