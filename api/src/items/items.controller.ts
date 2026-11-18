import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ItemsService } from './items.service.js';
import { CreateItemDto } from './dto/create-item.dto.js';
import { CognitoAuthGuard } from '../auth/cognito-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';

@Controller('items')
@UseGuards(CognitoAuthGuard)
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  findAll(@CurrentUser() user: { sub: string }) {
    return this.items.findAll(user.sub);
  }

  @Post()
  create(@Body() dto: CreateItemDto, @CurrentUser() user: { sub: string }) {
    return this.items.create(dto, user.sub);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: { sub: string }) {
    return this.items.remove(id, user.sub);
  }
}
