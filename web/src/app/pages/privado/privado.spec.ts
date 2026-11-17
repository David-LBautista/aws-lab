import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Privado } from './privado';

describe('Privado', () => {
  let component: Privado;
  let fixture: ComponentFixture<Privado>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Privado],
    }).compileComponents();

    fixture = TestBed.createComponent(Privado);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
