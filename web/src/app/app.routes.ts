import { Routes } from '@angular/router';
import { autoLoginPartialRoutesGuard } from 'angular-auth-oidc-client';
import { Home } from './pages/home/home';
import { Perfil } from './pages/perfil/perfil';
import { Privado } from './pages/privado/privado';

export const routes: Routes = [
  { path: '', component: Home },
  { path: 'perfil', component: Perfil },
  { path: 'privado', component: Privado, canActivate: [autoLoginPartialRoutesGuard] },
  { path: '**', redirectTo: '' },
];