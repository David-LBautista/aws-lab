import { Provider, signal } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { of } from 'rxjs';

interface OidcMockOptions {
  authenticated?: boolean;
  userData?: Record<string, unknown> | null;
}

/** Fake OidcSecurityService for unit tests: no Cognito, no redirects. */
export function provideOidcMock(options: OidcMockOptions = {}): Provider {
  const isAuthenticated = options.authenticated ?? false;
  const userData = options.userData ?? null;

  return {
    provide: OidcSecurityService,
    useValue: {
      checkAuth: () =>
        of({ isAuthenticated, userData, accessToken: '', idToken: '', configId: '' }),
      authenticated: signal({ isAuthenticated, allConfigsAuthenticated: [] }),
      userData: signal({ userData, allUserData: [] }),
      authorize: () => {},
      logoff: () => of(null),
      logoffAndRevokeTokens: () => of(null),
      logoffLocal: () => {},
      getAccessToken: () => of(''),
      getIdToken: () => of(''),
      getPayloadFromIdToken: () => of(userData ?? {}),
    },
  };
}
