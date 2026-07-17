import { err, ok, type DomainResult } from '../../shared-kernel/result';
import { isValidDateOnly, type DateOnly, type Instant } from '../../shared-kernel/time';
import {
  deriveDiagnostic,
  diagnosticQuestions,
  type DeriveDiagnosticInput,
  type DeriveDiagnosticResult,
  type DiagAnswerValue,
  type DiagAxisScore,
  type DiagnosticAnswers,
  type DiagQuestionId,
} from './derive-diagnostic';

/**
 * À incrémenter dès qu'une règle, une pondération ou une source change le résultat persistant.
 * L'empreinte inclut cette version : une mise à jour de règles rend l'ancien résultat explicitement
 * obsolète au lieu de le présenter comme encore calculé par le moteur courant.
 */
export const DIAGNOSTIC_ASSESSMENT_RULESET_VERSION = 1;

export type PersistedDiagnosticAnswers = Readonly<{
  platform: DiagAnswerValue;
  accountant: DiagAnswerValue;
  offAppSales?: DiagAnswerValue;
}>;

export interface DiagnosticAssessmentRecord {
  readonly companyId: string;
  readonly revision: number;
  readonly answers: PersistedDiagnosticAnswers;
  readonly score: number;
  readonly axes: readonly [DiagAxisScore, DiagAxisScore, DiagAxisScore];
  readonly sourceFingerprint: string;
  readonly rulesetVersion: number;
  readonly sourceAsOf: DateOnly;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface DiagnosticAssessmentSaveInput {
  readonly companyId: string;
  /** 0 crée la première ligne ; n>0 met à jour exactement la révision n. */
  readonly expectedRevision: number;
  readonly answers: PersistedDiagnosticAnswers;
  readonly score: number;
  readonly axes: readonly [DiagAxisScore, DiagAxisScore, DiagAxisScore];
  readonly sourceFingerprint: string;
  readonly rulesetVersion: number;
  readonly sourceAsOf: DateOnly;
}

export type DiagnosticAssessmentSaveResult =
  | { readonly status: 'created' | 'updated'; readonly assessment: DiagnosticAssessmentRecord }
  | { readonly status: 'revision_conflict'; readonly currentRevision: number | null };

export interface DiagnosticAssessmentRepository {
  findByCompanyId(companyId: string): Promise<DiagnosticAssessmentRecord | null>;
  save(input: DiagnosticAssessmentSaveInput): Promise<DiagnosticAssessmentSaveResult>;
}

export interface DiagnosticAssessmentSource {
  readonly companyId: string;
  readonly fingerprint: string;
  readonly asOf: DateOnly;
  readonly input: Omit<DeriveDiagnosticInput, 'answers'>;
}

export interface DiagnosticAssessmentClientRecord {
  readonly revision: number;
  readonly answers: PersistedDiagnosticAnswers;
  readonly score: number;
  readonly axes: readonly [DiagAxisScore, DiagAxisScore, DiagAxisScore];
  readonly sourceFingerprint: string;
  readonly rulesetVersion: number;
  readonly sourceAsOf: DateOnly;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export type DiagnosticAssessmentStaleReason =
  | 'source_changed'
  | 'ruleset_changed'
  | 'derived_result_mismatch';

/**
 * `result` n'existe que si sa preuve source est encore courante. Un résultat absent n'est donc
 * jamais ramené à score=0 : `never_run` et `stale` sont des états métier distincts.
 */
export type DiagnosticAssessmentView =
  | {
      readonly status: 'never_run';
      readonly currentSourceFingerprint: string;
      readonly currentSourceAsOf: DateOnly;
      readonly rulesetVersion: number;
      readonly questions: readonly DiagQuestionId[];
      readonly saved: null;
      readonly result: null;
      readonly staleReason: null;
    }
  | {
      readonly status: 'current';
      readonly currentSourceFingerprint: string;
      readonly currentSourceAsOf: DateOnly;
      readonly rulesetVersion: number;
      readonly questions: readonly DiagQuestionId[];
      readonly saved: DiagnosticAssessmentClientRecord;
      readonly result: DeriveDiagnosticResult;
      readonly staleReason: null;
    }
  | {
      readonly status: 'stale';
      readonly currentSourceFingerprint: string;
      readonly currentSourceAsOf: DateOnly;
      readonly rulesetVersion: number;
      readonly questions: readonly DiagQuestionId[];
      readonly saved: DiagnosticAssessmentClientRecord;
      readonly result: null;
      readonly staleReason: DiagnosticAssessmentStaleReason;
    };

export interface DiagnosticAssessmentWriteRequest {
  readonly expectedRevision: number;
  readonly expectedSourceFingerprint: string;
  readonly answers: PersistedDiagnosticAnswers;
}

const ANSWER_VALUES: readonly DiagAnswerValue[] = ['yes', 'no', 'unknown'];
const ANSWER_FIELDS: readonly DiagQuestionId[] = ['platform', 'offAppSales', 'accountant'];
const WRITE_FIELDS = ['expectedRevision', 'expectedSourceFingerprint', 'answers'] as const;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validation(field: string, message: string) {
  return err({ code: 'VALIDATION' as const, field, message });
}

function validAnswer(value: unknown): value is DiagAnswerValue {
  return typeof value === 'string' && ANSWER_VALUES.includes(value as DiagAnswerValue);
}

/** Validation canonique des seules réponses réellement posées pour le dossier courant. */
export function validateDiagnosticAssessmentAnswers(
  value: unknown,
  questions: readonly DiagQuestionId[],
): DomainResult<PersistedDiagnosticAnswers> {
  if (!record(value)) return validation('answers', 'Réponses du diagnostic invalides.');
  const expected = new Set<DiagQuestionId>(questions);
  const unexpected = Object.keys(value).find(
    (field) => !ANSWER_FIELDS.includes(field as DiagQuestionId) || !expected.has(field as DiagQuestionId),
  );
  if (unexpected !== undefined) {
    return validation(`answers.${unexpected}`, 'Réponse inconnue ou non applicable au dossier courant.');
  }
  for (const question of questions) {
    if (!validAnswer(value[question])) {
      return validation(`answers.${question}`, 'Réponse requise : yes, no ou unknown.');
    }
  }
  if (!expected.has('platform') || !expected.has('accountant')) {
    return validation('questions', 'Contrat de questions du diagnostic incomplet.');
  }
  return ok({
    platform: value.platform as DiagAnswerValue,
    accountant: value.accountant as DiagAnswerValue,
    ...(expected.has('offAppSales')
      ? { offAppSales: value.offAppSales as DiagAnswerValue }
      : {}),
  });
}

/**
 * Frontière PUT stricte : toute tentative d'envoyer score/axes/companyId est rejetée. Le client
 * ne peut soumettre que ses réponses et les deux preuves d'optimistic concurrency.
 */
export function parseDiagnosticAssessmentWriteRequest(
  value: unknown,
  questions: readonly DiagQuestionId[],
): DomainResult<DiagnosticAssessmentWriteRequest> {
  if (!record(value)) return validation('body', 'Corps JSON objet requis.');
  const unknown = Object.keys(value).find(
    (field) => !WRITE_FIELDS.includes(field as (typeof WRITE_FIELDS)[number]),
  );
  if (unknown !== undefined) return validation(unknown, 'Champ non autorisé.');
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    return validation('expectedRevision', 'Révision entière positive ou nulle requise.');
  }
  if (
    typeof value.expectedSourceFingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(value.expectedSourceFingerprint)
  ) {
    return validation('expectedSourceFingerprint', 'Empreinte source SHA-256 invalide.');
  }
  const answers = validateDiagnosticAssessmentAnswers(value.answers, questions);
  if (!answers.ok) return answers;
  return ok({
    expectedRevision: value.expectedRevision as number,
    expectedSourceFingerprint: value.expectedSourceFingerprint,
    answers: answers.value,
  });
}

function validScore(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

function axesMatch(
  left: readonly DiagAxisScore[],
  right: readonly DiagAxisScore[],
): boolean {
  return left.length === 3
    && right.length === 3
    && left.every((axis, index) => {
      const other = right[index];
      return other !== undefined && axis.id === other.id && axis.score === other.score;
    });
}

function assertAxes(axes: readonly DiagAxisScore[]): void {
  const expected = ['reception', 'emission', 'donnees'] as const;
  if (
    axes.length !== expected.length
    || axes.some((axis, index) => axis.id !== expected[index] || !validScore(axis.score))
  ) {
    throw new Error('DIAGNOSTIC_ASSESSMENT_AXES_CORRUPT');
  }
}

/** Défense de réhydratation : une ligne PostgreSQL corrompue ne devient jamais une vue mobile. */
export function assertDiagnosticAssessmentRecord(value: DiagnosticAssessmentRecord): void {
  if (!value.companyId.trim()) throw new Error('DIAGNOSTIC_ASSESSMENT_COMPANY_CORRUPT');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error('DIAGNOSTIC_ASSESSMENT_REVISION_CORRUPT');
  }
  if (!validScore(value.score)) throw new Error('DIAGNOSTIC_ASSESSMENT_SCORE_CORRUPT');
  assertAxes(value.axes);
  if (!FINGERPRINT_PATTERN.test(value.sourceFingerprint)) {
    throw new Error('DIAGNOSTIC_ASSESSMENT_FINGERPRINT_CORRUPT');
  }
  if (!Number.isSafeInteger(value.rulesetVersion) || value.rulesetVersion < 1) {
    throw new Error('DIAGNOSTIC_ASSESSMENT_RULESET_CORRUPT');
  }
  if (!isValidDateOnly(value.sourceAsOf)) throw new Error('DIAGNOSTIC_ASSESSMENT_DATE_CORRUPT');
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('DIAGNOSTIC_ASSESSMENT_TIMESTAMPS_CORRUPT');
  }
  const persistedAnswers = validateDiagnosticAssessmentAnswers(value.answers, [
    'platform',
    ...(value.answers.offAppSales === undefined ? [] : (['offAppSales'] as const)),
    'accountant',
  ]);
  if (!persistedAnswers.ok) throw new Error('DIAGNOSTIC_ASSESSMENT_ANSWERS_CORRUPT');
}

