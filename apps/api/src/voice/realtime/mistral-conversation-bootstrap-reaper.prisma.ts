import { Prisma, type PrismaClient } from '@prisma/client';
import {
  MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_ROLE,
  MistralConversationBootstrapReaperUnavailableError,
  type MistralConversationBootstrapPurgeBatchResult,
  type MistralConversationBootstrapReaperPort,
} from './mistral-conversation-bootstrap-reaper';

const MIN_BATCH_LIMIT = 1;
const MAX_BATCH_LIMIT = 100;
const TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 2_000,
  timeout: 8_000,
});

interface ReaperReadinessRow {
  readonly currentRole: string;
  readonly sessionRole: string;
  readonly runtimeSuperuser: boolean;
  readonly runtimeBypassRls: boolean;
  readonly runtimeCreateRole: boolean;
  readonly runtimeCreateDb: boolean;
  readonly runtimeReplication: boolean;
  readonly runtimeCanDelete: boolean;
  readonly runtimeCanTruncate: boolean;
  readonly runtimeIsReaperMember: boolean;
  readonly runtimeCanSetReaper: boolean;
  readonly reaperSuperuser: boolean;
  readonly reaperBypassRls: boolean;
  readonly reaperCanLogin: boolean;
  readonly reaperCreateRole: boolean;
  readonly reaperCreateDb: boolean;
  readonly reaperReplication: boolean;
  readonly reaperInherit: boolean;
  readonly canExecuteOrderedRetention: boolean;
  readonly canExecuteLegacyBootstrapRetention: boolean;
  readonly functionsPublicExecutable: boolean;
  readonly functionsAclExact: boolean;
  readonly publicCanAccessScopedTables: boolean;
  readonly exactScopedPrivileges: boolean;
  readonly canAccessSeparateRetention: boolean;
  readonly canUseSchema: boolean;
  readonly canCreateSchema: boolean;
  readonly allTablesRlsEnabled: boolean;
  readonly allTablesRlsForced: boolean;
  readonly ownsScopedTable: boolean;
  readonly ownsOrderedFunction: boolean;
  readonly ownsLegacyFunction: boolean;
  readonly ownsUnexpectedObject: boolean;
  readonly hasParentMembership: boolean;
  readonly orderedFunctionSecurityDefiner: boolean;
  readonly legacyFunctionSecurityDefiner: boolean;
  readonly orderedFunctionConfigHardened: boolean;
  readonly legacyFunctionConfigHardened: boolean;
}

interface PurgeRow {
  readonly missionsPurged: number;
  readonly bootstrapsPurged: number;
  readonly resumeTicketsPurged: number;
  readonly commandsPurged: number;
  readonly outboxEventsPurged: number;
  readonly lockSkipped: number;
  readonly admissionBlocked: number;
  readonly invariantBlocked: number;
  readonly terminalizationBlocked: boolean;
  readonly eligibleRootsRemain: boolean;
  readonly expiredRowsRemain: boolean;
}

type TransactionalPrisma = Pick<PrismaClient, '$transaction'>;

function validBatchLimit(batchLimit: number): boolean {
  return Number.isInteger(batchLimit)
    && batchLimit >= MIN_BATCH_LIMIT
    && batchLimit <= MAX_BATCH_LIMIT;
}

function validPurgeRow(row: PurgeRow | undefined, batchLimit: number): row is PurgeRow {
  if (!row) return false;
  const counts = [
    row.missionsPurged,
    row.bootstrapsPurged,
    row.resumeTicketsPurged,
    row.commandsPurged,
    row.outboxEventsPurged,
    row.lockSkipped,
    row.admissionBlocked,
    row.invariantBlocked,
  ];
  return counts.every((count) => Number.isInteger(count) && count >= 0)
    && row.bootstrapsPurged <= batchLimit
    && row.missionsPurged <= row.bootstrapsPurged
    && typeof row.terminalizationBlocked === 'boolean'
    && typeof row.eligibleRootsRemain === 'boolean'
    && typeof row.expiredRowsRemain === 'boolean'
    && row.expiredRowsRemain === (row.terminalizationBlocked || row.eligibleRootsRemain);
}

