import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Expense,
  Payment,
  parisDateOnly,
  type OcrPort,
  type PaymentGatewayPort,
  type PdfRendererPort,
} from '@bob/core';
import { BackendService } from './backend.service';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

// `Principal.companyId` est nullable par contrat ; les seeds exigent un tenant certain.
const OWNER_COMPANY = 'company-owner';
const INTRUDER_COMPANY = 'company-intruder';
const OWNER: Principal = { userId: 'owner-user', companyId: OWNER_COMPANY };

function asPrincipal<T>(principal: Principal, fn: () => T): T {
  return requestContext.run({ correlationId: 'cash-position-test', principal }, fn);
}

function harness() {
  const persistence = new InMemoryPersistence();
  const service = new BackendService(
    persistence,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    {
      setUserCompanyId: vi.fn(async () => undefined),
      deleteUser: vi.fn(async () => undefined),
    } as SupabaseAdminPort,
    {} as NotificationDeliveryService,
    {
      aiRequests: { inc: vi.fn() },
      aiDuration: { observe: vi.fn() },
      aiGuardViolations: { inc: vi.fn() },
    } as unknown as Metrics,
    { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger,
  );
  return { persistence, service };
}

async function seedPayment(
  persistence: InMemoryPersistence,
  input: { id: string; companyId: string; amount: number; receivedAt: string },
): Promise<void> {
  const payment = Payment.record({
    id: input.id,
    companyId: input.companyId,
    invoiceId: `invoice-${input.id}`,
    amount: input.amount,
    method: 'transfer',
    receivedAt: input.receivedAt,
  });
  if (!payment.ok) throw new Error('SEED_PAYMENT_INVALID');
  await persistence.payments.save(payment.value);
}

async function seedSettledExpense(
  persistence: InMemoryPersistence,
  input: { id: string; companyId: string; totalTtcCents: number; paidOn: string },
): Promise<void> {
  const expense = Expense.record(
    {
      id: input.id,
      companyId: input.companyId,
      supplierName: 'Cedeo',
      supplierSiren: null,
      documentDate: input.paidOn,
      totalTtcCents: input.totalTtcCents,
      totalHtCents: null,
      vatCents: null,
      vatRatePct: null,
      category: 'fournitures',
      status: 'paid',
      paymentEvidence: {
        paidOn: input.paidOn,
        method: 'transfer',
        reference: null,
        proofDocumentId: null,
      },
      source: 'manual',
    },
    { today: input.paidOn },
  );
  if (!expense.ok) throw new Error(`SEED_EXPENSE_INVALID:${JSON.stringify(expense.error)}`);
  await persistence.expenses.save(expense.value);
}

/** Un instant ISO canonique décalé de `minutes` par rapport à maintenant. */
function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Horloge FIGÉE : la règle de bordure des dates seules raisonne en jour Europe/Paris, donc un test
 * calé sur l'heure réelle deviendrait vert ou rouge selon l'heure d'exécution (le jour Paris bascule
 * à 22:00 UTC en été). On fige un midi d'été bien à l'intérieur de sa journée.
 * Paris = UTC+2 le 20/07 → jour métier 2026-07-20, ouvert depuis 2026-07-19T22:00:00Z.
 */
const NOW = '2026-07-20T10:00:00.000Z';
/** 16 h avant NOW : FRAÎCHE (< 24 h) et pourtant sur le jour Paris PRÉCÉDENT (2026-07-19). */
const OBSERVED_PREVIOUS_PARIS_DAY = '2026-07-19T18:00:00.000Z';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => vi.useRealTimers());

