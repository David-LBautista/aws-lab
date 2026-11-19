import { TestBed } from '@angular/core/testing';
import { Perfil } from './perfil';
import { provideOidcMock } from '../../../testing/oidc-mock';

describe('Perfil', () => {
  async function setup() {
    await TestBed.configureTestingModule({
      imports: [Perfil],
      providers: [
        provideOidcMock({
          authenticated: true,
          userData: { email: 'test@example.com', sub: 'user-123' },
        }),
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(Perfil);
    await fixture.whenStable();
    return fixture;
  }

  it('should create', async () => {
    const fixture = await setup();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('shows the email of the logged-in user', async () => {
    const fixture = await setup();
    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('test@example.com');
  });
});