function isReady(row: ReaperReadinessRow | undefined): boolean {
  if (!row) return false;
  return row.currentRole === row.sessionRole
    && row.currentRole !== MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_ROLE
    && row.runtimeSuperuser === false
    && row.runtimeBypassRls === false
    && row.runtimeCreateRole === false
    && row.runtimeCreateDb === false
    && row.runtimeReplication === false
    && row.runtimeCanDelete === false
    && row.runtimeCanTruncate === false
    && row.runtimeIsReaperMember === false
    && row.runtimeCanSetReaper === false
    && row.reaperSuperuser === false
    && row.reaperBypassRls === false
    && row.reaperCanLogin === false
    && row.reaperCreateRole === false
    && row.reaperCreateDb === false
    && row.reaperReplication === false
    && row.reaperInherit === false
    && row.canExecuteOrderedRetention === true
    && row.canExecuteLegacyBootstrapRetention === true
    && row.functionsPublicExecutable === false
    && row.functionsAclExact === true
    && row.publicCanAccessScopedTables === false
    && row.exactScopedPrivileges === true
    && row.canAccessSeparateRetention === false
    && row.canUseSchema === true
    && row.canCreateSchema === false
    && row.allTablesRlsEnabled === true
    && row.allTablesRlsForced === true
    && row.ownsScopedTable === false
    && row.ownsOrderedFunction === true
    && row.ownsLegacyFunction === true
    && row.ownsUnexpectedObject === false
    && row.hasParentMembership === false
    && row.orderedFunctionSecurityDefiner === true
    && row.legacyFunctionSecurityDefiner === true
    && row.orderedFunctionConfigHardened === true
    && row.legacyFunctionConfigHardened === true;
}

/**
 * Adapter Prisma de production. La connexion reste celle du rôle applicatif non-superuser et
 * n'est jamais membre du rôle NOLOGIN reaper. Elle ne possède que EXECUTE sur deux fonctions
 * SECURITY DEFINER étroites ; aucun URL admin ni privilège table de purge n'entre dans le process.
 */
