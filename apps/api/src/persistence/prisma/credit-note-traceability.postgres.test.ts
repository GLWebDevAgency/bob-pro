import { randomInt, randomUUID } from 'node:crypto';
import { CreateCreditNote, Invoice, type InvoiceKind, type InvoiceSnapshot } from '@bob/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_CREDIT_NOTE_CERT === 'true';

function passesLuhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function appendLuhnDigit(prefix: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${prefix}${digit}`;
    if (passesLuhn(candidate)) return candidate;
  }
  throw new Error('unable to build a valid Luhn identifier');
}

function testLegalIdentity(): { siren: string; siret: string; tvaIntracom: string } {
  const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
  const nicPrefix = String(randomInt(0, 10_000)).padStart(4, '0');
  const siret = appendLuhnDigit(`${siren}${nicPrefix}`);
  const vatKey = String((12 + 3 * (Number(siren) % 97)) % 97).padStart(2, '0');
  return { siren, siret, tvaIntracom: `FR${vatKey}${siren}` };
}

type FiscalFenceMutation =
  | 'duplicate_credit_source'
  | 'cross_tenant_fiscal_source'
  | 'issued_fiscal_mutation'
  | 'credit_fiscal_mirror';

async function certifyFiscalFence(
  tx: Prisma.TransactionClient,
  input: {
    mutation: FiscalFenceMutation;
    creditId: string;
    sourceId: string;
    foreignSourceId: string;
    newId: string;
  },
): Promise<void> {
  const definition: { statement: string; sqlState: string; constraint: string } = (() => {
    switch (input.mutation) {
      case 'duplicate_credit_source':
        return {
          statement: `
            INSERT INTO public.invoices
            SELECT (
              jsonb_populate_record(
                NULL::public.invoices,
                to_jsonb(existing_credit)
                  || jsonb_build_object('id', current_setting('bob.cert_new_id'))
              )
            ).*
              FROM public.invoices AS existing_credit
             WHERE id = current_setting('bob.cert_credit_id')`,
          sqlState: '23505',
          constraint: 'uniq_credit_note_source_invoice',
        };
      case 'cross_tenant_fiscal_source':
        return {
          statement: `
            INSERT INTO public.invoices
            SELECT (
              jsonb_populate_record(
                NULL::public.invoices,
                to_jsonb(existing_credit)
                  || jsonb_build_object(
                    'id', current_setting('bob.cert_new_id'),
                    'sourceInvoiceId', current_setting('bob.cert_foreign_source_id')
                  )
              )
            ).*
              FROM public.invoices AS existing_credit
             WHERE id = current_setting('bob.cert_credit_id')`,
          sqlState: '23503',
          constraint: 'invoices_credit_note_fiscal_source_tenant',
        };
      case 'issued_fiscal_mutation':
        return {
          statement: `
            UPDATE public.invoices
               SET "frenchBillingModeAtIssuance" = 'M1'
             WHERE id = current_setting('bob.cert_source_id')`,
          sqlState: '23514',
          constraint: 'invoices_issued_fiscal_immutability',
        };
      case 'credit_fiscal_mirror':
        return {
          statement: `
            UPDATE public.invoices
               SET "frenchBillingModeAtIssuance" = 'M1'
             WHERE id = current_setting('bob.cert_credit_id')`,
          sqlState: '23514',
          constraint: 'invoices_credit_note_fiscal_mirror',
        };
    }
  })();

  await tx.$executeRaw`SELECT set_config('bob.cert_credit_id', ${input.creditId}, true)`;
  await tx.$executeRaw`SELECT set_config('bob.cert_source_id', ${input.sourceId}, true)`;
  await tx.$executeRaw`SELECT set_config('bob.cert_foreign_source_id', ${input.foreignSourceId}, true)`;
  await tx.$executeRaw`SELECT set_config('bob.cert_new_id', ${input.newId}, true)`;
  await tx.$executeRawUnsafe(`
    DO $credit_note_fiscal_cert$
    DECLARE
      caught_state text;
      caught_constraint text;
    BEGIN
      BEGIN
        ${definition.statement};
        RAISE EXCEPTION 'CERT_EXPECTED_FISCAL_FENCE_${input.mutation}';
      EXCEPTION
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS
            caught_state = RETURNED_SQLSTATE,
            caught_constraint = CONSTRAINT_NAME;
          IF caught_state <> '${definition.sqlState}'
             OR caught_constraint <> '${definition.constraint}' THEN
            RAISE EXCEPTION
              'CERT_WRONG_FISCAL_DIAGNOSTIC mutation=${input.mutation} state=% constraint=%',
              caught_state,
              caught_constraint;
          END IF;
      END;
    END
    $credit_note_fiscal_cert$;
  `);
}

describe.skipIf(!RUN_POSTGRES_CERT)('Avoir légal — certification PostgreSQL/FORCE RLS', () => {
  const companyA = `credit-note-a-${randomUUID()}`;
  const companyB = `credit-note-b-${randomUUID()}`;
  const customerA = `credit-customer-a-${randomUUID()}`;
  const customerB = `credit-customer-b-${randomUUID()}`;
  const sourceFinalA = `source-final-a-${randomUUID()}`;
  const sourceDepositA = `source-deposit-a-${randomUUID()}`;
  const sourceRaceA = `source-race-a-${randomUUID()}`;
  const sourceLegacyA = `source-legacy-a-${randomUUID()}`;
  const sourceFinalB = `source-final-b-${randomUUID()}`;
  const sharedQuoteA = `shared-quote-a-${randomUUID()}`;
  const raceQuoteA = `race-quote-a-${randomUUID()}`;
  const legacyQuoteA = `legacy-quote-a-${randomUUID()}`;
  const sharedQuoteB = `shared-quote-b-${randomUUID()}`;
  const creditFinalA = `credit-final-a-${randomUUID()}`;
  const creditDepositA = `credit-deposit-a-${randomUUID()}`;
  const deletableDraftA = `deletable-draft-a-${randomUUID()}`;
  const identityA = testLegalIdentity();
  const identityB = testLegalIdentity();
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

    for (const [companyId, customerId, siren, siret, tvaIntracom] of [
      [companyA, customerA, identityA.siren, identityA.siret, identityA.tvaIntracom],
      [companyB, customerB, identityB.siren, identityB.siret, identityB.tvaIntracom],
    ] as const) {
      await admin.company.create({
        data: {
          id: companyId,
          name: `Certification ${companyId}`,
          legalForm: 'EI',
          siren,
          siret,
          tvaIntracom,
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
    await admin.quote.createMany({
      data: [
        { id: sharedQuoteA, companyId: companyA, customerId: customerA },
        { id: raceQuoteA, companyId: companyA, customerId: customerA },
        { id: legacyQuoteA, companyId: companyA, customerId: customerA },
        { id: sharedQuoteB, companyId: companyB, customerId: customerB },
      ],
    });

    await persistence.runWithTenant(companyA, async () => {
      await persistIssuedFixture(
        persistence,
        issuedInvoice({
          id: sourceFinalA,
          companyId: companyA,
          customerId: customerA,
          kind: 'final',
          number: 'F-2026-0101',
          parentQuoteId: sharedQuoteA,
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
          parentQuoteId: raceQuoteA,
        }),
      );
      await persistIssuedFixture(
        persistence,
        Invoice.rehydrate({
          ...issuedInvoice({
            id: sourceLegacyA,
            companyId: companyA,
            customerId: customerA,
            kind: 'final',
            number: 'F-2026-0104',
            parentQuoteId: legacyQuoteA,
          }).toSnapshot(),
          vatTreatmentAtIssuance: null,
          frenchBillingModeAtIssuance: null,
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
          parentQuoteId: sharedQuoteA,
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
          parentQuoteId: sharedQuoteB,
        }),
      ),
    );
  }, 30_000);

  afterAll(async () => {
    try {
      if (admin) {
        await admin.$transaction(async (tx) => {
          // Les lignes émises sont légalement immuables. DIRECT_URL neutralise les triggers
          // uniquement dans cette transaction de nettoyage et uniquement sur les fixtures.
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
          await tx.lineItem.deleteMany({
            where: { invoice: { companyId: { in: [companyA, companyB] } } },
          });
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");

          // La FK self-reference sourceInvoiceId est RESTRICT : les avoirs disparaissent avant
          // leurs sources, puis les devis avant les clients. Aucun échec n'est avalé.
          await tx.invoice.deleteMany({
            where: { companyId: { in: [companyA, companyB] }, kind: 'credit_note' },
          });
          await tx.invoice.deleteMany({
            where: { companyId: { in: [companyA, companyB] } },
          });
          await tx.quote.deleteMany({
            where: { companyId: { in: [companyA, companyB] } },
          });
          await tx.customer.deleteMany({
            where: { companyId: { in: [companyA, companyB] } },
          });
          await tx.company.deleteMany({
            where: { id: { in: [companyA, companyB] } },
          });
        });
        const leftovers = await admin.company.count({
          where: { id: { in: [companyA, companyB] } },
        });
        if (leftovers !== 0) throw new Error(`credit-note certification cleanup incomplete: ${leftovers}`);
      }
    } finally {
      await Promise.allSettled([
        ...workers.map((worker) => worker.$disconnect()),
        ...(admin ? [admin.$disconnect()] : []),
      ]);
    }
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
        billingModeValid: boolean;
        vatTreatmentRequiresIssue: boolean;
        billingModeRequiresIssue: boolean;
        fiscalTrigger: boolean;
        fiscalFunctionHardened: boolean;
        fiscalMigrationApplied: boolean;
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
          SELECT 1 FROM pg_trigger AS trigger
           WHERE trigger.tgrelid = 'invoices'::regclass
             AND trigger.tgname = 'invoices_legal_traceability'
             AND NOT trigger.tgisinternal
             AND trigger.tgenabled = 'O'
             AND trigger.tgfoid = 'enforce_invoice_legal_traceability()'::regprocedure
             AND pg_get_triggerdef(trigger.oid) LIKE '%BEFORE INSERT OR UPDATE%'
        ) AS "legalTrigger",
        EXISTS (
          SELECT 1 FROM pg_trigger AS trigger
           WHERE trigger.tgrelid = 'line_items'::regclass
             AND trigger.tgname = 'invoice_lines_issued_immutability'
             AND NOT trigger.tgisinternal
             AND trigger.tgenabled = 'O'
             AND trigger.tgfoid = 'enforce_issued_invoice_line_immutability()'::regprocedure
             AND pg_get_triggerdef(trigger.oid) LIKE '%BEFORE INSERT OR DELETE OR UPDATE%'
        ) AS "lineImmutableTrigger",
        EXISTS (
          SELECT 1 FROM pg_trigger AS trigger
           WHERE trigger.tgrelid = 'line_items'::regclass
             AND trigger.tgname = 'line_credit_note_lines_match'
             AND NOT trigger.tgisinternal
             AND trigger.tgenabled = 'O'
             AND trigger.tgfoid = 'verify_credit_note_lines_from_line()'::regprocedure
             AND pg_get_triggerdef(trigger.oid) LIKE '%AFTER INSERT OR DELETE OR UPDATE%'
        ) AS "lineMatchTrigger",
        EXISTS (
          SELECT 1 FROM _prisma_migrations
           WHERE migration_name = '20260714060000_credit_note_source_traceability'
             AND finished_at IS NOT NULL
             AND rolled_back_at IS NULL
        ) AS "migrationApplied",
        EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'invoices'::regclass
             AND conname = 'invoices_french_billing_mode_valid'
             AND convalidated
        ) AS "billingModeValid",
        EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'invoices'::regclass
             AND conname = 'invoices_vat_treatment_requires_issue'
             AND convalidated
        ) AS "vatTreatmentRequiresIssue",
        EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'invoices'::regclass
             AND conname = 'invoices_french_billing_mode_requires_issue'
             AND convalidated
        ) AS "billingModeRequiresIssue",
        EXISTS (
          SELECT 1 FROM pg_trigger AS trigger
           WHERE trigger.tgrelid = 'invoices'::regclass
             AND trigger.tgname = 'invoices_fiscal_traceability'
             AND NOT trigger.tgisinternal
             AND trigger.tgenabled = 'O'
             AND trigger.tgfoid = 'enforce_invoice_fiscal_traceability()'::regprocedure
             AND pg_get_triggerdef(trigger.oid) LIKE '%BEFORE INSERT OR UPDATE%'
        ) AS "fiscalTrigger",
        EXISTS (
          SELECT 1
            FROM pg_proc
           WHERE oid = 'enforce_invoice_fiscal_traceability()'::regprocedure
             AND NOT prosecdef
             AND array_to_string(proconfig, ',') LIKE '%search_path=pg_catalog, public%'
        ) AS "fiscalFunctionHardened",
        EXISTS (
          SELECT 1 FROM _prisma_migrations
           WHERE migration_name = '20260721133100_invoice_french_billing_mode_expand'
             AND finished_at IS NOT NULL
             AND rolled_back_at IS NULL
        ) AS "fiscalMigrationApplied"
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
      billingModeValid: true,
      vatTreatmentRequiresIssue: true,
      billingModeRequiresIssue: true,
      fiscalTrigger: true,
      fiscalFunctionHardened: true,
      fiscalMigrationApplied: true,
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
      expect(await persistence.invoices.findById(creditFinalA)).toMatchObject({
        vatTreatmentAtIssuance: 'standard',
        frenchBillingModeAtIssuance: 'S1',
      });
      const deposit = await persistence.invoices.findById(creditDepositA);
      expect(deposit?.creditNoteSource?.invoiceId).toBe(sourceDepositA);
      expect(deposit?.totals().netToPay).toBe(36_000);
    });
  });

  it('refuse une source legacy sans faits fiscaux et ne persiste aucun avoir condamné', async () => {
    await persistence.runWithTenant(companyA, async () => {
      const result = await new CreateCreditNote({
        invoices: persistence.invoices,
        ids: { newId: () => `legacy-credit-${randomUUID()}` },
      }).execute({ invoiceId: sourceLegacyA });

      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: 'domain',
          error: { code: 'VALIDATION', field: 'invoice' },
        },
      });
    });
    expect(await admin.invoice.count({
      where: { companyId: companyA, sourceInvoiceId: sourceLegacyA },
    })).toBe(0);
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
      await persistIssuedFixture(
        persistence,
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

    await workers[0]!.withTenant(companyA, (tx) =>
      certifyFiscalFence(tx, {
        mutation: 'cross_tenant_fiscal_source',
        creditId: creditFinalA,
        sourceId: sourceFinalA,
        foreignSourceId: sourceFinalB,
        newId: `forged-credit-${randomUUID()}`,
      }),
    );
  });

  it('refuse le doublon DB, avoir-sur-avoir et toute mutation de la trace ou de la source émise', async () => {
    await workers[0]!.withTenant(companyA, (tx) =>
      certifyFiscalFence(tx, {
        mutation: 'duplicate_credit_source',
        creditId: creditFinalA,
        sourceId: sourceFinalA,
        foreignSourceId: sourceFinalB,
        newId: `duplicate-credit-${randomUUID()}`,
      }),
    );

    await expect(
      workers[0]!.withTenant(companyA, (tx) =>
        tx.invoice.create({
          data: {
            id: `credit-on-credit-${randomUUID()}`,
            companyId: companyA,
            customerId: customerA,
            kind: 'credit_note',
            status: 'draft',
            parentQuoteId: sharedQuoteA,
            sourceInvoiceId: creditFinalA,
            sourceInvoiceKind: 'invoice',
            sourceInvoiceNumber: 'A-forged',
            sourceInvoiceIssuedAt: new Date('2026-07-14'),
            vatTreatmentAtIssuance: 'standard',
            frenchBillingModeAtIssuance: 'S1',
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
    await workers[0]!.withTenant(companyA, (tx) =>
      certifyFiscalFence(tx, {
        mutation: 'issued_fiscal_mutation',
        creditId: creditFinalA,
        sourceId: sourceFinalA,
        foreignSourceId: sourceFinalB,
        newId: `unused-${randomUUID()}`,
      }),
    );
    await workers[0]!.withTenant(companyA, (tx) =>
      certifyFiscalFence(tx, {
        mutation: 'credit_fiscal_mirror',
        creditId: creditFinalA,
        sourceId: sourceFinalA,
        foreignSourceId: sourceFinalB,
        newId: `unused-${randomUUID()}`,
      }),
    );
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
      vatTreatmentAtIssuance: null,
      frenchBillingModeAtIssuance: null,
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
    vatTreatmentAtIssuance: 'standard',
    frenchBillingModeAtIssuance: 'S1',
    paid: 0,
    depositPct: deposit ? 30 : null,
    parentQuoteId: input.parentQuoteId ?? null,
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
