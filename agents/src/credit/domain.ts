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
  status: 'received' | 'analyzing' | 'pending_approval' | 'approved' | 'rejected';
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

// "Buró de crédito" ficticio (herramienta de solo lectura).
export function getCreditReport(_applicationId: string) {
  return { creditScore: 712, latePaymentsLast12m: 1, openAccounts: 3 };
}

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
