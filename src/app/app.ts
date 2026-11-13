import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';

const COGNITO_DOMAIN = 'https://us-east-1e0svynkcw.auth.us-east-1.amazoncognito.com';
const CLIENT_ID = '5oj7qo4f1e3oapck7qvuc2af6r';

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
    window.location.href = `${COGNITO_DOMAIN}/logout?client_id=${CLIENT_ID}&logout_uri=${back}`;
  }
}
