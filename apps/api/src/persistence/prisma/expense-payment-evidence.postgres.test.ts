import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Expense, RecordExpensePayment, type ExpensePaymentEvidenceInput } from '@bob/core';
import { PrismaService } from './prisma.service';
import {
  PrismaAccountingEntryRepository,
  PrismaCompanyRepository,
  PrismaDocumentRepository,
  PrismaExpenseRepository,
} from './repositories';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_EXPENSE_PAYMENT_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)('Expense payment evidence — certification PostgreSQL/RLS', () => {
  const runId = randomUUID();
  const numericSeed = Number(BigInt(`0x${runId.replaceAll('-', '')}`) % 99_999_997n);
  function withLuhnCheckDigit(prefix: string): string {
    for (let digit = 0; digit <= 9; digit += 1) {
      const candidate = `${prefix}${digit}`;
      let sum = 0;
      let alternate = false;
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        let value = Number(candidate[index]);
        if (alternate) {
          value *= 2;
          if (value > 9) value -= 9;
        }
        sum += value;
        alternate = !alternate;
      }
      if (sum % 10 === 0) return candidate;
    }
    throw new Error('Unable to generate a Luhn identifier.');
  }
  const sirenA = withLuhnCheckDigit(String(numericSeed + 1).padStart(8, '0'));
  const sirenB = withLuhnCheckDigit(String(numericSeed + 2).padStart(8, '0'));
  const companyA = `expense-payment-a-${runId}`;
  const companyB = `expense-payment-b-${runId}`;
  const documentA = `payment-proof-a-${runId}`;
  const documentB = `payment-proof-b-${runId}`;
  const expenseA = `expense-a-${runId}`;
  const expenseConcurrent = `expense-concurrent-${runId}`;
  const expenseUseCase = `expense-usecase-${runId}`;
  const expenseCrossTenantProof = `expense-cross-proof-${runId}`;
  const expenseLegacy = `expense-legacy-${runId}`;
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workerA: PrismaService;
  let workerB: PrismaService;

  function company(id: string, siren: string, portfolio: 'b2b' | 'mixte' | null) {
    return {
      id,
      name: `Certification ${id}`,
      legalForm: 'EI' as const,
      siren,
      siret: withLuhnCheckDigit(`${siren}0001`),
      trade: 'autre',
      vatRegime: 'reel_normal' as const,
      customerPortfolio: portfolio,
      addrLine1: '1 rue de la Certification',
      addrZip: '75001',
      addrCity: 'Paris',
    };
  }

  function document(id: string, companyId: string) {
    return {
      id,
      companyId,
      kind: 'expense_receipt' as const,
      origin: 'uploaded' as const,
      status: 'active' as const,
      filename: `${id}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 128,
      sha256: 'a'.repeat(64),
      storageKey: `cert/${id}.pdf`,
      createdAt: new Date('2026-07-17T06:00:00.000Z'),
      retentionUntil: '2036-07-17',
    };
  }

  function unpaidExpense(id: string) {
    return Expense.rehydrate({
      id,
      companyId: companyA,
      supplierName: 'Fournisseur certifié',
      supplierSiren: null,
      documentDate: '2026-07-01',
      totalTtcCents: 12_000,
      totalHtCents: 10_000,
      vatCents: 2_000,
      vatRatePct: 20,
      category: 'materiel',
      status: 'to_pay',
      paymentEvidence: null,
      source: 'manual',
      supplierInvoiceNumber: null,
      dueAt: '2026-07-31',
    });
  }

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) throw new Error('DATABASE_URL runtime et DIRECT_URL admin sont requis.');
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workerA = new PrismaService({ datasourceUrl: runtimeUrl });
    workerB = new PrismaService({ datasourceUrl: runtimeUrl });
    await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
    await admin.company.createMany({
      data: [company(companyA, sirenA, 'b2b'), company(companyB, sirenB, null)],
    });
    await admin.storedDocument.createMany({
      data: [document(documentA, companyA), document(documentB, companyB)],
    });
    await admin.expense.create({
      data: {
        id: expenseLegacy,
        companyId: companyA,
        supplierName: 'Historique sans preuve',
        documentDate: '2026-06-01',
        totalTtcCents: 5_000,
        category: 'autre',
        status: 'paid',
        paymentEvidenceLegacyUnverified: true,
      },
    });
  }, 30_000);

  afterAll(async () => {
    try {
      if (admin) {
        // La certification de release ne doit jamais laisser de données de test dans la BDD cible.
        // Une suppression impossible fait échouer la suite au lieu d'être masquée par un catch.
        await admin.accountingEntry.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
        await admin.expense.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
        await admin.storedDocument.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
        await admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
      }
    } finally {
      await Promise.allSettled([workerA?.$disconnect(), workerB?.$disconnect(), admin?.$disconnect()]);
    }
  });

  it('persiste le profil déclaré et masque intégralement le tenant voisin', async () => {
    const companiesA = new PrismaCompanyRepository(workerA);
    const companiesB = new PrismaCompanyRepository(workerB);
    await workerA.withTenant(companyA, async () => {
      expect((await companiesA.findById(companyA))?.customerPortfolio).toBe('b2b');
      expect(await companiesA.findById(companyB)).toBeNull();
    });
    await workerB.withTenant(companyB, async () => {
      expect((await companiesB.findById(companyB))?.customerPortfolio).toBeUndefined();
      expect(await companiesB.findById(companyA)).toBeNull();
    });
  });

  it('écrit et relit uniquement la preuve explicite du propriétaire', async () => {
    const repo = new PrismaExpenseRepository(workerA);
    await workerA.withTenant(companyA, async () => {
      const expense = unpaidExpense(expenseA);
      await repo.save(expense);
      const transition = expense.recordPayment({
        paidOn: '2026-07-03',
        method: 'transfer',
        reference: 'VIR-CERT-1',
        proofDocumentId: documentA,
      }, { today: '2026-07-17' });
      expect(transition.ok).toBe(true);
      await repo.save(expense);
      expect((await repo.findById(expenseA))?.paymentEvidence).toEqual({
        paidOn: '2026-07-03',
        method: 'transfer',
        reference: 'VIR-CERT-1',
        proofDocumentId: documentA,
      });
    });
    await workerB.withTenant(companyB, async () => {
      expect(await new PrismaExpenseRepository(workerB).findById(expenseA)).toBeNull();
    });
  });

  it('valide la chaîne use case réelle : dépense + écriture comptable atomiques et idempotentes', async () => {
    const expenses = new PrismaExpenseRepository(workerA);
    await workerA.withTenant(companyA, () => expenses.save(unpaidExpense(expenseUseCase)));

    const execute = (evidence: ExpensePaymentEvidenceInput) => workerA.withTenant(companyA, async () =>
      new RecordExpensePayment({
        expenses: new PrismaExpenseRepository(workerA),
        entries: new PrismaAccountingEntryRepository(workerA),
        documents: new PrismaDocumentRepository(workerA),
        clock: {
          today: () => '2026-07-17',
          now: () => '2026-07-17T06:00:00.000Z',
        },
      }).execute({ companyId: companyA, expenseId: expenseUseCase, ...evidence }));

    const evidence: ExpensePaymentEvidenceInput = {
      paidOn: '2026-07-07',
      method: 'transfer',
      reference: 'VIR-USECASE-1',
      proofDocumentId: documentA,
    };
    const first = await execute(evidence);
    expect(first).toMatchObject({ ok: true, value: { status: 'paid', alreadyRecorded: false } });
    if (!first.ok) throw new Error('RecordExpensePayment failed during PostgreSQL certification.');

    const persisted = await workerA.withTenant(companyA, async () => ({
      expense: await new PrismaExpenseRepository(workerA).findById(expenseUseCase),
      entry: await new PrismaAccountingEntryRepository(workerA).findById(companyA, first.value.paymentEntryId),
    }));
    expect(persisted.expense?.paymentEvidence).toEqual({
      paidOn: '2026-07-07',
      method: 'transfer',
      reference: 'VIR-USECASE-1',
      proofDocumentId: documentA,
    });
    expect(persisted.entry?.toProps()).toMatchObject({
      companyId: companyA,
      sourceType: 'expense',
      sourceId: expenseUseCase,
      entryDate: '2026-07-07',
    });

    await expect(execute(evidence)).resolves.toMatchObject({
      ok: true,
      value: { alreadyRecorded: true, paymentEntryId: first.value.paymentEntryId },
    });
    await expect(execute({ ...evidence, reference: 'AUTRE-REFERENCE' })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'conflict', entity: 'expense_payment' },
    });
  });

  it('refuse en base un justificatif appartenant à un autre tenant', async () => {
    const repo = new PrismaExpenseRepository(workerA);
    await expect(workerA.withTenant(companyA, async () => {
      const expense = unpaidExpense(expenseCrossTenantProof);
      expect(expense.recordPayment({
        paidOn: '2026-07-04',
        method: 'card',
        proofDocumentId: documentB,
      }, { today: '2026-07-17' }).ok).toBe(true);
      await repo.save(expense);
    })).rejects.toBeDefined();
  });

  it('sérialise deux preuves concurrentes et interdit l’écrasement de la gagnante', async () => {
    const seedRepo = new PrismaExpenseRepository(workerA);
    await workerA.withTenant(companyA, () => seedRepo.save(unpaidExpense(expenseConcurrent)));

    async function record(worker: PrismaService, evidence: ExpensePaymentEvidenceInput) {
      return worker.withTenant(companyA, async () => {
        const repo = new PrismaExpenseRepository(worker);
        const expense = await repo.lockById(expenseConcurrent);
        if (!expense) throw new Error('Expense missing during concurrency certification.');
        const transition = expense.recordPayment(evidence, { today: '2026-07-17' });
        if (!transition.ok) return { status: 'rejected' as const };
        await repo.save(expense);
        return { status: 'saved' as const };
      });
    }

    const evidenceA: ExpensePaymentEvidenceInput = {
      paidOn: '2026-07-05', method: 'transfer', reference: 'WINNER-A', proofDocumentId: documentA,
    };
    const evidenceB: ExpensePaymentEvidenceInput = {
      paidOn: '2026-07-06', method: 'card', reference: 'WINNER-B', proofDocumentId: documentA,
    };
    const results = await Promise.all([record(workerA, evidenceA), record(workerB, evidenceB)]);
    expect(results.map((result) => result.status).sort()).toEqual(['rejected', 'saved']);

    const persisted = await workerA.withTenant(companyA, () =>
      new PrismaExpenseRepository(workerA).findById(expenseConcurrent));
    expect([evidenceA.reference, evidenceB.reference]).toContain(persisted?.paymentEvidence?.reference);
    expect(persisted?.paymentEvidence?.reference).not.toBeNull();
  });

  it('conserve l’historique non justifié sans fabriquer une preuve lors d’une relecture/réécriture', async () => {
    const repo = new PrismaExpenseRepository(workerA);
    await workerA.withTenant(companyA, async () => {
      const legacy = await repo.findById(expenseLegacy);
      expect(legacy?.status).toBe('paid');
      expect(legacy?.paymentEvidence).toBeNull();
      if (!legacy) throw new Error('Legacy expense missing.');
      await repo.save(legacy);
    });
    const persisted = await admin.expense.findUniqueOrThrow({ where: { id: expenseLegacy } });
    expect(persisted).toMatchObject({
      paymentPaidOn: null,
      paymentMethod: null,
      paymentReference: null,
      paymentProofDocumentId: null,
      paymentEvidenceLegacyUnverified: true,
    });
  });

  it('bloque toute ligne paid sans preuve structurée ou marqueur historique', async () => {
    await expect(admin.expense.create({
      data: {
        id: `expense-invalid-${runId}`,
        companyId: companyA,
        supplierName: 'Paiement inventé interdit',
        documentDate: '2026-07-01',
        totalTtcCents: 100,
        category: 'autre',
        status: 'paid',
      },
    })).rejects.toBeDefined();
  });
});
