import { Component, computed, inject } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';

@Component({
  selector: 'app-perfil',
  templateUrl: './perfil.html',
})
export class Perfil {
  private oidc = inject(OidcSecurityService);
  isAuthenticated = computed(() => this.oidc.authenticated().isAuthenticated);
  user = computed(() => this.oidc.userData().userData ?? {});
}
