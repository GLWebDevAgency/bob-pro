import { afterEach, describe, expect, it, vi } from 'vitest';
import { Company, Customer, Payment, runDiagnostic } from '@bob/core';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import { AppLogger, requestContext } from '../observability/logger';
import { DiagnosticAssessmentService } from './diagnostic-assessment.service';

/**
 * Année MÉTIER Paris du diagnostic persistant (bug de la nuit du Nouvel An) : la borne (asOf =
 * parisDateOnly) ET le jour des encaissements (businessDayOf) doivent vivre sur le même
 * calendrier. Le résultat public du service ne restitue `annualEncaissedCents` qu'à travers
 * l'empreinte SHA-256 de la source (opaque) : l'observation honnête est la FRONTIÈRE
 * `runDiagnostic` (@bob/core) — espionnée en CALL-THROUGH (le vrai moteur s'exécute, on ne
 * fabrique rien), dans un fichier dédié pour ne pas contaminer le graphe de modules des autres
 * tests du service.
 */
vi.mock('@bob/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bob/core')>();
  return { ...actual, runDiagnostic: vi.fn(actual.runDiagnostic) };
});

function franchiseCompany(id: string) {
  const value = Company.of({
    id,
    name: `Société ${id}`,
    legalForm: 'EI',
    siren: '732829320',
    siret: '73282932000074',
    trade: 'plombier',
    vatRegime: 'franchise',
    address: { line1: '1 rue Réelle', zip: '75001', city: 'Paris' },
  });
  if (!value.ok) throw new Error('fixture: société franchise invalide');
  return value.value;
}

function b2cCustomer(id: string, companyId: string) {
  const value = Customer.of({
    id,
    companyId,
    type: 'b2c',
    name: `Client ${id}`,
    address: { line1: '2 rue Client', zip: '75002', city: 'Paris' },
  });
  if (!value.ok) throw new Error('fixture: client invalide');
  return value.value;
}

function paymentAt(companyId: string, receivedAt: string, amount: number) {
  const value = Payment.record({
    id: `pay-${receivedAt}`,
    companyId,
    invoiceId: 'inv-1',
    amount,
    method: 'transfer',
    receivedAt,
  });
  if (!value.ok) throw new Error('fixture: paiement invalide');
  return value.value;
}

function asTenant<T>(companyId: string, operation: () => Promise<T>): Promise<T> {
  return requestContext.run(
    {
      correlationId: 'diagnostic-jour-metier-test',
      principal: { userId: `owner-${companyId}`, companyId },
    },
    operation,
  );
}

/** Gèle l'horloge, seed un tenant franchise + UN encaissement daté, lit l'entrée runDiagnostic. */
async function capturedDiagnosticInput(frozenAt: string, receivedAt: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(frozenAt));
  const persistence = new InMemoryPersistence();
  const companyId = 'company-franchise-jm';
  await persistence.companies.save(franchiseCompany(companyId));
  await persistence.customers.save(b2cCustomer('customer-jm', companyId));
  await persistence.payments.save(paymentAt(companyId, receivedAt, 4_000_000)); // 40 000 €
  const service = new DiagnosticAssessmentService(persistence, new AppLogger());
  const current = await asTenant(companyId, () => service.getCurrent());
  expect(current.ok).toBe(true);
  const call = vi.mocked(runDiagnostic).mock.calls.at(-1)?.[0];
  if (call === undefined) throw new Error('runDiagnostic non appelé');
  return { current, input: call };
}

describe('DiagnosticAssessmentService — année MÉTIER Paris des encaissements (293 B, Nouvel An)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(runDiagnostic).mockClear();
  });

  it("encaissé le 31/12 23:30 UTC = 1er janvier 00:30 Paris (CET +1) : compté dans l'année MÉTIER 2027", async () => {
    // Horloge gelée à 2026-12-31T23:30Z : asOf = parisDateOnly() = 2027-01-01 → année '2027'.
    // Le paiement (même instant) a pour jour métier 2027-01-01 → année '2027' : les 40 000 €
    // sont dans l'assiette de l'année SURVEILLÉE. La troncature UTC (année '2026' ≠ '2027')
    // rendait 0 — et le diagnostic PERSISTANT figeait cette valeur fausse dans son empreinte.
    const { current, input } = await capturedDiagnosticInput(
      '2026-12-31T23:30:00.000Z',
      '2026-12-31T23:30:00.000Z',
    );
    expect(input.asOf).toBe('2027-01-01');
    expect(input.annualEncaissedCents).toBe(4_000_000);
    // La borne est aussi publiée telle quelle par la vue (source du contrat d'obsolescence).
    if (current.ok) expect(current.value.currentSourceAsOf).toBe('2027-01-01');
  });

  it("TÉMOIN DST : encaissé le 31/12 22:30 UTC = 23:30 Paris (CET +1, pas +2) : encore l'année 2026", async () => {
    // 22:30Z + 1 h = 23:30 le 31/12 : asOf = 2026-12-31 → année '2026', et le jour métier du
    // paiement est ENCORE 2026-12-31 → compté (4 000 000 c). Un calcul DST-naïf à offset d'été
    // figé (+2 h toute l'année) projetterait le paiement au 01/01/2027 (année '2027' ≠ '2026')
    // → 0. Le cas 23:30Z ci-dessus ne discrimine pas (+1 et +2 donnent tous deux le 01/01) :
    // ce littéral-ci est le témoin qui tue ce mutant.
    const { input } = await capturedDiagnosticInput(
      '2026-12-31T22:30:00.000Z',
      '2026-12-31T22:30:00.000Z',
    );
    expect(input.asOf).toBe('2026-12-31');
    expect(input.annualEncaissedCents).toBe(4_000_000);
  });

  it('non-régression pleine journée : encaissé le 10/06 09:00 UTC = 11:00 Paris → compté dans son année', async () => {
    // Loin de minuit, année UTC et année Paris coïncident — le correctif ne change rien.
    const { input } = await capturedDiagnosticInput(
      '2026-06-15T10:00:00.000Z',
      '2026-06-10T09:00:00.000Z',
    );
    expect(input.asOf).toBe('2026-06-15');
    expect(input.annualEncaissedCents).toBe(4_000_000);
  });
});
