import { randomInt, randomUUID } from 'node:crypto';
import {
  ClassifyDocument,
  MoveDocumentToFolder,
  appConflict,
  appNotFound,
  createFrenchOperationalChartOfAccounts,
  documentToView,
  ok,
  type ClockPort,
  type RecordExpenseInput,
} from '@bob/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExpenseCreationCoordinator,
  type ExpenseCreationAtomicFollowUp,
} from '../../expenses/expense-creation-coordinator';
import {
  PrismaExpenseCreationRequestStore,
  expenseCreationFingerprint,
} from '../expense-creation-requests';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';
import { RepositoryDocumentLinkTargets } from '../../documents/document-link-targets';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_EXPENSE_IDEMPOTENCY_CERT === 'true';

class ConcurrentCandidateLost extends Error {}

function appendLuhnDigit(prefix: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${prefix}${digit}`;
    let sum = 0;
    let double = false;
    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      let value = Number(candidate[index]);
      if (double) {
        value *= 2;
        if (value > 9) value -= 9;
      }
      sum += value;
      double = !double;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('Unable to generate a valid Luhn identifier.');
}

describe.skipIf(!RUN_POSTGRES_CERT)('Expense creation idempotency — certification PostgreSQL/RLS réelle', () => {
  const companyId = `expense-idem-cert-${randomUUID()}`;
  const expenseIds = [`expense-cert-${randomUUID()}`, `expense-cert-${randomUUID()}`];
  const entryIds = expenseIds.map((id) => `${id}:entry`);
  const workflowExpenseIds = [`document-expense-cert-${randomUUID()}`, `document-expense-cert-${randomUUID()}`];
  const rollbackExpenseId = `document-expense-rollback-cert-${randomUUID()}`;
  const workflowDocumentId = `document-cert-${randomUUID()}`;
  const rollbackDocumentId = `document-rollback-cert-${randomUUID()}`;
  const targetFolderId = `document-folder-cert-${randomUUID()}`;
  const workflowDocumentSha256 = 'c'.repeat(64);
  const rollbackDocumentSha256 = 'd'.repeat(64);
  const keyHash = 'a'.repeat(64);
  const payloadHash = 'b'.repeat(64);
  const now = '2026-07-13T12:00:00.000Z';
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workers: PrismaService[] = [];

  const clock: ClockPort = {
    now: () => now,
    today: () => '2026-07-13',
  };

  const expenseInput = (idempotencyKey: string): Omit<RecordExpenseInput, 'companyId'> => ({
    idempotencyKey,
    supplierName: 'Cedeo',
    documentDate: '2026-07-13',
    totalTtcCents: 18_490,
    totalHtCents: 15_408,
    vatCents: 3_082,
    vatRatePct: 20,
    category: 'fournitures',
    source: 'ocr',
  });

  const coordinator = (worker: PrismaService, expenseId: string) => new ExpenseCreationCoordinator({
    persistence: new PrismaPersistence(worker),
    ids: { newId: () => expenseId },
    clock,
  });

  function classifyDocumentInSameRoot(
    persistence: PrismaPersistence,
    input: { documentId: string; expectedRevision: number; forceClassificationConflict?: boolean },
  ): ExpenseCreationAtomicFollowUp<ReturnType<typeof documentToView>> {
    return async ({ expenseId }) => {
      const current = await persistence.documents.findById(companyId, input.documentId);
      if (!current || current.status !== 'active') {
        return { ok: false, error: appNotFound('document', input.documentId) };
      }
      const props = current.toProps();
      if (props.linkedEntityType !== null || props.linkedEntityId !== null) {
        if (props.linkedEntityType !== 'expense' || props.linkedEntityId !== expenseId) {
          return {
            ok: false,
            error: appConflict('document', 'Ce document est déjà rattaché à une autre entité.'),
          };
        }
        if (props.folderId !== targetFolderId) {
          return {
            ok: false,
            error: appConflict('document', 'Le document lié a changé de dossier.'),
          };
        }
        const replayFolder = await persistence.documentFolders.findById(companyId, targetFolderId);
        return replayFolder?.status === 'active'
          ? ok(documentToView(current))
          : { ok: false, error: appConflict('document', 'Le dossier de destination n’est plus actif.') };
      }
      if (current.revision !== input.expectedRevision) {
        return { ok: false, error: appConflict('document', 'Le document a été modifié.') };
      }

      const moved = await new MoveDocumentToFolder({
        folders: persistence.documentFolders,
        uow: persistence,
        clock,
      }).execute({
        companyId,
        documentId: input.documentId,
        folderId: targetFolderId,
        expectedRevision: current.revision,
      });
      if (!moved.ok) return moved;

      return new ClassifyDocument({
        documents: persistence.documents,
        clock,
        linkTargets: new RepositoryDocumentLinkTargets({
          company: persistence.companies,
          invoice: persistence.invoices,
          quote: persistence.quotes,
          expense: persistence.expenses,
          chantier: { findById: async () => null },
        }),
      }).execute({
        companyId,
        documentId: input.documentId,
        linkedEntityType: 'expense',
        linkedEntityId: expenseId,
        expectedRevision: moved.value.revision + (input.forceClassificationConflict ? 1 : 0),
      });
    };
  }

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workers = [
      new PrismaService({ datasourceUrl: runtimeUrl }),
      new PrismaService({ datasourceUrl: runtimeUrl }),
    ];
    await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
    // Les workflows complets réhydratent Company : la preuve PostgreSQL doit donc semer une
    // identité légale réellement valide, pas seulement une valeur satisfaisant le schéma SQL.
    const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
    const siret = appendLuhnDigit(`${siren}${String(randomInt(0, 10_000)).padStart(4, '0')}`);
    await admin.company.create({
      data: {
        id: companyId,
        name: 'Bob Expense Idempotency PostgreSQL Certification',
        legalForm: 'EI',
        siren,
        siret,
        trade: 'autre',
        vatRegime: 'reel_normal',
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });
    await admin.documentFolder.create({
      data: {
        id: targetFolderId,
        companyId,
        parentId: null,
        name: 'Achats certifiés',
        normalizedName: 'achats certifies',
        systemKey: null,
        status: 'active',
        revision: 1,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        deletedAt: null,
      },
    });
    for (const [documentId, sha256] of [
      [workflowDocumentId, workflowDocumentSha256],
      [rollbackDocumentId, rollbackDocumentSha256],
    ] as const) {
      const storageKey = `companies/${companyId}/documents/${documentId}/versions/1/original.pdf`;
      await admin.storedDocument.create({
        data: {
          id: documentId,
          companyId,
          kind: 'expense_receipt',
          origin: 'ocr',
          status: 'active',
          filename: `${documentId}.pdf`,
          mimeType: 'application/pdf',
          byteSize: 128,
          sha256,
          storageKey,
          folderId: null,
          revision: 1,
          linkedEntityType: null,
          linkedEntityId: null,
          documentDate: '2026-07-13',
          issuedAt: null,
          createdAt: new Date(now),
          createdBy: 'postgres-cert',
          retentionUntil: '2036-07-13',
          deletedAt: null,
          tags: [],
          versions: {
            create: {
              id: `${documentId}:version:1`,
              version: 1,
              storageKey,
              sha256,
              mimeType: 'application/pdf',
              byteSize: 128,
              createdAt: new Date(now),
              reason: 'original',
            },
          },
        },
      });
    }
    const chart = createFrenchOperationalChartOfAccounts(companyId);
    if (!chart.ok) throw new Error(`Plan comptable de certification invalide: ${JSON.stringify(chart.error)}`);
    const persistence = new PrismaPersistence(workers[0]!);
    await persistence.runWithTenant(companyId, () => persistence.chartOfAccounts.save(chart.value));
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.expenseCreationRequest.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.accountingEntry.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.storedDocument.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.documentFolderDeletionPlan.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.documentFolder.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.accountingAccount.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.expense.deleteMany({ where: { companyId } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: companyId } }).catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  it('fait converger deux transactions ayant déjà écrit Expense + E1 avant le claim', async () => {
    let waiting = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const attempt = async (worker: PrismaService, expenseId: string, entryId: string): Promise<string> => {
      const store = new PrismaExpenseCreationRequestStore(worker);
      try {
        return await worker.withTenant(companyId, async (tx) => {
          await tx.expense.create({
            data: {
              id: expenseId,
              companyId,
              supplierName: 'Cedeo',
              documentDate: '2026-07-13',
              totalTtcCents: 18_490,
              vatCents: 3_082,
              vatRatePct: 20,
              category: 'fournitures',
              source: 'ocr',
            },
          });
          await tx.accountingEntry.create({
            data: {
              id: entryId,
              companyId,
              journal: 'purchases',
              sourceType: 'expense',
              sourceId: expenseId,
              entryDate: '2026-07-13',
              reference: expenseId,
              label: 'Achat Cedeo',
            },
          });
          waiting += 1;
          if (waiting === 2) release();
          await gate;
          const winner = await store.putIfAbsent({
            companyId,
            keyHash,
            payloadHash,
            expenseId,
            createdAt: '2026-07-13T12:00:00.000Z',
          });
          if (winner.expenseId !== expenseId) throw new ConcurrentCandidateLost();
          return expenseId;
        });
      } catch (cause) {
        if (!(cause instanceof ConcurrentCandidateLost)) throw cause;
        const winner = await worker.withTenant(companyId, () => store.find({ companyId, keyHash }));
        if (!winner) throw new Error('Concurrent winner not visible after loser rollback.');
        return winner.expenseId;
      }
    };

    const [first, second] = await Promise.all([
      attempt(workers[0]!, expenseIds[0]!, entryIds[0]!),
      attempt(workers[1]!, expenseIds[1]!, entryIds[1]!),
    ]);
    expect(second).toBe(first);
    expect(await admin.expense.count({ where: { id: { in: expenseIds } } })).toBe(1);
    expect(await admin.accountingEntry.count({ where: { id: { in: entryIds } } })).toBe(1);
    await expect(workers[0]!.withTenant(companyId, () =>
      new PrismaExpenseCreationRequestStore(workers[0]!).find({ companyId, keyHash })))
      .resolves.toMatchObject({ expenseId: first, payloadHash });
  }, 30_000);

  it("certifie FORCE RLS, l'absence de clé brute et l'immutabilité runtime", async () => {
    const [role] = await workers[0]!.$queryRaw<Array<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      canUpdate: boolean;
      canDelete: boolean;
    }>>`
      SELECT rolsuper,
             rolbypassrls,
             has_table_privilege(current_user, 'public.expense_creation_requests', 'UPDATE') AS "canUpdate",
             has_table_privilege(current_user, 'public.expense_creation_requests', 'DELETE') AS "canDelete"
        FROM pg_roles
       WHERE rolname = current_user
    `;
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      canUpdate: false,
      canDelete: false,
    });
    const [shape] = await admin.$queryRaw<Array<{ rowSecurity: boolean; forceRowSecurity: boolean }>>`
      SELECT relrowsecurity AS "rowSecurity", relforcerowsecurity AS "forceRowSecurity"
        FROM pg_class WHERE oid = 'expense_creation_requests'::regclass
    `;
    expect(shape).toEqual({ rowSecurity: true, forceRowSecurity: true });
    const columns = await admin.$queryRaw<Array<{ columnName: string }>>`
      SELECT column_name AS "columnName"
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'expense_creation_requests'
    `;
    expect(columns.map((column) => column.columnName)).toEqual(expect.arrayContaining([
      'companyId', 'keyHash', 'payloadHash', 'expenseId', 'createdAt',
    ]));
    expect(columns.map((column) => column.columnName)).not.toContain('idempotencyKey');
    await expect(workers[0]!.withTenant(companyId, (tx) => tx.expenseCreationRequest.update({
      where: { expense_creation_request_key: { companyId, keyHash } },
      data: { payloadHash: 'c'.repeat(64) },
    }))).rejects.toThrow();
    await expect(workers[0]!.withTenant(companyId, (tx) => tx.expenseCreationRequest.delete({
      where: { expense_creation_request_key: { companyId, keyHash } },
    }))).rejects.toThrow();
    await expect(workers[0]!.withTenant('another-tenant', () =>
      new PrismaExpenseCreationRequestStore(workers[0]!).find({ companyId: 'another-tenant', keyHash })))
      .resolves.toBeNull();
  });

  it('fait converger deux workflows document → dépense complets puis rejoue le même résultat', async () => {
    const idempotencyKey = `mobile:document-expense:v1:${workflowDocumentSha256}`;
    const expense = expenseInput(idempotencyKey);
    const firstPersistence = new PrismaPersistence(workers[0]!);
    const secondPersistence = new PrismaPersistence(workers[1]!);
    const firstCoordinator = coordinator(workers[0]!, workflowExpenseIds[0]!);
    const secondCoordinator = coordinator(workers[1]!, workflowExpenseIds[1]!);

    const [first, second] = await Promise.all([
      firstCoordinator.execute(
        { companyId, expense },
        classifyDocumentInSameRoot(firstPersistence, { documentId: workflowDocumentId, expectedRevision: 1 }),
      ),
      secondCoordinator.execute(
        { companyId, expense },
        classifyDocumentInSameRoot(secondPersistence, { documentId: workflowDocumentId, expectedRevision: 1 }),
      ),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Les deux workflows concurrents doivent converger.');
    expect(second.value.expenseId).toBe(first.value.expenseId);
    expect([first.value.created, second.value.created].filter(Boolean)).toHaveLength(1);
    expect(await admin.expense.count({ where: { id: { in: workflowExpenseIds } } })).toBe(1);
    expect(await admin.accountingEntry.count({
      where: { companyId, sourceType: 'expense', sourceId: { in: workflowExpenseIds } },
    })).toBe(1);
    const fingerprint = expenseCreationFingerprint(companyId, expense);
    expect(fingerprint).not.toBeNull();
    if (!fingerprint) throw new Error('Une clé de workflow doit produire une empreinte.');
    expect(await admin.expenseCreationRequest.count({
      where: { companyId, keyHash: fingerprint.keyHash, expenseId: first.value.expenseId },
    })).toBe(1);
    await expect(firstPersistence.runWithTenant(
      companyId,
      () => firstPersistence.documents.findById(companyId, workflowDocumentId),
    )).resolves.toMatchObject({
      folderId: targetFolderId,
      // Rangement (+1) + validation humaine posée par le rangement (+1) = 3, puis
      // classement du lien dépense (+1, le doc est déjà validé) = 4.
      revision: 4,
    });

    const replay = await firstCoordinator.execute(
      { companyId, expense },
      classifyDocumentInSameRoot(firstPersistence, { documentId: workflowDocumentId, expectedRevision: 1 }),
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error('Le replay exact doit réussir.');
    expect(replay.value).toMatchObject({
      expenseId: first.value.expenseId,
      created: false,
      accounting: { created: false },
      followUp: {
        id: workflowDocumentId,
        folderId: targetFolderId,
        revision: 4,
        linkedEntityType: 'expense',
        linkedEntityId: first.value.expenseId,
      },
    });
    expect(await admin.expense.count({ where: { id: { in: workflowExpenseIds } } })).toBe(1);
    expect(await admin.accountingEntry.count({
      where: { companyId, sourceType: 'expense', sourceId: first.value.expenseId },
    })).toBe(1);
  }, 30_000);

  it('rollback dépense, écriture, claim et déplacement si la classification CAS échoue', async () => {
    const expense = expenseInput(`mobile:document-expense:v1:${rollbackDocumentSha256}`);
    const persistence = new PrismaPersistence(workers[0]!);
    const result = await coordinator(workers[0]!, rollbackExpenseId).execute(
      { companyId, expense },
      classifyDocumentInSameRoot(persistence, {
        documentId: rollbackDocumentId,
        expectedRevision: 1,
        forceClassificationConflict: true,
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: 'conflict', entity: 'document' }),
    });
    expect(await admin.expense.count({ where: { id: rollbackExpenseId } })).toBe(0);
    expect(await admin.accountingEntry.count({
      where: { companyId, sourceType: 'expense', sourceId: rollbackExpenseId },
    })).toBe(0);
    const fingerprint = expenseCreationFingerprint(companyId, expense);
    expect(fingerprint).not.toBeNull();
    if (!fingerprint) throw new Error('Une clé de workflow doit produire une empreinte.');
    expect(await admin.expenseCreationRequest.count({
      where: { companyId, keyHash: fingerprint.keyHash },
    })).toBe(0);
    expect(await admin.storedDocument.findUnique({ where: { id: rollbackDocumentId } })).toMatchObject({
      folderId: null,
      revision: 1,
      linkedEntityType: null,
      linkedEntityId: null,
    });
  }, 30_000);
});
