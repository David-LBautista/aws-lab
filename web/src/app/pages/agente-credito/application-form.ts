import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type { ApplicationInput } from '../../agents/credit.types';

const PRESETS: Record<string, ApplicationInput> = {
  directa: {
    name: 'Juan Pérez',
    monthlyIncome: 50000,
    monthlyDebts: 3000,
    employmentYears: 5,
    amount: 100000,
    termMonths: 24,
    purpose: 'Remodelación',
  },
  ajuste: {
    name: 'María López',
    monthlyIncome: 32000,
    monthlyDebts: 6500,
    employmentYears: 4,
    amount: 150000,
    termMonths: 24,
    purpose: 'Equipo para su negocio',
  },
  rechazo: {
    name: 'Ana Torres',
    monthlyIncome: 12000,
    monthlyDebts: 8000,
    employmentYears: 2,
    amount: 150000,
    termMonths: 24,
    purpose: 'Auto',
  },
};

@Component({
  selector: 'app-application-form',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form [formGroup]="form" (ngSubmit)="submit()" class="application-form" aria-label="Solicitud de crédito">
      <div class="form-heading">
        <div>
          <h2>Nueva solicitud</h2>
          <p>Completa los datos para iniciar el análisis.</p>
        </div>
        <div class="presets" aria-label="Cargar caso de ejemplo">
          <span>Casos de ejemplo</span>
          <button type="button" (click)="load('directa')">Aprobación directa</button>
          <button type="button" (click)="load('ajuste')">Ajuste de plazo</button>
          <button type="button" (click)="load('rechazo')">Rechazo</button>
        </div>
      </div>

      <div class="field-grid">
        <label>Nombre del solicitante
          <input formControlName="name" autocomplete="name" />
        </label>
        <label>Propósito del crédito
          <input formControlName="purpose" />
        </label>
        <label>Ingreso mensual (MXN)
          <input type="number" formControlName="monthlyIncome" min="1" max="10000000" />
        </label>
        <label>Deudas mensuales (MXN)
          <input type="number" formControlName="monthlyDebts" min="0" />
        </label>
        <label>Antigüedad laboral (años)
          <input type="number" formControlName="employmentYears" min="0" max="60" />
        </label>
        <label>Monto solicitado (MXN)
          <input type="number" formControlName="amount" min="5000" max="5000000" />
        </label>
        <label>Plazo (meses)
          <input type="number" formControlName="termMonths" min="6" max="60" step="1" />
        </label>
        <label>Score de buró (demo, opcional)
          <input type="number" formControlName="simulatedScore" min="300" max="850" placeholder="712" />
        </label>
      </div>

      @if (form.invalid && form.touched) {
        <p class="validation-message" role="alert">Revisa los campos: hay valores fuera de rango.</p>
      }

      <div class="form-footer">
        <p>Los datos se validan nuevamente en el servidor antes del análisis.</p>
        <button class="btn primary" type="submit" [disabled]="disabled() || form.invalid">
          Iniciar análisis
        </button>
      </div>
    </form>
  `,
  styleUrl: './application-form.scss',
})
export class ApplicationForm {
  readonly disabled = input(false);
  readonly start = output<ApplicationInput>();

  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: [PRESETS['ajuste'].name, [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    purpose: [PRESETS['ajuste'].purpose ?? '', [Validators.maxLength(120)]],
    monthlyIncome: [PRESETS['ajuste'].monthlyIncome, [Validators.required, Validators.min(1), Validators.max(10_000_000)]],
    monthlyDebts: [PRESETS['ajuste'].monthlyDebts, [Validators.required, Validators.min(0)]],
    employmentYears: [PRESETS['ajuste'].employmentYears, [Validators.required, Validators.min(0), Validators.max(60)]],
    amount: [PRESETS['ajuste'].amount, [Validators.required, Validators.min(5_000), Validators.max(5_000_000)]],
    termMonths: [
      PRESETS['ajuste'].termMonths,
      [Validators.required, Validators.min(6), Validators.max(60), Validators.pattern(/^\d+$/)],
    ],
    simulatedScore: [null as number | null, [Validators.min(300), Validators.max(850)]],
  });

  protected load(preset: keyof typeof PRESETS) {
    this.form.reset({
      ...PRESETS[preset],
      purpose: PRESETS[preset].purpose ?? '',
      simulatedScore: null,
    });
  }

  protected submit() {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { simulatedScore, ...application } = this.form.getRawValue();
    this.start.emit({
      ...application,
      ...(simulatedScore !== null ? { simulatedScore } : {}),
    });
  }
}
