// Dominio del laboratorio: un borrador de "motion" (escrito legal) que el agente
// investiga, redacta por secciones y somete a aprobación humana antes de "presentarlo".

export type SectionStatus = 'drafting' | 'done' | 'needs_revision' | 'approved';

export interface DraftSection {
  id: string;
  title: string;
  content: string;
  status: SectionStatus;
}

export interface DraftState {
  caseTitle: string;
  motionType: string;
  sections: DraftSection[];
  citations: Citation[];
  filingStatus: 'not_started' | 'drafting' | 'pending_approval' | 'approved' | 'rejected';
}

export interface Citation {
  id: string;
  case: string;
  year: number;
  holding: string;
}

export const initialDraft = (caseTitle = 'Smith v. Acme Corp.'): DraftState => ({
  caseTitle,
  motionType: 'Motion to Dismiss',
  sections: [],
  citations: [],
  filingStatus: 'not_started',
});

// Base de datos ficticia de precedentes (para no depender de servicios externos).
const CASE_LAW: Citation[] = [
  {
    id: 'twombly',
    case: 'Bell Atlantic Corp. v. Twombly',
    year: 2007,
    holding: 'A complaint must plead enough facts to state a claim that is plausible on its face.',
  },
  {
    id: 'iqbal',
    case: 'Ashcroft v. Iqbal',
    year: 2009,
    holding: 'Threadbare recitals of the elements of a cause of action do not suffice.',
  },
  {
    id: 'conley',
    case: 'Conley v. Gibson',
    year: 1957,
    holding: 'Earlier "no set of facts" standard, retired by Twombly.',
  },
];

// Herramienta de solo lectura: el agente puede usarla libremente.
export function searchCaseLaw(query: string): Citation[] {
  const q = query.toLowerCase();
  const hits = CASE_LAW.filter(
    (c) => c.case.toLowerCase().includes(q) || c.holding.toLowerCase().includes(q),
  );
  // Si la búsqueda es muy general, devolvemos los dos precedentes clave.
  return hits.length > 0 ? hits : CASE_LAW.slice(0, 2);
}