export class PrismaMistralConversationBootstrapReaper
implements MistralConversationBootstrapReaperPort {
  constructor(private readonly prisma: TransactionalPrisma) {}

  async assertReady(): Promise<void> {
    const ready = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<ReaperReadinessRow[]>(Prisma.sql`
        WITH scoped_tables("tableName", "canDelete") AS (
          VALUES
            ('realtime_mistral_conversation_bootstrap_tickets'::text, true),
            ('realtime_mistral_conversation_missions'::text, true),
            ('realtime_mistral_conversation_terminal_receipts'::text, false),
            ('realtime_mistral_conversation_resume_tickets'::text, true),
            ('realtime_mistral_conversation_outbox'::text, true),
            ('realtime_mistral_conversation_commands'::text, true),
            ('realtime_session_leases'::text, false)
        ),
        expected_select("tableName", "columnName") AS (
          VALUES
            ('realtime_mistral_conversation_bootstrap_tickets'::text, 'id'::text),
            ('realtime_mistral_conversation_bootstrap_tickets', 'companyId'),
            ('realtime_mistral_conversation_bootstrap_tickets', 'admissionSessionId'),
            ('realtime_mistral_conversation_bootstrap_tickets', 'retentionExpiresAt'),
            ('realtime_mistral_conversation_missions', 'id'),
            ('realtime_mistral_conversation_missions', 'companyId'),
            ('realtime_mistral_conversation_missions', 'sessionHandle'),
            ('realtime_mistral_conversation_missions', 'initialBootstrapId'),
            ('realtime_mistral_conversation_missions', 'phase'),
            ('realtime_mistral_conversation_missions', 'subjectHash'),
            ('realtime_mistral_conversation_missions', 'subjectKeyVersion'),
            ('realtime_mistral_conversation_missions', 'protocol'),
            ('realtime_mistral_conversation_missions', 'missionConnectionEpoch'),
            ('realtime_mistral_conversation_missions', 'retainedFromServerSequence'),
            ('realtime_mistral_conversation_missions', 'nextServerSequence'),
            ('realtime_mistral_conversation_missions', 'terminalReason'),
            ('realtime_mistral_conversation_missions', 'closedAt'),
            ('realtime_mistral_conversation_missions', 'replayGraceExpiresAt'),
            ('realtime_mistral_conversation_missions', 'retentionExpiresAt'),
            ('realtime_mistral_conversation_terminal_receipts', 'companyId'),
            ('realtime_mistral_conversation_terminal_receipts', 'sessionHandle'),
            ('realtime_mistral_conversation_terminal_receipts', 'subjectHash'),
            ('realtime_mistral_conversation_terminal_receipts', 'subjectKeyVersion'),
            ('realtime_mistral_conversation_terminal_receipts', 'protocol'),
            ('realtime_mistral_conversation_terminal_receipts', 'missionConnectionEpoch'),
            ('realtime_mistral_conversation_terminal_receipts', 'nextServerSequence'),
            ('realtime_mistral_conversation_terminal_receipts', 'terminalReason'),
            ('realtime_mistral_conversation_terminal_receipts', 'closedAt'),
            ('realtime_mistral_conversation_resume_tickets', 'id'),
            ('realtime_mistral_conversation_resume_tickets', 'missionId'),
            ('realtime_mistral_conversation_resume_tickets', 'companyId'),
            ('realtime_mistral_conversation_resume_tickets', 'sessionHandle'),
            ('realtime_mistral_conversation_resume_tickets', 'initialBootstrapId'),
            ('realtime_mistral_conversation_resume_tickets', 'retentionExpiresAt'),
            ('realtime_mistral_conversation_outbox', 'missionId'),
            ('realtime_mistral_conversation_outbox', 'companyId'),
            ('realtime_mistral_conversation_outbox', 'sessionHandle'),
            ('realtime_mistral_conversation_outbox', 'serverSequence'),
            ('realtime_mistral_conversation_outbox', 'retentionExpiresAt'),
            ('realtime_mistral_conversation_commands', 'missionId'),
            ('realtime_mistral_conversation_commands', 'companyId'),
            ('realtime_mistral_conversation_commands', 'sessionHandle'),
            ('realtime_mistral_conversation_commands', 'retentionExpiresAt'),
            ('realtime_session_leases', 'companyId'),
            ('realtime_session_leases', 'sessionId')
        ),
        expected_update("tableName", "columnName") AS (
          VALUES
            ('realtime_mistral_conversation_bootstrap_tickets'::text, 'id'::text),
            ('realtime_mistral_conversation_missions', 'id'),
            ('realtime_mistral_conversation_resume_tickets', 'id')
        ),
        scoped_relations AS (
          SELECT target.oid, target.relname::text AS "tableName", target.relacl
            FROM pg_catalog.pg_class AS target
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
            JOIN scoped_tables AS scope ON scope."tableName" = target.relname
           WHERE namespace.nspname = 'public'
             AND target.relkind IN ('r', 'p')
        ),
        scoped_columns AS (
          SELECT target."tableName", attribute.attname::text AS "columnName"
            FROM scoped_relations AS target
            JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
           WHERE attribute.attnum > 0
             AND NOT attribute.attisdropped
        ),
        separate_retention_tables("tableName") AS (
          VALUES
            ('realtime_admission_events'::text),
            ('realtime_speech_artifacts'::text),
            ('realtime_control_grants'::text),
            ('realtime_control_consumptions'::text),
            ('realtime_voice_usage_events'::text),
            ('realtime_voice_usage_daily'::text)
        ),
        retention_functions("functionOid") AS (
          VALUES
            ('public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure),
            ('public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure)
        ),
        function_acl AS (
          SELECT target_function."functionOid", privilege.grantor, privilege.grantee,
                 privilege.privilege_type, privilege.is_grantable
            FROM retention_functions AS target_function
            JOIN pg_catalog.pg_proc AS function_record
              ON function_record.oid = target_function."functionOid"
           CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
             function_record.proacl,
             pg_catalog.acldefault('f', function_record.proowner)
           )) AS privilege
        ),
        scoped_public_acl AS (
          SELECT privilege.grantee
            FROM scoped_relations AS target
           CROSS JOIN LATERAL pg_catalog.aclexplode(target.relacl) AS privilege
           WHERE privilege.grantee = 0
          UNION ALL
          SELECT privilege.grantee
            FROM scoped_relations AS target
            JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = target.oid
           CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
           WHERE attribute.attnum > 0
             AND NOT attribute.attisdropped
             AND privilege.grantee = 0
        )
        SELECT current_user::text AS "currentRole",
               session_user::text AS "sessionRole",
               current_role_record.rolsuper AS "runtimeSuperuser",
               current_role_record.rolbypassrls AS "runtimeBypassRls",
               current_role_record.rolcreaterole AS "runtimeCreateRole",
               current_role_record.rolcreatedb AS "runtimeCreateDb",
               current_role_record.rolreplication AS "runtimeReplication",
               EXISTS (
                 SELECT 1
                   FROM scoped_tables AS scope
                  WHERE scope."tableName" <> 'realtime_session_leases'
                    AND has_table_privilege(
                      current_user,
                      format('public.%I', scope."tableName"),
                      'DELETE'
                    )
               ) AS "runtimeCanDelete",
               EXISTS (
                 SELECT 1
                   FROM scoped_tables AS scope
                  WHERE has_table_privilege(
                          current_user,
                          format('public.%I', scope."tableName"),
                          'TRUNCATE'
                        )
               ) AS "runtimeCanTruncate",
               pg_has_role(current_user, reaper_role_record.oid, 'MEMBER')
                 AS "runtimeIsReaperMember",
               pg_has_role(current_user, reaper_role_record.oid, 'SET')
                 AS "runtimeCanSetReaper",
               reaper_role_record.rolsuper AS "reaperSuperuser",
               reaper_role_record.rolbypassrls AS "reaperBypassRls",
               reaper_role_record.rolcanlogin AS "reaperCanLogin",
               reaper_role_record.rolcreaterole AS "reaperCreateRole",
               reaper_role_record.rolcreatedb AS "reaperCreateDb",
               reaper_role_record.rolreplication AS "reaperReplication",
               reaper_role_record.rolinherit AS "reaperInherit",
               has_function_privilege(
                 current_user,
                 'public.purge_realtime_mistral_conversation_retention(integer)',
                 'EXECUTE'
               ) AS "canExecuteOrderedRetention",
               has_function_privilege(
                 current_user,
                 'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)',
                 'EXECUTE'
               ) AS "canExecuteLegacyBootstrapRetention",
               EXISTS (
                 SELECT 1
                   FROM function_acl AS privilege
                  WHERE privilege.grantee = 0
               ) AS "functionsPublicExecutable",
               (
                 NOT EXISTS (
                   SELECT 1
                     FROM function_acl AS privilege
                    WHERE privilege.privilege_type <> 'EXECUTE'
                       OR privilege.grantee NOT IN (
                         reaper_role_record.oid,
                         current_role_record.oid
                       )
                       OR (
                         privilege.grantee = current_role_record.oid
                         AND (
                           privilege.grantor <> reaper_role_record.oid
                           OR privilege.is_grantable
                         )
                       )
                 )
                 AND (
                   SELECT count(DISTINCT privilege."functionOid")
                     FROM function_acl AS privilege
                    WHERE privilege.grantee = current_role_record.oid
                      AND privilege.grantor = reaper_role_record.oid
                      AND privilege.privilege_type = 'EXECUTE'
                      AND NOT privilege.is_grantable
                 ) = 2
               ) AS "functionsAclExact",
               EXISTS (
                 SELECT 1 FROM scoped_public_acl
               ) AS "publicCanAccessScopedTables",
               (
                 (SELECT count(*) FROM scoped_tables) = 7
                 AND (SELECT count(*) FROM scoped_relations) = 7
                 AND NOT EXISTS (
                   SELECT 1
                     FROM expected_select AS expected
                     LEFT JOIN scoped_columns AS scoped
                       ON scoped."tableName" = expected."tableName"
                      AND scoped."columnName" = expected."columnName"
                    WHERE scoped."columnName" IS NULL
                 )
                 AND NOT EXISTS (
                   SELECT 1
                     FROM expected_update AS expected
                     LEFT JOIN scoped_columns AS scoped
                       ON scoped."tableName" = expected."tableName"
                      AND scoped."columnName" = expected."columnName"
                    WHERE scoped."columnName" IS NULL
                 )
                 AND NOT EXISTS (
                   SELECT 1
                     FROM scoped_tables AS scope
                    WHERE has_table_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scope."tableName"),
                            'DELETE'
                          ) IS DISTINCT FROM scope."canDelete"
                       OR has_table_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scope."tableName"),
                            'SELECT'
                          )
                       OR has_table_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scope."tableName"),
                            'UPDATE'
                          )
                       OR has_table_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scope."tableName"),
                            'INSERT'
                          )
                       OR has_table_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scope."tableName"),
                            'TRUNCATE'
                          )
                       OR has_table_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scope."tableName"),
                            'REFERENCES'
                          )
                       OR has_table_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scope."tableName"),
                            'TRIGGER'
                          )
                 )
                 AND NOT EXISTS (
                   SELECT 1
                     FROM scoped_columns AS scoped
                    WHERE has_column_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scoped."tableName"),
                            scoped."columnName",
                            'SELECT'
                          ) IS DISTINCT FROM EXISTS (
                            SELECT 1
                              FROM expected_select AS expected
                             WHERE expected."tableName" = scoped."tableName"
                               AND expected."columnName" = scoped."columnName"
                          )
                       OR has_column_privilege(
                            reaper_role_record.oid,
                            format('public.%I', scoped."tableName"),
                            scoped."columnName",
                            'UPDATE'
                          ) IS DISTINCT FROM EXISTS (
                            SELECT 1
                              FROM expected_update AS expected
                             WHERE expected."tableName" = scoped."tableName"
                               AND expected."columnName" = scoped."columnName"
                          )
                 )
               ) AS "exactScopedPrivileges",
               EXISTS (
                 SELECT 1
                   FROM separate_retention_tables AS forbidden
                  WHERE has_table_privilege(
                          reaper_role_record.oid,
                          format('public.%I', forbidden."tableName"),
                          'SELECT'
                        )
                     OR has_table_privilege(
                          reaper_role_record.oid,
                          format('public.%I', forbidden."tableName"),
                          'INSERT'
                        )
                     OR has_table_privilege(
                          reaper_role_record.oid,
                          format('public.%I', forbidden."tableName"),
                          'UPDATE'
                        )
                     OR has_table_privilege(
                          reaper_role_record.oid,
                          format('public.%I', forbidden."tableName"),
                          'DELETE'
                        )
                     OR has_table_privilege(
                          reaper_role_record.oid,
                          format('public.%I', forbidden."tableName"),
                          'TRUNCATE'
                        )
                     OR has_table_privilege(
                          reaper_role_record.oid,
                          format('public.%I', forbidden."tableName"),
                          'REFERENCES'
                        )
                     OR has_table_privilege(
                          reaper_role_record.oid,
                          format('public.%I', forbidden."tableName"),
                          'TRIGGER'
                        )
                     OR has_any_column_privilege(
                          reaper_role_record.oid,
                          format('public.%I', forbidden."tableName"),
                          'SELECT,INSERT,UPDATE,REFERENCES'
                        )
               ) AS "canAccessSeparateRetention",
               has_schema_privilege(reaper_role_record.oid, 'public', 'USAGE')
                 AS "canUseSchema",
               has_schema_privilege(reaper_role_record.oid, 'public', 'CREATE')
                 AS "canCreateSchema",
               (
                 SELECT bool_and(target.relrowsecurity)
                   FROM pg_catalog.pg_class AS target
                   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
                   JOIN scoped_tables AS scope ON scope."tableName" = target.relname
                  WHERE namespace.nspname = 'public'
               ) AS "allTablesRlsEnabled",
               (
                 SELECT bool_and(target.relforcerowsecurity)
                   FROM pg_catalog.pg_class AS target
                   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
                   JOIN scoped_tables AS scope ON scope."tableName" = target.relname
                  WHERE namespace.nspname = 'public'
               ) AS "allTablesRlsForced",
               EXISTS (
                 SELECT 1
                   FROM pg_catalog.pg_class AS target
                   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = target.relnamespace
                  JOIN scoped_tables AS scope ON scope."tableName" = target.relname
                 WHERE namespace.nspname = 'public'
                    AND target.relowner = reaper_role_record.oid
               ) AS "ownsScopedTable",
               ordered_function.proowner = reaper_role_record.oid AS "ownsOrderedFunction",
               legacy_function.proowner = reaper_role_record.oid AS "ownsLegacyFunction",
               EXISTS (
                 SELECT 1
                   FROM pg_catalog.pg_shdepend AS ownership
                  WHERE ownership.refclassid = 'pg_authid'::regclass
                    AND ownership.refobjid = reaper_role_record.oid
                    AND ownership.deptype = 'o'
                    AND (
                      ownership.dbid = 0
                      OR ownership.dbid = (
                        SELECT database.oid
                          FROM pg_catalog.pg_database AS database
                         WHERE database.datname = current_database()
                      )
                    )
                    AND NOT (
                      ownership.dbid = (
                        SELECT database.oid
                          FROM pg_catalog.pg_database AS database
                         WHERE database.datname = current_database()
                      )
                      AND ownership.classid = 'pg_proc'::regclass
                      AND ownership.objid IN (ordered_function.oid, legacy_function.oid)
                      AND ownership.objsubid = 0
                    )
               ) AS "ownsUnexpectedObject",
               EXISTS (
                 SELECT 1
                   FROM pg_catalog.pg_auth_members AS membership
                  WHERE membership.member = reaper_role_record.oid
               ) AS "hasParentMembership",
               ordered_function.prosecdef AS "orderedFunctionSecurityDefiner",
               legacy_function.prosecdef AS "legacyFunctionSecurityDefiner",
               ordered_function.proconfig @> ARRAY[
                 'search_path=pg_catalog',
                 'row_security=on'
               ]::text[]
                 AND cardinality(ordered_function.proconfig) = 2
                 AS "orderedFunctionConfigHardened",
               legacy_function.proconfig @> ARRAY[
                 'search_path=pg_catalog',
                 'row_security=on'
               ]::text[]
                 AND cardinality(legacy_function.proconfig) = 2
                 AS "legacyFunctionConfigHardened"
          FROM pg_catalog.pg_roles AS current_role_record
          JOIN pg_catalog.pg_roles AS reaper_role_record
            ON reaper_role_record.rolname = 'bob_mistral_bootstrap_reaper'
          JOIN pg_catalog.pg_proc AS ordered_function
            ON ordered_function.oid =
               'public.purge_realtime_mistral_conversation_retention(integer)'::regprocedure
          JOIN pg_catalog.pg_proc AS legacy_function
            ON legacy_function.oid =
               'public.purge_realtime_mistral_conversation_bootstrap_tickets(integer)'::regprocedure
         WHERE current_role_record.rolname = current_user
      `);
      return isReady(row);
    }, TRANSACTION_OPTIONS);
    if (!ready) throw new MistralConversationBootstrapReaperUnavailableError();
  }

  async purgeBatch(batchLimit: number): Promise<MistralConversationBootstrapPurgeBatchResult> {
    if (!validBatchLimit(batchLimit)) {
      throw new RangeError('Mistral conversation retention batch must be between 1 and 100.');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<PurgeRow[]>(Prisma.sql`
        SELECT retention.missions_purged AS "missionsPurged",
               retention.bootstraps_purged AS "bootstrapsPurged",
               retention.resume_tickets_purged AS "resumeTicketsPurged",
               retention.commands_purged AS "commandsPurged",
               retention.outbox_events_purged AS "outboxEventsPurged",
               retention.lock_skipped AS "lockSkipped",
               retention.admission_blocked AS "admissionBlocked",
               retention.invariant_blocked AS "invariantBlocked",
               retention.terminalization_blocked AS "terminalizationBlocked",
               retention.eligible_roots_remain AS "eligibleRootsRemain",
               retention.expired_rows_remain AS "expiredRowsRemain"
          FROM public.purge_realtime_mistral_conversation_retention(
                 ${batchLimit}::integer
               ) AS retention
      `);
      return row;
    }, TRANSACTION_OPTIONS);
    if (!validPurgeRow(result, batchLimit)) {
      throw new MistralConversationBootstrapReaperUnavailableError();
    }
    return Object.freeze({
      purgedCount: result.bootstrapsPurged,
      missionsPurged: result.missionsPurged,
      bootstrapsPurged: result.bootstrapsPurged,
      resumeTicketsPurged: result.resumeTicketsPurged,
      commandsPurged: result.commandsPurged,
      outboxEventsPurged: result.outboxEventsPurged,
      lockSkipped: result.lockSkipped,
      admissionBlocked: result.admissionBlocked,
      invariantBlocked: result.invariantBlocked,
      terminalizationBlocked: result.terminalizationBlocked,
      eligibleRootsRemain: result.eligibleRootsRemain,
      expiredRowsRemain: result.expiredRowsRemain,
    });
  }
}
