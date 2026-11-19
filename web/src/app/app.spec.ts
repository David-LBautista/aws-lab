import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { provideOidcMock } from '../testing/oidc-mock';

describe('App', () => {
  async function setup(authenticated: boolean) {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideOidcMock({ authenticated })],
    }).compileComponents();

    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture;
  }

  it('should create the app', async () => {
    const fixture = await setup(false);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('shows the logout button when there is a session', async () => {
    const fixture = await setup(true);
    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Cerrar sesión');
    expect(text).not.toContain('Iniciar sesión');
  });
});