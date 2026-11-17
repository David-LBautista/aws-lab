import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Item } from './entities/item.entity.js';
import { CreateItemDto } from './dto/create-item.dto.js';

@Injectable()
export class ItemsService {
  constructor(@InjectRepository(Item) private readonly repo: Repository<Item>) {}

  findAll() {
    return this.repo.find({ order: { id: 'ASC' } });
  }

  create(dto: CreateItemDto) {
    return this.repo.save(this.repo.create(dto));
  }

  async remove(id: number) {
    const result = await this.repo.delete(id);
    if (!result.affected) throw new NotFoundException(`Item ${id} not found`);
  }
}