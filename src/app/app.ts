import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected readonly title = signal('aws-lab');

  private oidc = inject(OidcSecurityService);

  // Signals que expone la librería
  isAuthenticated = computed(() => this.oidc.authenticated().isAuthenticated);
  email = computed(() => this.oidc.userData().userData?.email ?? '');

  ngOnInit() {
    this.oidc.checkAuth().subscribe();
  }

  login() {
    this.oidc.authorize();
  }

  logout() {
    this.oidc.logoffLocal();
    const back = encodeURIComponent(window.location.origin);
    window.location.href =
      `${environment.cognito.domain}/logout?client_id=${environment.cognito.clientId}&logout_uri=${back}`;
  }
}