function clientRecord(recordValue: DiagnosticAssessmentRecord): DiagnosticAssessmentClientRecord {
  return {
    revision: recordValue.revision,
    answers: { ...recordValue.answers },
    score: recordValue.score,
    axes: recordValue.axes.map((axis) => ({ ...axis })) as [DiagAxisScore, DiagAxisScore, DiagAxisScore],
    sourceFingerprint: recordValue.sourceFingerprint,
    rulesetVersion: recordValue.rulesetVersion,
    sourceAsOf: recordValue.sourceAsOf,
    createdAt: recordValue.createdAt,
    updatedAt: recordValue.updatedAt,
  };
}

/** Construit la vue de lecture en prouvant à nouveau le résultat avec le moteur courant. */
export function buildDiagnosticAssessmentView(
  source: DiagnosticAssessmentSource,
  saved: DiagnosticAssessmentRecord | null,
): DiagnosticAssessmentView {
  const questions = diagnosticQuestions(source.input);
  const common = {
    currentSourceFingerprint: source.fingerprint,
    currentSourceAsOf: source.asOf,
    rulesetVersion: DIAGNOSTIC_ASSESSMENT_RULESET_VERSION,
    questions,
  } as const;
  if (saved === null) {
    return { ...common, status: 'never_run', saved: null, result: null, staleReason: null };
  }
  assertDiagnosticAssessmentRecord(saved);
  const exposedSaved = clientRecord(saved);
  if (saved.rulesetVersion !== DIAGNOSTIC_ASSESSMENT_RULESET_VERSION) {
    return { ...common, status: 'stale', saved: exposedSaved, result: null, staleReason: 'ruleset_changed' };
  }
  if (saved.sourceFingerprint !== source.fingerprint) {
    return { ...common, status: 'stale', saved: exposedSaved, result: null, staleReason: 'source_changed' };
  }
  const result = deriveDiagnostic({ ...source.input, answers: saved.answers });
  if (result.score !== saved.score || !axesMatch(result.axes, saved.axes)) {
    return {
      ...common,
      status: 'stale',
      saved: exposedSaved,
      result: null,
      staleReason: 'derived_result_mismatch',
    };
  }
  return { ...common, status: 'current', saved: exposedSaved, result, staleReason: null };
}

