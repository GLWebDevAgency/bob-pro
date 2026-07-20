import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Company, Customer } from '@bob/core';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import { AppLogger, requestContext } from '../observability/logger';
import { DiagnosticAssessmentService } from './diagnostic-assessment.service';

function company(id: string) {
  const value = Company.of({
    id,
    name: `Société ${id}`,
    legalForm: 'EI',
    siren: id === 'company-a' ? '732829320' : '552100554',
    siret: id === 'company-a' ? '73282932000074' : '55210055400013',
    trade: 'autre',
    vatRegime: 'reel_normal',
    address: { line1: '1 rue Réelle', zip: '75001', city: 'Paris' },
  });
  if (!value.ok) throw new Error('invalid test company');
  return value.value;
}

function customer(id: string, companyId: string, type: 'b2b' | 'b2c') {
  const value = Customer.of({
    id,
    companyId,
    type,
    name: `Client ${id}`,
    ...(type === 'b2b' ? { siren: '111222333' } : {}),
    address: { line1: '2 rue Client', zip: '75002', city: 'Paris' },
  });
  if (!value.ok) throw new Error('invalid test customer');
  return value.value;
}

function asTenant<T>(companyId: string, operation: () => Promise<T>): Promise<T> {
  return requestContext.run({
    correlationId: 'diagnostic-test',
    principal: { userId: `owner-${companyId}`, companyId },
  }, operation);
}

describe('DiagnosticAssessmentService — autorité serveur', () => {
  let persistence: InMemoryPersistence;
  let service: DiagnosticAssessmentService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T10:00:00.000Z'));
    persistence = new InMemoryPersistence();
    await persistence.companies.save(company('company-a'));
    await persistence.companies.save(company('company-b'));
    await persistence.customers.save(customer('customer-a', 'company-a', 'b2b'));
    service = new DiagnosticAssessmentService(persistence, new AppLogger());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renvoie never_run sans fabriquer score, axes ou réponses', async () => {
    const result = await asTenant('company-a', () => service.getCurrent());
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'never_run', saved: null, result: null },
    });
  });

  it('rejette toute valeur dérivée envoyée par le client et ne persiste rien', async () => {
    const initial = await asTenant('company-a', () => service.getCurrent());
    if (!initial.ok) throw new Error('initial read failed');
    const result = await asTenant('company-a', () => service.saveCurrent({
      expectedRevision: 0,
      expectedSourceFingerprint: initial.value.currentSourceFingerprint,
      answers: { platform: 'yes', accountant: 'yes' },
      score: 100,
    }));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'domain', error: { field: 'score' } },
    });
    expect(await persistence.diagnosticAssessments.findByCompanyId('company-a')).toBeNull();
  });

  it('calcule et persiste le résultat côté serveur, puis applique le CAS', async () => {
    const initial = await asTenant('company-a', () => service.getCurrent());
    if (!initial.ok) throw new Error('initial read failed');
    const body = {
      expectedRevision: 0,
      expectedSourceFingerprint: initial.value.currentSourceFingerprint,
      answers: { platform: 'yes', accountant: 'no' },
    } as const;
    const saved = await asTenant('company-a', () => service.saveCurrent(body));
    expect(saved).toMatchObject({
      ok: true,
      value: {
        status: 'current',
        saved: { revision: 1, answers: body.answers },
        result: { score: expect.any(Number), axes: expect.any(Array) },
      },
    });
    const persisted = await persistence.diagnosticAssessments.findByCompanyId('company-a');
    expect(persisted).toMatchObject({
      revision: 1,
      score: saved.ok ? saved.value.result?.score : undefined,
      axes: saved.ok ? saved.value.result?.axes : undefined,
    });

    const replay = await asTenant('company-a', () => service.saveCurrent(body));
    expect(replay).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'diagnostic_assessment', reason: 'stale_revision' },
    });
  });

  it('refuse un questionnaire démarré sur une ancienne empreinte et marque un résultat existant stale', async () => {
    const initial = await asTenant('company-a', () => service.getCurrent());
    if (!initial.ok) throw new Error('initial read failed');
    const saved = await asTenant('company-a', () => service.saveCurrent({
      expectedRevision: 0,
      expectedSourceFingerprint: initial.value.currentSourceFingerprint,
      answers: { platform: 'yes', accountant: 'yes' },
    }));
    if (!saved.ok) throw new Error('save failed');

    await persistence.customers.save(customer('customer-b2c', 'company-a', 'b2c'));
    const stale = await asTenant('company-a', () => service.getCurrent());
    expect(stale).toMatchObject({
      ok: true,
      value: { status: 'stale', result: null, staleReason: 'source_changed' },
    });
    const rejected = await asTenant('company-a', () => service.saveCurrent({
      expectedRevision: 1,
      expectedSourceFingerprint: initial.value.currentSourceFingerprint,
      answers: { platform: 'yes', accountant: 'yes', offAppSales: 'no' },
    }));
    expect(rejected).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'diagnostic_assessment', reason: 'source_changed' },
    });
  });

  it('ne lit ni n’écrit jamais la ligne d’un autre tenant', async () => {
    const a = await asTenant('company-a', () => service.getCurrent());
    const b = await asTenant('company-b', () => service.getCurrent());
    if (!a.ok || !b.ok) throw new Error('read failed');
    await asTenant('company-a', () => service.saveCurrent({
      expectedRevision: 0,
      expectedSourceFingerprint: a.value.currentSourceFingerprint,
      answers: { platform: 'yes', accountant: 'no' },
    }));
    expect(await asTenant('company-b', () => service.getCurrent())).toMatchObject({
      ok: true,
      value: { status: 'never_run', saved: null },
    });
  });
});
