import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

const API_URL = 'https://jfg2mp6sgj.execute-api.us-east-1.amazonaws.com';

interface Item {
  id: number;
  titulo: string;
  hecho: boolean;
}

interface ItemsResponse {
  usuario: string;
  items: Item[];
}

@Component({
  selector: 'app-privado',
  templateUrl: './privado.html',
})
export class Privado {
  private http = inject(HttpClient);

  data = signal<ItemsResponse | null>(null);
  error = signal<string | null>(null);
  loading = signal(true);

  constructor() {
    this.http.get<ItemsResponse>(`${API_URL}/items`).subscribe({
      next: (res) => {
        this.data.set(res);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(`Error ${err.status}: no se pudieron cargar los datos`);
        this.loading.set(false);
      },
    });
  }
}
