import { describe, expect, it } from 'vitest';
import {
  MIN_SCORE,
  debtToIncome,
  getCreditReport,
  monthlyPayment,
  parseApplicationInput,
  rateForScore,
  sampleApplication,
  type ApplicationInput,
} from '../src/credit/domain.js';

const valid: ApplicationInput = {
  name: 'Juan Pérez',
  monthlyIncome: 50000,
  monthlyDebts: 3000,
  employmentYears: 5,
  amount: 100000,
  termMonths: 24,
  purpose: 'Remodelación',
};

describe('rateForScore', () => {
  it.each([
    [800, 0.18],
    [750, 0.18],
    [749, 0.24],
    [680, 0.24],
    [679, 0.32],
    [MIN_SCORE, 0.32],
  ])('score %i → tasa %f', (score, rate) => {
    expect(rateForScore(score)).toBe(rate);
  });
});

describe('monthlyPayment (amortización francesa)', () => {
  it('calcula el pago fijo redondeado', () => {
    expect(monthlyPayment(150000, 0.24, 24)).toBe(7931);
    expect(monthlyPayment(150000, 0.24, 36)).toBe(5885);
  });

  it('a mayor plazo, menor pago mensual', () => {
    expect(monthlyPayment(100000, 0.24, 48)).toBeLessThan(monthlyPayment(100000, 0.24, 24));
  });

  it('el total pagado es mayor que el monto (hay intereses)', () => {
    expect(monthlyPayment(100000, 0.18, 24) * 24).toBeGreaterThan(100000);
  });
});

describe('debtToIncome', () => {
  it('suma deudas actuales + nuevo pago y divide entre el ingreso', () => {
    const { applicant } = sampleApplication(); // 32,000 de ingreso y 6,500 de deudas
    expect(debtToIncome(applicant, 7931)).toBe(0.45);
    expect(debtToIncome(applicant, 5885)).toBe(0.39);
  });
});

describe('getCreditReport', () => {
  it('responde 712 por defecto', () => {
    expect(getCreditReport('APP-1').creditScore).toBe(712);
  });

  it('usa el score simulado y marca más atrasos si es bajo', () => {
    const report = getCreditReport('APP-1', 550);
    expect(report.creditScore).toBe(550);
    expect(report.latePaymentsLast12m).toBeGreaterThan(1);
  });
});

describe('parseApplicationInput', () => {
  it('sin datos usa la solicitud de ejemplo', () => {
    for (const raw of [undefined, null, {}]) {
      const result = parseApplicationInput(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.state.applicant.name).toBe('María López');
    }
  });

  it('acepta una solicitud válida y arma el estado inicial', () => {
    const result = parseApplicationInput({ ...valid, name: '  Juan Pérez  ', simulatedScore: 700 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.simulatedScore).toBe(700);
    expect(result.state.applicant.name).toBe('Juan Pérez'); // recorta espacios
    expect(result.state.request).toEqual({ amount: 100000, termMonths: 24, purpose: 'Remodelación' });
    expect(result.state.status).toBe('received');
    expect(result.state.checks).toEqual([]);
    expect(result.state.applicationId).toMatch(/^APP-\d{6}$/);
  });

  it('pone un propósito por defecto si no viene', () => {
    const { purpose: _omit, ...withoutPurpose } = valid;
    const result = parseApplicationInput(withoutPurpose);
    expect(result.ok && result.state.request.purpose).toBe('Sin especificar');
  });

  it.each<[string, Partial<ApplicationInput> | Record<string, unknown>, string]>([
    ['nombre muy corto', { name: 'J' }, 'nombre'],
    ['ingreso en cero', { monthlyIncome: 0 }, 'ingreso'],
    ['deudas negativas', { monthlyDebts: -1 }, 'deudas'],
    ['antigüedad fuera de rango', { employmentYears: 70 }, 'antigüedad'],
    ['monto muy bajo', { amount: 1000 }, 'monto'],
    ['plazo con decimales', { termMonths: 12.5 }, 'plazo'],
    ['plazo muy largo', { termMonths: 120 }, 'plazo'],
    ['score fuera de rango', { simulatedScore: 900 }, 'score'],
    ['número como texto', { amount: '100000' }, 'monto'],
  ])('rechaza %s', (_case, override, field) => {
    const result = parseApplicationInput({ ...valid, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ').toLowerCase()).toContain(field);
  });

  it('junta todos los errores, no solo el primero', () => {
    const result = parseApplicationInput({ ...valid, name: '', amount: 1, termMonths: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(3);
  });
});
