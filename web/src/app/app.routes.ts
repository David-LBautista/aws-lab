import { Routes } from '@angular/router';
import { autoLoginPartialRoutesGuard } from 'angular-auth-oidc-client';
import { Home } from './pages/home/home';
import { Perfil } from './pages/perfil/perfil';
import { Privado } from './pages/privado/privado';
import { Items } from './pages/items/items';

export const routes: Routes = [
  { path: '', component: Home },
  { path: 'perfil', component: Perfil },
  { path: 'privado', component: Privado, canActivate: [autoLoginPartialRoutesGuard] },
  {
    path: 'agente-credito',
    loadComponent: () =>
      import('./pages/agente-credito/agente-credito').then((m) => m.AgenteCredito),
    canActivate: [autoLoginPartialRoutesGuard],
  },
  { path: 'items', component: Items, canActivate: [autoLoginPartialRoutesGuard] },
  { path: '**', redirectTo: '' },
];
