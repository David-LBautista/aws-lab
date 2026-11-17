import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ItemsService } from './items.service.js';
import { CreateItemDto } from './dto/create-item.dto.js';

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  findAll() {
    return this.items.findAll();
  }

  @Post()
  create(@Body() dto: CreateItemDto) {
    return this.items.create(dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.items.remove(id);
  }
}