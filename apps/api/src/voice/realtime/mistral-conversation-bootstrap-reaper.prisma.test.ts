import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { MistralConversationBootstrapReaperUnavailableError } from './mistral-conversation-bootstrap-reaper';
import { PrismaMistralConversationBootstrapReaper } from './mistral-conversation-bootstrap-reaper.prisma';

const readyRow = Object.freeze({
  currentRole: 'bob_app',
  sessionRole: 'bob_app',
  runtimeSuperuser: false,
  runtimeBypassRls: false,
  runtimeCreateRole: false,
  runtimeCreateDb: false,
  runtimeReplication: false,
  runtimeCanDelete: false,
  runtimeCanTruncate: false,
  runtimeIsReaperMember: false,
  runtimeCanSetReaper: false,
  reaperSuperuser: false,
  reaperBypassRls: false,
  reaperCanLogin: false,
  reaperCreateRole: false,
  reaperCreateDb: false,
  reaperReplication: false,
  reaperInherit: false,
  canExecuteOrderedRetention: true,
  canExecuteLegacyBootstrapRetention: true,
  functionsPublicExecutable: false,
  functionsAclExact: true,
  publicCanAccessScopedTables: false,
  exactScopedPrivileges: true,
  canAccessSeparateRetention: false,
  canUseSchema: true,
  canCreateSchema: false,
  allTablesRlsEnabled: true,
  allTablesRlsForced: true,
  ownsScopedTable: false,
  ownsOrderedFunction: true,
  ownsLegacyFunction: true,
  ownsUnexpectedObject: false,
  hasParentMembership: false,
  orderedFunctionSecurityDefiner: true,
  legacyFunctionSecurityDefiner: true,
  orderedFunctionConfigHardened: true,
  legacyFunctionConfigHardened: true,
});

const validPurgeRow = Object.freeze({
  missionsPurged: 5,
  bootstrapsPurged: 7,
  resumeTicketsPurged: 4,
  commandsPurged: 11,
  outboxEventsPurged: 17,
  lockSkipped: 1,
  admissionBlocked: 2,
  invariantBlocked: 3,
  terminalizationBlocked: false,
  eligibleRootsRemain: true,
  expiredRowsRemain: true,
});

function sqlText(input: unknown): string {
  if (input && typeof input === 'object' && 'strings' in input) {
    return (input as Prisma.Sql).strings.join('?');
  }
  return String(input);
}

function harness(query: (sql: string) => unknown) {
  const executeRaw = vi.fn(async (_statement: unknown) => 0);
  const queryRaw = vi.fn(async (statement: unknown) => query(sqlText(statement)));
  const transaction = vi.fn(async (
    operation: (tx: { $executeRaw: typeof executeRaw; $queryRaw: typeof queryRaw }) => Promise<unknown>,
  ) => operation({ $executeRaw: executeRaw, $queryRaw: queryRaw }));
  const reaper = new PrismaMistralConversationBootstrapReaper({
    $transaction: transaction,
  } as unknown as Pick<PrismaClient, '$transaction'>);
  return { reaper, executeRaw, queryRaw, transaction };
}

