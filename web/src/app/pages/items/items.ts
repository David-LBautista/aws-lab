import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Item, ItemsService } from '../../services/items.service';

@Component({
  selector: 'app-items',
  imports: [FormsModule],
  templateUrl: './items.html',
})
export class Items implements OnInit {
  private api = inject(ItemsService);

  items = signal<Item[]>([]);
  name = signal('');
  error = signal('');

  ngOnInit() {
    this.load();
  }

  load() {
    this.api.list().subscribe({
      next: (items) => this.items.set(items),
      error: (e) => this.error.set(`No se pudo cargar: ${e.message}`),
    });
  }

  add() {
    const name = this.name().trim();
    if (!name) return;
    this.api.create(name).subscribe({
      next: (item) => {
        this.items.update((list) => [...list, item]);
        this.name.set('');
        this.error.set('');
      },
      error: (e) => this.error.set(e.error?.message ?? e.message),
    });
  }

  remove(id: number) {
    this.api.remove(id).subscribe(() =>
      this.items.update((list) => list.filter((i) => i.id !== id)),
    );
  }
}
