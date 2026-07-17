import { describe, expect, it } from 'vitest';
import { runDiagnostic } from '../../domain/compliance/diagnostic';
import type { DeriveDiagnosticInput } from './derive-diagnostic';
import {
  DIAGNOSTIC_ASSESSMENT_RULESET_VERSION,
  buildDiagnosticAssessmentView,
  canonicalDiagnosticSourceMaterial,
  diagnosticAssessmentSaveInput,
  parseDiagnosticAssessmentWriteRequest,
  type DiagnosticAssessmentRecord,
  type DiagnosticAssessmentSource,
} from './diagnostic-assessment';

function input(overrides: Partial<Omit<DeriveDiagnosticInput, 'answers'>> = {}): Omit<DeriveDiagnosticInput, 'answers'> {
  const facts = runDiagnostic({
    country: 'FR',
    trade: 'plombier',
    vatRegime: 'reel_simpl',
    customerTypes: ['b2b'],
    hasDecennale: true,
    asOf: '2026-07-17',
    annualEncaissedCents: 120_000,
  });
  return {
    facts,
    customers: [{ id: 'customer-1', type: 'b2b', siren: '123456789' }],
    invoices: [{
      id: 'invoice-1',
      customerId: 'customer-1',
      kind: 'final',
      status: 'issued',
      ttcCents: 120_000,
      lineCategories: ['labor'],
    }],
    payments: [{ invoiceId: 'invoice-1', amountCents: 40_000 }],
    profile: { trade: 'plombier' },
    today: '2026-07-17',
    companySize: 'tpe_pme',
    ...overrides,
  };
}

function source(sourceInput = input()): DiagnosticAssessmentSource {
  return {
    companyId: 'company-1',
    fingerprint: 'a'.repeat(64),
    asOf: sourceInput.today,
    input: sourceInput,
  };
}

function saved(currentSource = source()): DiagnosticAssessmentRecord {
  const write = diagnosticAssessmentSaveInput({
    companyId: 'company-1',
    expectedRevision: 0,
    source: currentSource,
    answers: { platform: 'yes', accountant: 'no' },
  });
  return {
    companyId: write.companyId,
    revision: 1,
    answers: write.answers,
    score: write.score,
    axes: write.axes,
    sourceFingerprint: write.sourceFingerprint,
    rulesetVersion: write.rulesetVersion,
    sourceAsOf: write.sourceAsOf,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

describe('diagnostic assessment — contrat persistant', () => {
  it('distingue une absence de diagnostic d’un score nul', () => {
    expect(buildDiagnosticAssessmentView(source(), null)).toEqual(expect.objectContaining({
      status: 'never_run',
      saved: null,
      result: null,
    }));
  });

  it('rejette les scores/axes client et exige exactement les réponses adaptatives', () => {
    const fingerprint = 'b'.repeat(64);
    expect(parseDiagnosticAssessmentWriteRequest({
      expectedRevision: 0,
      expectedSourceFingerprint: fingerprint,
      answers: { platform: 'yes', accountant: 'no' },
      score: 100,
    }, ['platform', 'accountant'])).toMatchObject({
      ok: false,
      error: { field: 'score' },
    });
    expect(parseDiagnosticAssessmentWriteRequest({
      expectedRevision: 0,
      expectedSourceFingerprint: fingerprint,
      answers: { platform: 'yes', accountant: 'no' },
    }, ['platform', 'offAppSales', 'accountant'])).toMatchObject({
      ok: false,
      error: { field: 'answers.offAppSales' },
    });
    expect(parseDiagnosticAssessmentWriteRequest({
      expectedRevision: 0,
      expectedSourceFingerprint: fingerprint,
      answers: { platform: 'yes', accountant: 'unknown' },
    }, ['platform', 'accountant'])).toEqual({
      ok: true,
      value: {
        expectedRevision: 0,
        expectedSourceFingerprint: fingerprint,
        answers: { platform: 'yes', accountant: 'unknown' },
      },
    });
  });

  it('ne rend le résultat que si empreinte, règles et dérivation serveur concordent', () => {
    const current = source();
    const record = saved(current);
    expect(buildDiagnosticAssessmentView(current, record)).toMatchObject({
      status: 'current',
      result: { score: record.score, axes: record.axes },
      staleReason: null,
    });
    expect(buildDiagnosticAssessmentView(
      { ...current, fingerprint: 'c'.repeat(64) },
      record,
    )).toMatchObject({ status: 'stale', result: null, staleReason: 'source_changed' });
    expect(buildDiagnosticAssessmentView(current, {
      ...record,
      rulesetVersion: DIAGNOSTIC_ASSESSMENT_RULESET_VERSION + 1,
    })).toMatchObject({ status: 'stale', staleReason: 'ruleset_changed' });
    expect(buildDiagnosticAssessmentView(current, { ...record, score: record.score - 1 })).toMatchObject({
      status: 'stale',
      staleReason: 'derived_result_mismatch',
    });
  });

  it('produit un matériau canonique stable malgré l’ordre SQL, mais sensible aux vraies données', () => {
    const a = input({
      customers: [
        { id: 'customer-2', type: 'b2g', siren: '987654321' },
        { id: 'customer-1', type: 'b2b', siren: '123456789' },
      ],
      invoices: [
        {
          id: 'invoice-2',
          customerId: 'customer-2',
          kind: 'final',
          status: 'paid',
          ttcCents: 90_000,
          lineCategories: ['supply', 'labor'],
        },
        {
          id: 'invoice-1',
          customerId: 'customer-1',
          kind: 'final',
          status: 'issued',
          ttcCents: 120_000,
          lineCategories: ['labor'],
        },
      ],
      payments: [
        { invoiceId: 'invoice-2', amountCents: 90_000 },
        { invoiceId: 'invoice-1', amountCents: 40_000 },
      ],
    });
    const b = {
      ...a,
      facts: {
        ...a.facts,
        items: [...a.facts.items].reverse(),
        calendar: [...a.facts.calendar].reverse(),
      },
      customers: [...a.customers].reverse(),
      invoices: [...a.invoices].reverse().map((invoice) => ({
        ...invoice,
        lineCategories: [...invoice.lineCategories].reverse(),
      })),
      payments: [...a.payments].reverse(),
    };
    expect(canonicalDiagnosticSourceMaterial({ companyId: 'company-1', source: a }))
      .toBe(canonicalDiagnosticSourceMaterial({ companyId: 'company-1', source: b }));
    expect(canonicalDiagnosticSourceMaterial({ companyId: 'company-1', source: a }))
      .not.toBe(canonicalDiagnosticSourceMaterial({
        companyId: 'company-1',
        source: { ...a, payments: [{ invoiceId: 'invoice-1', amountCents: 40_001 }] },
      }));
  });

  it('n’invalide pas chaque jour : seule une vraie frontière temporelle modifie l’empreinte', () => {
    const afterDeadline = input({ today: '2026-09-02' });
    expect(canonicalDiagnosticSourceMaterial({ companyId: 'company-1', source: afterDeadline }))
      .toBe(canonicalDiagnosticSourceMaterial({
        companyId: 'company-1',
        source: { ...afterDeadline, today: '2027-01-15' },
      }));
    expect(canonicalDiagnosticSourceMaterial({ companyId: 'company-1', source: afterDeadline }))
      .not.toBe(canonicalDiagnosticSourceMaterial({
        companyId: 'company-1',
        source: { ...afterDeadline, today: '2026-08-31' },
      }));
  });
});