describe('Mistral conversation bootstrap reaper — adapter Prisma', () => {
  it('prouve la frontière SECURITY DEFINER sans membership depuis le runtime', async () => {
    const h = harness(() => [readyRow]);

    await expect(h.reaper.assertReady()).resolves.toBeUndefined();

    expect(h.executeRaw).not.toHaveBeenCalled();
    const readinessSql = sqlText(h.queryRaw.mock.calls[0]?.[0]);
    expect(readinessSql).toContain('scoped_tables');
    expect(readinessSql).toContain('scoped_relations');
    expect(readinessSql).toContain('expected_select');
    expect(readinessSql).toContain('LEFT JOIN scoped_columns');
    expect(readinessSql).toContain("scope.\"tableName\" <> 'realtime_session_leases'");
    expect(readinessSql).toContain("'TRUNCATE'");
    expect(readinessSql).toContain("'public', 'USAGE'");
    expect(readinessSql).toContain('realtime_mistral_conversation_terminal_receipts');
    expect(readinessSql).toContain("'subjectHash'");
    expect(readinessSql).toContain("'closedAt'");
    expect(readinessSql).not.toContain("'createdAt'");
    expect(readinessSql).toContain('realtime_speech_artifacts');
    expect(readinessSql).toContain('has_any_column_privilege');
    expect(readinessSql).toContain('purge_realtime_mistral_conversation_retention');
    expect(readinessSql).toContain('relforcerowsecurity');
    expect(readinessSql).toContain('pg_catalog.pg_shdepend');
    expect(readinessSql).toContain('ownership.dbid');
    expect(readinessSql).toContain('current_database()');
    expect(readinessSql).toContain('ownership.objsubid = 0');
    expect(readinessSql).toContain('pg_catalog.pg_auth_members');
    expect(readinessSql).toContain('pg_has_role');
    expect(readinessSql).toContain("'MEMBER'");
    expect(readinessSql).toContain('aclexplode');
    expect(readinessSql).toContain('scoped_public_acl');
    expect(readinessSql).toContain('privilege.grantee = 0');
    expect(readinessSql).toContain('functionsAclExact');
    expect(readinessSql).toContain('prosecdef');
    expect(readinessSql).toContain('proconfig');
    expect(readinessSql).not.toContain('SET LOCAL ROLE');
    expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      maxWait: 2_000,
      timeout: 8_000,
    });
  });

  it.each([
    ['rôle effectif altéré', { currentRole: 'autre_role' }],
    ['runtime superuser', { runtimeSuperuser: true }],
    ['runtime BYPASSRLS', { runtimeBypassRls: true }],
    ['runtime CREATEROLE', { runtimeCreateRole: true }],
    ['runtime CREATEDB', { runtimeCreateDb: true }],
    ['runtime REPLICATION', { runtimeReplication: true }],
    ['runtime avec DELETE direct', { runtimeCanDelete: true }],
    ['runtime avec TRUNCATE direct', { runtimeCanTruncate: true }],
    ['runtime membre du reaper sans SET immédiat', { runtimeIsReaperMember: true }],
    ['runtime capable de SET ROLE reaper', { runtimeCanSetReaper: true }],
    ['rôle reaper superuser', { reaperSuperuser: true }],
    ['rôle reaper BYPASSRLS', { reaperBypassRls: true }],
    ['rôle reaper LOGIN', { reaperCanLogin: true }],
    ['rôle reaper CREATEROLE', { reaperCreateRole: true }],
    ['rôle reaper CREATEDB', { reaperCreateDb: true }],
    ['rôle reaper REPLICATION', { reaperReplication: true }],
    ['rôle reaper INHERIT', { reaperInherit: true }],
    ['fonction ordonnée absente', { canExecuteOrderedRetention: false }],
    ['fonction legacy absente pendant expand', { canExecuteLegacyBootstrapRetention: false }],
    ['fonction exécutable par PUBLIC', { functionsPublicExecutable: true }],
    ['ACL fonctionnelle non exacte', { functionsAclExact: false }],
    ['ACL table ou colonne ouverte à PUBLIC', { publicCanAccessScopedTables: true }],
    ['privilèges colonnes/tables inexacts', { exactScopedPrivileges: false }],
    ['accès à une rétention séparée', { canAccessSeparateRetention: true }],
    ['USAGE du schéma retiré au reaper', { canUseSchema: false }],
    ['CREATE schema indûment permis', { canCreateSchema: true }],
    ['RLS désactivée', { allTablesRlsEnabled: false }],
    ['FORCE RLS désactivée', { allTablesRlsForced: false }],
    ['rôle propriétaire d’une table', { ownsScopedTable: true }],
    ['fonction ordonnée détenue par un autre rôle', { ownsOrderedFunction: false }],
    ['fonction legacy détenue par un autre rôle', { ownsLegacyFunction: false }],
    ['rôle propriétaire d’un objet inattendu', { ownsUnexpectedObject: true }],
    ['rôle membre d’un autre rôle', { hasParentMembership: true }],
    ['fonction ordonnée sans SECURITY DEFINER', { orderedFunctionSecurityDefiner: false }],
    ['fonction legacy sans SECURITY DEFINER', { legacyFunctionSecurityDefiner: false }],
    ['config fonction ordonnée affaiblie', { orderedFunctionConfigHardened: false }],
    ['config fonction legacy affaiblie', { legacyFunctionConfigHardened: false }],
  ])('refuse au boot : %s', async (_label, override) => {
    const h = harness(() => [{ ...readyRow, ...override }]);
    await expect(h.reaper.assertReady()).rejects.toBeInstanceOf(
      MistralConversationBootstrapReaperUnavailableError,
    );
  });

  it('appelle uniquement la fonction SQL bornée puis expose le backlog sans charger les lignes', async () => {
    const h = harness((sql) => {
      expect(sql).toContain('purge_realtime_mistral_conversation_retention');
      expect(sql).toContain('invariant_blocked');
      return [validPurgeRow];
    });

    await expect(h.reaper.purgeBatch(25)).resolves.toEqual({
      purgedCount: 7,
      ...validPurgeRow,
    });
    const statement = h.queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(statement.values).toContain(25);
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, 101])(
    'rejette le batch invalide %s avant toute transaction',
    async (batchLimit) => {
      const h = harness(() => []);
      await expect(h.reaper.purgeBatch(batchLimit)).rejects.toBeInstanceOf(RangeError);
      expect(h.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { rows: [] },
    { rows: [{ ...validPurgeRow, missionsPurged: -1 }] },
    { rows: [{ ...validPurgeRow, bootstrapsPurged: 11 }] },
    { rows: [{ ...validPurgeRow, missionsPurged: 8 }] },
    { rows: [{ ...validPurgeRow, expiredRowsRemain: false }] },
    { rows: [{ ...validPurgeRow, terminalizationBlocked: 'yes' }] },
  ])('refuse une réponse SQL incohérente %#', async ({ rows }) => {
    const h = harness(() => rows);
    await expect(h.reaper.purgeBatch(10)).rejects.toBeInstanceOf(
      MistralConversationBootstrapReaperUnavailableError,
    );
  });
});
