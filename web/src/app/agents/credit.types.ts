export type CheckStatus = 'pending' | 'pass' | 'warn' | 'fail';

export interface RiskCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface CreditState {
  applicationId: string;
  applicant: {
    name: string;
    monthlyIncome: number;
    monthlyDebts: number;
    employmentYears: number;
    creditScore?: number;
  };
  request: { amount: number; termMonths: number; purpose: string };
  checks: RiskCheck[];
  metrics: { annualRate?: number; monthlyPayment?: number; debtToIncome?: number };
  recommendation: {
    decision: 'approve' | 'reject';
    amount: number;
    termMonths: number;
    annualRate: number;
    conditions: string[];
    rationale: string;
  } | null;
  status: 'received' | 'analyzing' | 'pending_approval' | 'approved' | 'rejected' | 'manual_review';
}

export interface ApplicationInput {
  name: string;
  monthlyIncome: number;
  monthlyDebts: number;
  employmentYears: number;
  amount: number;
  termMonths: number;
  purpose?: string;
  simulatedScore?: number;
}
