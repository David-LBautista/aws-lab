// Dominio del agente de créditos: una solicitud que el agente analiza paso a paso
// y una recomendación que un analista humano aprueba, ajusta o rechaza.

export type CheckStatus = 'pending' | 'pass' | 'warn' | 'fail';

export interface RiskCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface Applicant {
  name: string;
  monthlyIncome: number; // MXN
  monthlyDebts: number; // MXN que ya paga cada mes
  employmentYears: number;
  creditScore?: number; // llega cuando el agente consulta el buró
}

export interface LoanRequest {
  amount: number; // MXN
  termMonths: number;
  purpose: string;
}

export interface CreditMetrics {
  annualRate?: number; // 0.24 = 24%
  monthlyPayment?: number;
  debtToIncome?: number; // (deudas + nuevo pago) / ingreso
}

export interface Recommendation {
  decision: 'approve' | 'reject';
  amount: number;
  termMonths: number;
  annualRate: number;
  conditions: string[];
  rationale: string;
}

export interface CreditState {
  applicationId: string;
  applicant: Applicant;
  request: LoanRequest;
  checks: RiskCheck[];
  metrics: CreditMetrics;
  recommendation: Recommendation | null;
  status: 'received' | 'analyzing' | 'pending_approval' | 'approved' | 'rejected' | 'manual_review';
}

export const sampleApplication = (): CreditState => ({
  applicationId: 'APP-2026-0042',
  applicant: { name: 'María López', monthlyIncome: 32000, monthlyDebts: 6500, employmentYears: 4 },
  request: { amount: 150000, termMonths: 24, purpose: 'Equipo para su negocio' },
  checks: [],
  metrics: {},
  recommendation: null,
  status: 'received',
});

// Lo que el analista captura en el formulario. Llega desde el navegador en RunAgentInput.state,
// así que NO se confía en él: se valida aquí antes de usarlo.
export interface ApplicationInput {
  name: string;
  monthlyIncome: number;
  monthlyDebts: number;
  employmentYears: number;
  amount: number;
  termMonths: number;
  purpose?: string;
  simulatedScore?: number; // solo para el demo: el "buró" devolverá este score
}

export type ParsedApplication =
  | { ok: true; state: CreditState; simulatedScore?: number }
  | { ok: false; errors: string[] };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseApplicationInput(raw: unknown): ParsedApplication {
  // Sin datos (por ejemplo, desde curl): usamos la solicitud de ejemplo.
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
    return { ok: true, state: sampleApplication() };
  }
  const i = raw as Partial<ApplicationInput>;
  const errors: string[] = [];

  if (typeof i.name !== 'string' || i.name.trim().length < 2 || i.name.length > 80)
    errors.push('El nombre debe tener entre 2 y 80 caracteres.');
  if (!isNum(i.monthlyIncome) || i.monthlyIncome <= 0 || i.monthlyIncome > 10_000_000)
    errors.push('El ingreso mensual debe ser mayor a 0.');
  if (!isNum(i.monthlyDebts) || i.monthlyDebts < 0) errors.push('Las deudas mensuales no pueden ser negativas.');
  if (!isNum(i.employmentYears) || i.employmentYears < 0 || i.employmentYears > 60)
    errors.push('La antigüedad laboral debe estar entre 0 y 60 años.');
  if (!isNum(i.amount) || i.amount < 5_000 || i.amount > 5_000_000)
    errors.push('El monto debe estar entre $5,000 y $5,000,000.');
  if (!isNum(i.termMonths) || !Number.isInteger(i.termMonths) || i.termMonths < 6 || i.termMonths > 60)
    errors.push('El plazo debe ser un número entero de 6 a 60 meses.');
  if (i.purpose !== undefined && (typeof i.purpose !== 'string' || i.purpose.length > 120))
    errors.push('El propósito no puede pasar de 120 caracteres.');
  if (i.simulatedScore !== undefined && (!isNum(i.simulatedScore) || i.simulatedScore < 300 || i.simulatedScore > 850))
    errors.push('El score simulado debe estar entre 300 y 850.');

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    simulatedScore: i.simulatedScore,
    state: {
      applicationId: `APP-${Date.now().toString().slice(-6)}`,
      applicant: {
        name: i.name!.trim(),
        monthlyIncome: i.monthlyIncome!,
        monthlyDebts: i.monthlyDebts!,
        employmentYears: i.employmentYears!,
      },
      request: { amount: i.amount!, termMonths: i.termMonths!, purpose: i.purpose?.trim() || 'Sin especificar' },
      checks: [],
      metrics: {},
      recommendation: null,
      status: 'received',
    },
  };
}

// "Buró de crédito" ficticio (herramienta de solo lectura).
// En el demo puedes forzar el score; si no, siempre responde 712.
export function getCreditReport(_applicationId: string, simulatedScore?: number) {
  const creditScore = simulatedScore ?? 712;
  return { creditScore, latePaymentsLast12m: creditScore < 650 ? 4 : 1, openAccounts: 3 };
}

export const MIN_SCORE = 600; // debajo de esto se recomienda rechazar

// Tasa según el score: mejor score, menor tasa.
export function rateForScore(score: number): number {
  if (score >= 750) return 0.18;
  if (score >= 680) return 0.24;
  return 0.32;
}

// Pago mensual de un préstamo con amortización francesa (pagos fijos).
export function monthlyPayment(amount: number, annualRate: number, termMonths: number): number {
  const r = annualRate / 12;
  return Math.round((amount * r) / (1 - Math.pow(1 + r, -termMonths)));
}

export function debtToIncome(applicant: Applicant, payment: number): number {
  return Math.round(((applicant.monthlyDebts + payment) / applicant.monthlyIncome) * 100) / 100;
}
