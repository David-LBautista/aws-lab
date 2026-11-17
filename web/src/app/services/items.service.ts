import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface Item {
  id: number;
  name: string;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class ItemsService {
  private http = inject(HttpClient);
  private url = `${environment.itemsApiUrl}/items`;

  list() {
    return this.http.get<Item[]>(this.url);
  }

  create(name: string) {
    return this.http.post<Item>(this.url, { name });
  }

  remove(id: number) {
    return this.http.delete<void>(`${this.url}/${id}`);
  }
}
