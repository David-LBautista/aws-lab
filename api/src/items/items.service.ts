import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Item } from './entities/item.entity.js';
import { CreateItemDto } from './dto/create-item.dto.js';

@Injectable()
export class ItemsService {
  constructor(@InjectRepository(Item) private readonly repo: Repository<Item>) {}

  findAll(ownerSub: string) {
    return this.repo.find({ where: { ownerSub }, order: { id: 'ASC' } });
  }

  create(dto: CreateItemDto, ownerSub: string) {
    return this.repo.save(this.repo.create({ ...dto, ownerSub }));
  }

  async remove(id: number, ownerSub: string) {
    const result = await this.repo.delete({ id, ownerSub });
    if (!result.affected) throw new NotFoundException(`Item ${id} not found`);
  }
}