/** Le serveur seul appelle cette fonction après avoir chargé les sources PostgreSQL. */
export function diagnosticAssessmentSaveInput(input: {
  readonly companyId: string;
  readonly expectedRevision: number;
  readonly source: DiagnosticAssessmentSource;
  readonly answers: PersistedDiagnosticAnswers;
}): DiagnosticAssessmentSaveInput {
  const result = deriveDiagnostic({ ...input.source.input, answers: input.answers });
  return {
    companyId: input.companyId,
    expectedRevision: input.expectedRevision,
    answers: { ...input.answers },
    score: result.score,
    axes: result.axes.map((axis) => ({ ...axis })) as [DiagAxisScore, DiagAxisScore, DiagAxisScore],
    sourceFingerprint: input.source.fingerprint,
    rulesetVersion: DIAGNOSTIC_ASSESSMENT_RULESET_VERSION,
    sourceAsOf: input.source.asOf,
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Matériau canonique AVANT SHA-256. L'ordre arbitraire des SELECT ne doit jamais rendre un
 * diagnostic obsolète ; seules les données qui participent effectivement aux règles sont incluses.
 */
export function canonicalDiagnosticSourceMaterial(input: {
  readonly companyId: string;
  readonly source: Omit<DeriveDiagnosticInput, 'answers'>;
}): string {
  const source = input.source;
  const receptionDeadline = source.facts.items.find((item) => item.id === 'einvoice-reception')?.dueDate ?? null;
  // Le jour civil n'est PAS une donnée métier du score. Seule la frontière qui change les poids
  // (avant/après l'échéance de réception) doit invalider un résultat. Les changements de statuts
  // réglementaires restent couverts séparément par `facts.items`.
  const temporalKey = receptionDeadline === null
    ? 'reception_deadline_unknown'
    : source.today < receptionDeadline
      ? 'before_reception'
      : 'after_reception';
  const material = {
    rulesetVersion: DIAGNOSTIC_ASSESSMENT_RULESET_VERSION,
    companyId: input.companyId,
    temporalKey,
    facts: {
      country: source.facts.country,
      supported: source.facts.supported,
      items: source.facts.items
        .map((item) => ({
          id: item.id,
          status: item.status,
          severity: item.severity,
          dueDate: item.dueDate ?? null,
        }))
        .sort((a, b) => compareText(a.id, b.id)),
      calendar: source.facts.calendar
        .map((item) => ({ date: item.date }))
        .sort((a, b) => compareText(a.date, b.date)),
    },
    customers: source.customers
      .map((customer) => ({ id: customer.id, type: customer.type, siren: customer.siren }))
      .sort((a, b) => compareText(a.id, b.id)),
    invoices: source.invoices
      .map((invoice) => ({
        id: invoice.id,
        customerId: invoice.customerId,
        kind: invoice.kind,
        status: invoice.status,
        ttcCents: invoice.ttcCents,
        lineCategories: [...invoice.lineCategories].sort(compareText),
      }))
      .sort((a, b) => compareText(a.id, b.id)),
    payments: source.payments
      .map((payment) => ({ invoiceId: payment.invoiceId, amountCents: payment.amountCents }))
      .sort((a, b) => compareText(a.invoiceId, b.invoiceId) || a.amountCents - b.amountCents),
    profile: { trade: source.profile.trade },
    companySize: source.companySize ?? null,
  };
  return JSON.stringify(material);
}

/** Projection étroite utile aux appels qui attendent encore le type historique DiagnosticAnswers. */
export function asDiagnosticAnswers(value: PersistedDiagnosticAnswers): DiagnosticAnswers {
  return { ...value };
}