describe('position de trésorerie runtime — le solde constaté cesse d’être affiché seul', () => {
  it('BUG D’ORIGINE : encaisser une facture fait bouger la position, plus seulement « on te doit »', async () => {
    const { persistence, service } = harness();
    const observedAt = minutesFromNow(-60);
    await asPrincipal(OWNER, () =>
      service.recordManualBankBalance({ amountCents: 100_000, observedAt }),
    );

    // Le fondateur marque une facture de 60 € payée APRÈS avoir constaté son solde.
    await seedPayment(persistence, {
      id: 'payment-60',
      companyId: OWNER_COMPANY,
      amount: 6_000,
      receivedAt: minutesFromNow(-30),
    });

    const view = await asPrincipal(OWNER, () => service.latestQualifiedBankBalance());
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    // Le FAIT ne bouge pas — il n'a aucune raison de bouger, personne n'a reconstaté la banque.
    expect(view.value.amountCents).toBe(100_000);
    // L'ESTIMATION, elle, intègre l'encaissement : c'est la moitié qui manquait à l'écran.
    expect(view.value.position).toMatchObject({
      observedBalanceCents: 100_000,
      estimatedBalanceCents: 106_000,
      movements: { inflowCents: 6_000, inflowCount: 1, outflowCents: 0, netCents: 6_000 },
    });
  });

  it('PREUVE DE PROPAGATION : la projection de trésorerie part de l’ESTIMÉ, plus du solde brut', async () => {
    const { persistence, service } = harness();
    const observedAt = minutesFromNow(-60);
    await asPrincipal(OWNER, () =>
      service.recordManualBankBalance({ amountCents: 250_000, observedAt }),
    );
    await seedPayment(persistence, {
      id: 'payment-a',
      companyId: OWNER_COMPANY,
      amount: 6_000,
      receivedAt: minutesFromNow(-30),
    });

    const projection = await asPrincipal(OWNER, () => service.getCashflow('realiste', 30));

    // Avant cette lane : 250 000 (le solde figé). Le +6 000 encaissé n'atteignait AUCUNE projection.
    expect(projection).toMatchObject({
      ok: true,
      value: { available: 256_000, bankingSource: 'qualified_snapshot' },
    });
  });

  it('un décaissement réglé après l’observation réduit la position ET la projection', async () => {
    const { persistence, service } = harness();
    // Observation sur le jour Paris PRÉCÉDENT : le règlement daté d'aujourd'hui est alors
    // CERTAINEMENT postérieur, malgré l'absence d'heure sur `paidOn`.
    await asPrincipal(OWNER, () =>
      service.recordManualBankBalance({
        amountCents: 200_000,
        observedAt: OBSERVED_PREVIOUS_PARIS_DAY,
      }),
    );
    expect(parisDateOnly(OBSERVED_PREVIOUS_PARIS_DAY)).toBe('2026-07-19');
    await seedSettledExpense(persistence, {
      id: 'expense-out',
      companyId: OWNER_COMPANY,
      totalTtcCents: 18_490,
      paidOn: parisDateOnly(),
    });

    const view = await asPrincipal(OWNER, () => service.latestQualifiedBankBalance());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.position).toMatchObject({
      estimatedBalanceCents: 181_510,
      movements: { outflowCents: 18_490, outflowCount: 1, netCents: -18_490 },
    });

    await expect(asPrincipal(OWNER, () => service.getCashflow('realiste', 30))).resolves.toMatchObject(
      { ok: true, value: { available: 181_510, bankingSource: 'qualified_snapshot' } },
    );
  });

  it('ANTI-DOUBLE-COMPTAGE : un mouvement antérieur à l’observation est écarté et compté comme tel', async () => {
    const { persistence, service } = harness();
    const observedAt = minutesFromNow(-60);
    await asPrincipal(OWNER, () =>
      service.recordManualBankBalance({ amountCents: 100_000, observedAt }),
    );
    // Encaissement d'il y a 2 h : franchement antérieur, l'adapter ne le remonte même pas.
    await seedPayment(persistence, {
      id: 'payment-old',
      companyId: OWNER_COMPANY,
      amount: 9_900,
      receivedAt: minutesFromNow(-120),
    });
    // Encaissement à l'instant EXACT de l'observation : il franchit la borne LARGE du SQL (`>=`)
    // et se fait écarter par la comparaison STRICTE du use case — rien ne prouve que la banque ne
    // l'avait pas déjà pris en compte. C'est la bordure que l'adapter ne doit surtout pas trancher.
    await seedPayment(persistence, {
      id: 'payment-boundary',
      companyId: OWNER_COMPANY,
      amount: 4_200,
      receivedAt: observedAt,
    });

    const view = await asPrincipal(OWNER, () => service.latestQualifiedBankBalance());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.position).toMatchObject({
      estimatedBalanceCents: 100_000,
      movements: { inflowCents: 0, netCents: 0, ignoredBeforeObservationCount: 1 },
    });
  });

  it('CLOISONNEMENT : les mouvements d’un autre tenant n’entrent jamais dans la position', async () => {
    const { persistence, service } = harness();
    const observedAt = minutesFromNow(-60);
    await asPrincipal(OWNER, () =>
      service.recordManualBankBalance({ amountCents: 100_000, observedAt }),
    );
    await seedPayment(persistence, {
      id: 'payment-intruder',
      companyId: INTRUDER_COMPANY,
      amount: 500_000,
      receivedAt: minutesFromNow(-10),
    });

    const view = await asPrincipal(OWNER, () => service.latestQualifiedBankBalance());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.position?.estimatedBalanceCents).toBe(100_000);
  });

  it('CONTRAT INCHANGÉ : tenant vierge → bankingSource none, sans position ni montant inventé', async () => {
    const { service } = harness();

    await expect(asPrincipal(OWNER, () => service.getCashflow('realiste', 30))).resolves.toMatchObject(
      { ok: true, value: { available: 0, bankingSource: 'none' } },
    );
    // Aucune observation qualifiée = PAS de position : fail-closed, jamais un zéro dérivé.
    await expect(asPrincipal(OWNER, () => service.cashPosition())).resolves.toMatchObject({
      ok: false,
      error: { kind: 'not_found', entity: 'bank_balance_snapshot' },
    });
  });

  it('CONTRAT INCHANGÉ : un document financier sans observation reste un refus fail-closed', async () => {
    const { service } = harness();
    await asPrincipal(OWNER, () =>
      service.recordExpense({
        supplierName: 'Cedeo',
        documentDate: '2026-07-01',
        totalTtcCents: 18_490,
        category: 'fournitures',
      }),
    );

    await expect(asPrincipal(OWNER, () => service.getCashflow('realiste', 30))).resolves.toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'cashflow-banking-source' },
    });
  });

  it('DÉGRADATION HONNÊTE : projection des mouvements en panne → position null, le constaté reste lisible', async () => {
    const { persistence, service } = harness();
    await asPrincipal(OWNER, () =>
      service.recordManualBankBalance({
        amountCents: 100_000,
        observedAt: minutesFromNow(-60),
      }),
    );
    vi.spyOn(persistence.cashMovements, 'listSinceObservation').mockRejectedValue(
      new Error('projection offline'),
    );

    const view = await asPrincipal(OWNER, () => service.latestQualifiedBankBalance());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    // Le chemin de réparation (ressaisie du solde) ne doit JAMAIS être coupé par une panne de
    // projection ; on perd la richesse de la réponse, pas son honnêteté.
    expect(view.value.amountCents).toBe(100_000);
    expect(view.value.position).toBeNull();
  });
});
