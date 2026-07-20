import { randomInt, randomUUID } from 'node:crypto';
import { CreateCreditNote, Invoice, type InvoiceKind, type InvoiceSnapshot } from '@bob/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_CREDIT_NOTE_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)('Avoir légal — certification PostgreSQL/FORCE RLS', () => {
  const companyA = `credit-note-a-${randomUUID()}`;
  const companyB = `credit-note-b-${randomUUID()}`;
  const customerA = `credit-customer-a-${randomUUID()}`;
  const customerB = `credit-customer-b-${randomUUID()}`;
  const sourceFinalA = `source-final-a-${randomUUID()}`;
  const sourceDepositA = `source-deposit-a-${randomUUID()}`;
  const sourceRaceA = `source-race-a-${randomUUID()}`;
  const sourceFinalB = `source-final-b-${randomUUID()}`;
  const creditFinalA = `credit-final-a-${randomUUID()}`;
  const creditDepositA = `credit-deposit-a-${randomUUID()}`;
  const deletableDraftA = `deletable-draft-a-${randomUUID()}`;
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workers: PrismaService[] = [];
  let persistence: PrismaPersistence;

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workers = [
      new PrismaService({ datasourceUrl: runtimeUrl }),
      new PrismaService({ datasourceUrl: runtimeUrl }),
    ];
    persistence = new PrismaPersistence(workers[0]!);
    await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);

    for (const [companyId, customerId] of [
      [companyA, customerA],
      [companyB, customerB],
    ] as const) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      await admin.company.create({
        data: {
          id: companyId,
          name: `Certification ${companyId}`,
          legalForm: 'EI',
          siren,
          siret: `${siren}00001`,
          trade: 'certification',
          vatRegime: 'reel_normal',
          addrLine1: '1 rue de la Certification',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          companyId,
          type: 'b2b',
          name: `Client ${customerId}`,
          addrLine1: '2 rue du Client',
          addrZip: '75002',
          addrCity: 'Paris',
        },
      });
    }

    await persistence.runWithTenant(companyA, async () => {
      await persistIssuedFixture(
        persistence,
        issuedInvoice({
          id: sourceFinalA,
          companyId: companyA,
          customerId: customerA,
          kind: 'final',
          number: 'F-2026-0101',
        }),
      );
      await persistIssuedFixture(
        persistence,
        issuedInvoice({
          id: sourceRaceA,
          companyId: companyA,
          customerId: customerA,
          kind: 'final',
          number: 'F-2026-0103',
          parentQuoteId: 'race-quote',
        }),
      );
      await persistIssuedFixture(
        persistence,
        issuedInvoice({
          id: sourceDepositA,
          companyId: companyA,
          customerId: customerA,
          kind: 'deposit',
          number: 'F-2026-0102',
        }),
      );
    });
    await persistence.runWithTenant(companyB, () =>
      persistIssuedFixture(
        persistence,
        issuedInvoice({
          id: sourceFinalB,
          companyId: companyB,
          customerId: customerB,
          kind: 'final',
          number: 'F-2026-0201',
        }),
      ),
    );
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.lineItem
        .deleteMany({
          where: { invoice: { companyId: { in: [companyA, companyB] } } },
        })
        .catch(() => undefined);
      await admin.invoice
        .deleteMany({
          where: { companyId: { in: [companyA, companyB] } },
        })
        .catch(() => undefined);
      await admin.customer
        .deleteMany({
          where: { companyId: { in: [companyA, companyB] } },
        })
        .catch(() => undefined);
      await admin.company
        .deleteMany({
          where: { id: { in: [companyA, companyB] } },
        })
        .catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  it('certifie les contraintes, index et FORCE RLS de la table source', async () => {
    const [shape] = await admin.$queryRaw<
      Array<{
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        tenantFk: boolean;
        sourceShape: boolean;
        sourceUnique: boolean;
        generatedUnique: boolean;
        legacyUniqueGone: boolean;
        legalTrigger: boolean;
        lineImmutableTrigger: boolean;
        lineMatchTrigger: boolean;
        migrationApplied: boolean;
      }>
    >`
      SELECT
        table_class.relrowsecurity AS "rowSecurity",
        table_class.relforcerowsecurity AS "forceRowSecurity",
        EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'invoices'::regclass
             AND conname = 'invoices_credit_note_source_tenant_fk'
             AND convalidated
        ) AS "tenantFk",
        EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'invoices'::regclass
             AND conname = 'invoices_credit_note_source_shape'
             AND NOT convalidated
        ) AS "sourceShape",
        to_regclass('public.uniq_credit_note_source_invoice') IS NOT NULL AS "sourceUnique",
        to_regclass('public.uniq_invoice_parent_quote_generated_kind') IS NOT NULL AS "generatedUnique",
        to_regclass('public.uniq_invoice_parent_quote_kind') IS NULL AS "legacyUniqueGone",
        EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgrelid = 'invoices'::regclass
             AND tgname = 'invoices_legal_traceability'
             AND NOT tgisinternal
        ) AS "legalTrigger",
        EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgrelid = 'line_items'::regclass
             AND tgname = 'invoice_lines_issued_immutability'
             AND NOT tgisinternal
        ) AS "lineImmutableTrigger",
        EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgrelid = 'line_items'::regclass
             AND tgname = 'line_credit_note_lines_match'
             AND NOT tgisinternal
        ) AS "lineMatchTrigger",
        EXISTS (
          SELECT 1 FROM _prisma_migrations
           WHERE migration_name = '20260714060000_credit_note_source_traceability'
             AND finished_at IS NOT NULL
             AND rolled_back_at IS NULL
        ) AS "migrationApplied"
      FROM pg_class AS table_class
      WHERE table_class.oid = 'invoices'::regclass
    `;
    expect(shape).toEqual({
      rowSecurity: true,
      forceRowSecurity: true,
      tenantFk: true,
      sourceShape: true,
      sourceUnique: true,
      generatedUnique: true,
      legacyUniqueGone: true,
      legalTrigger: true,
      lineImmutableTrigger: true,
      lineMatchTrigger: true,
      migrationApplied: true,
    });
  });

  it('conserve les identifiants et le contenu des lignes quand une facture émise change de statut', async () => {
    const before = await admin.lineItem.findMany({
      where: { invoiceId: sourceFinalA },
      select: { id: true, label: true, qty: true, unitPriceHt: true, vatRate: true },
      orderBy: { position: 'asc' },
    });
    await persistence.runWithTenant(companyA, async () => {
      const source = await persistence.invoices.findById(sourceFinalA);
      if (!source) throw new Error('source absente');
      const payment = source.registerPayment(1_000, '2026-07-14T12:00:00.000Z');
      if (!payment.ok) throw new Error('paiement de certification invalide');
      await persistence.invoices.save(source);
    });
    const after = await admin.lineItem.findMany({
      where: { invoiceId: sourceFinalA },
      select: { id: true, label: true, qty: true, unitPriceHt: true, vatRate: true },
      orderBy: { position: 'asc' },
    });
    expect(after.map(normalizeLine)).toEqual(before.map(normalizeLine));
  });

  it('conserve la suppression explicite d’un vrai brouillon malgré la FK restrictive', async () => {
    const draft = Invoice.composeStandalone({
      id: deletableDraftA,
      companyId: companyA,
      customerId: customerA,
    });
    if (!draft.ok) throw new Error('brouillon de certification invalide');
    const line = draft.value.addLine({
      id: `${deletableDraftA}:line`,
      label: 'Brouillon supprimable',
      category: 'labor',
      qty: 1,
      unitPriceHT: 10_000,
      vatRate: 20,
    });
    if (!line.ok) throw new Error('ligne de certification invalide');

    await persistence.runWithTenant(companyA, async () => {
      await persistence.invoices.save(draft.value);
      await persistence.invoices.deleteById(deletableDraftA);
      expect(await persistence.invoices.findById(deletableDraftA)).toBeNull();
    });
    expect(await admin.lineItem.count({ where: { invoiceId: deletableDraftA } })).toBe(0);
  });

  it('persiste deux avoirs du même devis, chacun relié à sa facture exacte, puis rejoue par source', async () => {
    await persistence.runWithTenant(companyA, async () => {
      const finalUseCase = new CreateCreditNote({
        invoices: persistence.invoices,
        ids: { newId: () => creditFinalA },
      });
      const depositUseCase = new CreateCreditNote({
        invoices: persistence.invoices,
        ids: { newId: () => creditDepositA },
      });
      const finalCredit = await finalUseCase.execute({ invoiceId: sourceFinalA });
      const depositCredit = await depositUseCase.execute({ invoiceId: sourceDepositA });
      const replay = await finalUseCase.execute({ invoiceId: sourceFinalA });

      expect(finalCredit).toEqual({ ok: true, value: { creditNoteId: creditFinalA } });
      expect(depositCredit).toEqual({ ok: true, value: { creditNoteId: creditDepositA } });
      expect(replay).toEqual(finalCredit);
      expect((await persistence.invoices.findById(creditFinalA))?.creditNoteSource).toEqual({
        invoiceId: sourceFinalA,
        kind: 'final',
        number: 'F-2026-0101',
        issuedAt: '2026-07-14',
      });
      const deposit = await persistence.invoices.findById(creditDepositA);
      expect(deposit?.creditNoteSource?.invoiceId).toBe(sourceDepositA);
      expect(deposit?.totals().netToPay).toBe(36_000);
    });
  });

  it("crée l'avoir d'une facture dont le régime de TVA est FIGÉ (cas réel de production)", async () => {
    // Incident terrain du 20/07 remonté par Sentry (BOB-PRO-API-2) : la création d'avoir
    // échouait en 23514 sur « invoices_vat_treatment_requires_issue ». L'avoir naît BROUILLON
    // (issuedAt NULL) mais hérite dès sa création du régime de sa source (art. 272 CGI) — état
    // légitime que la contrainte du 19/07 interdisait. Les fixtures existantes ne posaient
    // aucun régime figé : le harnais était aveugle au cas réel.
    const sourceId = `source-vat-${randomUUID()}`;
    const creditId = `credit-vat-${randomUUID()}`;
    await persistence.runWithTenant(companyA, async () => {
      await persistence.invoices.save(
        issuedInvoice({
          id: sourceId,
          companyId: companyA,
          customerId: customerA,
          kind: 'final',
          number: `F-2026-0${randomInt(500, 899)}`,
          vatTreatmentAtIssuance: 'standard',
        }),
      );
      const useCase = new CreateCreditNote({
        invoices: persistence.invoices,
        ids: { newId: () => creditId },
      });

      const created = await useCase.execute({ invoiceId: sourceId });

      expect(created).toEqual({ ok: true, value: { creditNoteId: creditId } });
      const credit = await persistence.invoices.findById(creditId);
      // Le régime est REPRIS de la source, sur une pièce encore non émise.
      expect(credit?.vatTreatmentAtIssuance).toBe('standard');
      expect(credit?.issuedAt).toBeNull();
    });
  });

  it('fait converger deux créations concurrentes sur un seul avoir et une seule identité', async () => {
    const candidates = [`race-credit-${randomUUID()}`, `race-credit-${randomUUID()}`];
    const attempts = workers.map((worker, index) => {
      const scoped = new PrismaPersistence(worker);
      return scoped.runWithTenant(companyA, () =>
        new CreateCreditNote({
          invoices: scoped.invoices,
          ids: { newId: () => candidates[index]! },
        }).execute({ invoiceId: sourceRaceA }),
      );
    });

    const [first, second] = await Promise.all(attempts);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.creditNoteId).toBe(first.value.creditNoteId);
    expect(candidates).toContain(first.value.creditNoteId);
    expect(
      await admin.invoice.count({
        where: { companyId: companyA, sourceInvoiceId: sourceRaceA },
      }),
    ).toBe(1);
  });

  it('masque les avoirs inter-tenant et rejette une référence source forgée', async () => {
    await persistence.runWithTenant(companyB, async () => {
      await expect(
        persistence.invoices.findCreditNoteBySourceInvoiceId(companyA, sourceFinalA),
      ).resolves.toBeNull();
    });

    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.invoice.create({
          data: {
            id: `forged-credit-${randomUUID()}`,
            companyId: companyA,
            customerId: customerA,
            kind: 'credit_note',
            status: 'draft',
            parentQuoteId: 'shared-quote',
            sourceInvoiceId: sourceFinalB,
            sourceInvoiceKind: 'invoice',
            sourceInvoiceNumber: 'F-2026-0201',
            sourceInvoiceIssuedAt: new Date('2026-07-14'),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuse le doublon DB, avoir-sur-avoir et toute mutation de la trace ou de la source émise', async () => {
    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.invoice.create({
          data: {
            id: `duplicate-credit-${randomUUID()}`,
            companyId: companyA,
            customerId: customerA,
            kind: 'credit_note',
            status: 'draft',
            parentQuoteId: 'shared-quote',
            sourceInvoiceId: sourceFinalA,
            sourceInvoiceKind: 'invoice',
            sourceInvoiceNumber: 'F-2026-0101',
            sourceInvoiceIssuedAt: new Date('2026-07-14'),
          },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.invoice.create({
          data: {
            id: `credit-on-credit-${randomUUID()}`,
            companyId: companyA,
            customerId: customerA,
            kind: 'credit_note',
            status: 'draft',
            parentQuoteId: 'shared-quote',
            sourceInvoiceId: creditFinalA,
            sourceInvoiceKind: 'invoice',
            sourceInvoiceNumber: 'A-forged',
            sourceInvoiceIssuedAt: new Date('2026-07-14'),
          },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.invoice.update({
          where: { id: creditFinalA },
          data: { sourceInvoiceNumber: 'F-forged' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.invoice.update({
          where: { id: creditFinalA },
          data: { totalsHt: 1 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.lineItem.updateMany({
          where: { invoiceId: creditFinalA },
          data: { label: 'Ligne avoir falsifiée' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.invoice.update({
          where: { id: sourceFinalA },
          data: { number: 'F-forged' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.invoice.update({
          where: { id: sourceFinalA },
          data: { status: 'draft' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.lineItem.updateMany({
          where: { invoiceId: sourceFinalA },
          data: { label: 'Ligne source falsifiée' },
        }),
      ),
    ).rejects.toThrow();
  });
});

async function persistIssuedFixture(persistence: PrismaPersistence, issued: Invoice): Promise<void> {
  const snapshot = issued.toSnapshot();
  await persistence.invoices.save(
    Invoice.rehydrate({
      ...snapshot,
      status: 'draft',
      number: null,
      frozenTotals: null,
      mentions: [],
      issuedAt: null,
      dueAt: null,
      // Certifie aussi le cas réel « ajout de ligne + émission dans une seule sauvegarde » :
      // le repository doit publier la ligne avant que le trigger ne fige la pièce.
      lines: [],
    }),
  );
  await persistence.invoices.save(issued);
}

function issuedInvoice(input: {
  id: string;
  companyId: string;
  customerId: string;
  kind: Exclude<InvoiceKind, 'credit_note' | 'situation'>;
  number: string;
  parentQuoteId?: string;
  /** A4 — régime de TVA CONSTATÉ à l'émission. Toute facture émise en production en porte un ;
   * l'omettre ici rendait le harnais aveugle au cas réel (incident Sentry BOB-PRO-API-2). */
  vatTreatmentAtIssuance?: 'standard' | 'franchise' | 'autoliquidation';
}): Invoice {
  const deposit = input.kind === 'deposit';
  const snapshot: InvoiceSnapshot = {
    id: input.id,
    companyId: input.companyId,
    customerId: input.customerId,
    kind: input.kind,
    status: 'issued',
    lines: [
      {
        id: `${input.id}:line`,
        label: 'Prestation certifiée',
        category: 'labor',
        qty: 1,
        unitPriceHT: 100_000,
        vatRate: 20,
      },
    ],
    number: input.number,
    frozenTotals: {
      ht: 100_000,
      vatByRate: { '20': 20_000 },
      vat: 20_000,
      ttc: 120_000,
      netToPay: deposit ? 36_000 : 120_000,
    },
    mentions: ['Certification'],
    issuedAt: '2026-07-14',
    dueAt: '2026-08-13',
    paid: 0,
    depositPct: deposit ? 30 : null,
    parentQuoteId: input.parentQuoteId ?? 'shared-quote',
    depositDeductionCents: 0,
    depositInvoiceId: null,
    sourceInvoiceId: null,
    sourceInvoiceKind: null,
    sourceInvoiceNumber: null,
    sourceInvoiceIssuedAt: null,
    ...(input.vatTreatmentAtIssuance
      ? { vatTreatmentAtIssuance: input.vatTreatmentAtIssuance }
      : {}),
  };
  return Invoice.rehydrate(snapshot);
}

function normalizeLine(line: {
  id: string;
  label: string;
  qty: { toString(): string };
  unitPriceHt: number;
  vatRate: { toString(): string };
}) {
  return {
    id: line.id,
    label: line.label,
    qty: line.qty.toString(),
    unitPriceHt: line.unitPriceHt,
    vatRate: line.vatRate.toString(),
  };
}
