import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  fingerprintMistralConversationPersistenceKey,
  MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE,
  PrismaMistralConversationKeyVersionAuthority,
} from './mistral-conversation-key-version.prisma';
import { BOB_LIVE_SUBJECT_HMAC_KEY_SPACE } from './mistral-conversation-subject-key-version.prisma';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_MISTRAL_CONVERSATION_CERT === 'true';
const FEATURE_ENABLED =
  process.env.BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED === 'true';

function configuredSecrets(): ReadonlyMap<number, Uint8Array> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(process.env.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING ?? '');
  } catch {
    throw new Error('Le keyring Mistral de certification est invalide.');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Le keyring Mistral de certification est absent.');
  }
  const secrets = new Map<number, Uint8Array>();
  for (const [rawVersion, rawSecret] of Object.entries(decoded)) {
    const version = Number(rawVersion);
    if (!Number.isInteger(version) || typeof rawSecret !== 'string') {
      throw new Error('Le keyring Mistral de certification est mal formé.');
    }
    const secret = new Uint8Array(Buffer.from(rawSecret, 'base64url'));
    if (secret.byteLength !== 32) {
      throw new Error('Une clé Mistral de certification n’a pas 32 octets.');
    }
    secrets.set(version, secret);
  }
  return secrets;
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live Mistral — certification PostgreSQL non mutante du registre de clés',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const currentVersion = Number(
      process.env.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION ?? Number.NaN,
    );
    let admin: PrismaClient;
    let worker: PrismaService;
    let adminRoleName: string;
    let runtimeRoleName: string;

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      if (FEATURE_ENABLED && (!Number.isInteger(currentVersion) || currentVersion < 1)) {
        throw new Error('La version de clé Mistral active est requise pour la certification.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      worker = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([admin.$connect(), worker.$connect()]);
      const [[adminIdentity], [runtimeIdentity]] = await Promise.all([
        admin.$queryRaw<Array<{ roleName: string }>>`
          SELECT current_user::text AS "roleName"
        `,
        worker.$queryRaw<Array<{ roleName: string }>>`
          SELECT current_user::text AS "roleName"
        `,
      ]);
      if (!adminIdentity?.roleName || !runtimeIdentity?.roleName) {
        throw new Error('Les rôles PostgreSQL de certification sont introuvables.');
      }
      adminRoleName = adminIdentity.roleName;
      runtimeRoleName = runtimeIdentity.roleName;
      if (adminRoleName === runtimeRoleName) {
        throw new Error('DIRECT_URL doit utiliser un rôle distinct du rôle runtime.');
      }
    }, 30_000);

    afterAll(async () => {
      await Promise.allSettled([worker?.$disconnect(), admin?.$disconnect()]);
    });

    it('certifie registres persistants, FORCE RLS et rôle runtime strictement read-only', async () => {
      const tables = await worker.$queryRaw<Array<{
        tableName: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
        canTruncate: boolean;
        canReferences: boolean;
        canTrigger: boolean;
        runtimeOwnsTable: boolean;
        runtimeInheritsOwner: boolean;
        persistence: string;
        publicGrantCount: bigint;
      }>>`
        SELECT table_class.relname AS "tableName",
               role.rolsuper,
               role.rolbypassrls,
               table_class.relrowsecurity AS "rowSecurity",
               table_class.relforcerowsecurity AS "forceRowSecurity",
               has_table_privilege(current_user, table_class.oid, 'SELECT') AS "canSelect",
               has_table_privilege(current_user, table_class.oid, 'INSERT') AS "canInsert",
               has_table_privilege(current_user, table_class.oid, 'UPDATE') AS "canUpdate",
               has_table_privilege(current_user, table_class.oid, 'DELETE') AS "canDelete",
               has_table_privilege(current_user, table_class.oid, 'TRUNCATE') AS "canTruncate",
               has_table_privilege(current_user, table_class.oid, 'REFERENCES') AS "canReferences",
               has_table_privilege(current_user, table_class.oid, 'TRIGGER') AS "canTrigger",
               role.oid = table_class.relowner AS "runtimeOwnsTable",
               pg_has_role(role.oid, table_class.relowner, 'MEMBER') AS "runtimeInheritsOwner",
               table_class.relpersistence::text AS persistence,
               (
                 SELECT count(*)
                   FROM aclexplode(
                     COALESCE(table_class.relacl, acldefault('r', table_class.relowner))
                   ) AS privilege
                  WHERE privilege.grantee = 0
               ) AS "publicGrantCount"
          FROM pg_roles AS role
          CROSS JOIN pg_class AS table_class
         WHERE role.rolname = current_user
           AND table_class.oid IN (
             'realtime_mistral_conversation_key_version_floors'::regclass,
             'realtime_mistral_conversation_key_bindings'::regclass
           )
         ORDER BY table_class.relname
      `;
      const expectedTable = {
        rolsuper: false,
        rolbypassrls: false,
        rowSecurity: true,
        forceRowSecurity: true,
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
        canReferences: false,
        canTrigger: false,
        runtimeOwnsTable: false,
        runtimeInheritsOwner: false,
        persistence: 'p',
        publicGrantCount: 0n,
      };
      expect(tables).toEqual([
        {
          tableName: 'realtime_mistral_conversation_key_bindings',
          ...expectedTable,
        },
        {
          tableName: 'realtime_mistral_conversation_key_version_floors',
          ...expectedTable,
        },
      ]);

      const [shape] = await worker.$queryRaw<Array<{
        floorCount: bigint;
        invalidFloorKeySpaceCount: bigint;
        invalidBindingKeySpaceCount: bigint;
      }>>`
        SELECT (
                 SELECT count(*)
                   FROM realtime_mistral_conversation_key_version_floors
               ) AS "floorCount",
               (
                 SELECT count(*)
                   FROM realtime_mistral_conversation_key_version_floors
                  WHERE "keySpace" NOT IN (
                    ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE},
                    ${BOB_LIVE_SUBJECT_HMAC_KEY_SPACE}
                  )
               ) AS "invalidFloorKeySpaceCount",
               (
                 SELECT count(*)
                   FROM realtime_mistral_conversation_key_bindings
                  WHERE "keySpace" NOT IN (
                    ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE},
                    ${BOB_LIVE_SUBJECT_HMAC_KEY_SPACE}
                  )
               ) AS "invalidBindingKeySpaceCount"
      `;
      expect(shape).toMatchObject({
        invalidFloorKeySpaceCount: 0n,
        invalidBindingKeySpaceCount: 0n,
      });
      expect(Number(shape?.floorCount ?? -1n)).toBeLessThanOrEqual(2);
      if (FEATURE_ENABLED) expect(shape?.floorCount).toBe(2n);
    });

    it('certifie migration, contraintes validées et policies bornées au rôle DIRECT_URL', async () => {
      const [migration] = await admin.$queryRaw<Array<{
        finished: boolean;
        rolledBack: boolean;
      }>>`
        SELECT "finished_at" IS NOT NULL AS finished,
               "rolled_back_at" IS NOT NULL AS "rolledBack"
          FROM _prisma_migrations
         WHERE migration_name = '20260719020000_mistral_conversation_key_version_floor'
      `;
      expect(migration).toEqual({ finished: true, rolledBack: false });

      const constraints = await admin.$queryRaw<Array<{
        tableName: string;
        constraintName: string;
        validated: boolean;
      }>>`
        SELECT table_class.relname AS "tableName",
               constraint_record.conname AS "constraintName",
               constraint_record.convalidated AS validated
          FROM pg_constraint AS constraint_record
          JOIN pg_class AS table_class ON table_class.oid = constraint_record.conrelid
         WHERE constraint_record.conrelid IN (
           'realtime_mistral_conversation_key_version_floors'::regclass,
           'realtime_mistral_conversation_key_bindings'::regclass
         )
         ORDER BY table_class.relname, constraint_record.conname
      `;
      expect(constraints).toEqual([
        {
          tableName: 'realtime_mistral_conversation_key_bindings',
          constraintName: 'mistral_key_binding_fingerprint_key',
          validated: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_bindings',
          constraintName: 'mistral_key_binding_key_space_check',
          validated: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_bindings',
          constraintName: 'mistral_key_binding_pkey',
          validated: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_bindings',
          constraintName: 'mistral_key_binding_value_check',
          validated: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_version_floors',
          constraintName: 'mistral_key_floor_key_space_check',
          validated: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_version_floors',
          constraintName: 'mistral_key_floor_pkey',
          validated: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_version_floors',
          constraintName: 'mistral_key_floor_timestamps_check',
          validated: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_version_floors',
          constraintName: 'mistral_key_floor_version_check',
          validated: true,
        },
      ]);

      const policies = await admin.$queryRaw<Array<{
        tableName: string;
        policyName: string;
        command: string;
        appliesToPublic: boolean;
        appliesToDirectRole: boolean;
      }>>`
        SELECT table_class.relname AS "tableName",
               policy.polname AS "policyName",
               policy.polcmd::text AS command,
               0::oid = ANY(policy.polroles) AS "appliesToPublic",
               current_user::regrole::oid = ANY(policy.polroles) AS "appliesToDirectRole"
          FROM pg_policy AS policy
          JOIN pg_class AS table_class ON table_class.oid = policy.polrelid
         WHERE policy.polrelid IN (
           'realtime_mistral_conversation_key_version_floors'::regclass,
           'realtime_mistral_conversation_key_bindings'::regclass
         )
         ORDER BY table_class.relname, policy.polname
      `;
      expect(policies).toEqual([
        {
          tableName: 'realtime_mistral_conversation_key_bindings',
          policyName: 'realtime_mistral_conversation_key_binding_direct_insert',
          command: 'a',
          appliesToPublic: false,
          appliesToDirectRole: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_bindings',
          policyName: 'realtime_mistral_conversation_key_binding_select',
          command: 'r',
          appliesToPublic: true,
          appliesToDirectRole: false,
        },
        {
          tableName: 'realtime_mistral_conversation_key_version_floors',
          policyName: 'realtime_mistral_conversation_key_version_floor_direct_insert',
          command: 'a',
          appliesToPublic: false,
          appliesToDirectRole: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_version_floors',
          policyName: 'realtime_mistral_conversation_key_version_floor_direct_update',
          command: 'w',
          appliesToPublic: false,
          appliesToDirectRole: true,
        },
        {
          tableName: 'realtime_mistral_conversation_key_version_floors',
          policyName: 'realtime_mistral_conversation_key_version_floor_select',
          command: 'r',
          appliesToPublic: true,
          appliesToDirectRole: false,
        },
      ]);
    });

    it('certifie chaque trigger sur sa table et sa fonction sans EXECUTE public', async () => {
      const triggers = await admin.$queryRaw<Array<{
        triggerName: string;
        tableSchema: string;
        tableName: string;
        functionSchema: string;
        functionName: string;
        enabled: string;
        triggerType: number;
        definition: string;
      }>>`
        SELECT trigger.tgname AS "triggerName",
               table_namespace.nspname AS "tableSchema",
               table_class.relname AS "tableName",
               function_namespace.nspname AS "functionSchema",
               procedure.proname AS "functionName",
               trigger.tgenabled::text AS enabled,
               trigger.tgtype::integer AS "triggerType",
               pg_get_triggerdef(trigger.oid) AS definition
          FROM pg_trigger AS trigger
          JOIN pg_class AS table_class ON table_class.oid = trigger.tgrelid
          JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
          JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
          JOIN pg_namespace AS function_namespace
            ON function_namespace.oid = procedure.pronamespace
         WHERE NOT trigger.tgisinternal
           AND trigger.tgname IN (
             'realtime_mistral_conversation_key_version_floor_guard',
             'realtime_mistral_conversation_key_version_floor_truncate_guard',
             'realtime_mistral_conversation_key_binding_guard',
             'realtime_mistral_conversation_key_binding_truncate_guard',
             '00_realtime_mistral_conversation_outbox_key_version_guard',
             '00_realtime_mistral_conversation_command_key_version_guard'
           )
         ORDER BY trigger.tgname
      `;
      expect(triggers).toHaveLength(6);
      const byName = new Map(triggers.map((trigger) => [trigger.triggerName, trigger]));
      const expectTrigger = (
        name: string,
        tableName: string,
        functionName: string,
        triggerType: number,
        fragments: readonly string[],
      ) => {
        const trigger = byName.get(name);
        expect(trigger).toMatchObject({
          tableSchema: 'public',
          tableName,
          functionSchema: 'public',
          functionName,
          enabled: 'O',
          triggerType,
        });
        for (const fragment of fragments) expect(trigger?.definition).toContain(fragment);
      };
      expectTrigger(
        '00_realtime_mistral_conversation_command_key_version_guard',
        'realtime_mistral_conversation_commands',
        'enforce_mistral_conversation_persistence_key_range',
        7,
        ['BEFORE INSERT', 'FOR EACH ROW'],
      );
      expectTrigger(
        '00_realtime_mistral_conversation_outbox_key_version_guard',
        'realtime_mistral_conversation_outbox',
        'enforce_mistral_conversation_persistence_key_range',
        7,
        ['BEFORE INSERT', 'FOR EACH ROW'],
      );
      expectTrigger(
        'realtime_mistral_conversation_key_binding_guard',
        'realtime_mistral_conversation_key_bindings',
        'enforce_mistral_conversation_key_binding_append_only',
        27,
        ['BEFORE', 'DELETE', 'UPDATE', 'FOR EACH ROW'],
      );
      expectTrigger(
        'realtime_mistral_conversation_key_binding_truncate_guard',
        'realtime_mistral_conversation_key_bindings',
        'enforce_mistral_conversation_key_binding_append_only',
        34,
        ['BEFORE TRUNCATE', 'FOR EACH STATEMENT'],
      );
      expectTrigger(
        'realtime_mistral_conversation_key_version_floor_guard',
        'realtime_mistral_conversation_key_version_floors',
        'enforce_mistral_conversation_key_version_floor',
        27,
        ['BEFORE', 'DELETE', 'UPDATE', 'FOR EACH ROW'],
      );
      expectTrigger(
        'realtime_mistral_conversation_key_version_floor_truncate_guard',
        'realtime_mistral_conversation_key_version_floors',
        'enforce_mistral_conversation_key_version_floor',
        34,
        ['BEFORE TRUNCATE', 'FOR EACH STATEMENT'],
      );

      const functions = await admin.$queryRaw<Array<{
        functionName: string;
        namespaceName: string;
        ownerName: string;
        runtimeInheritsOwner: boolean;
        returnType: string;
        argumentCount: number;
        securityDefiner: boolean;
        configuration: string[] | null;
      }>>`
        SELECT procedure.proname AS "functionName",
               namespace.nspname AS "namespaceName",
               owner.rolname AS "ownerName",
               pg_has_role(${runtimeRoleName}, owner.oid, 'MEMBER') AS "runtimeInheritsOwner",
               procedure.prorettype::regtype::text AS "returnType",
               procedure.pronargs::integer AS "argumentCount",
               procedure.prosecdef AS "securityDefiner",
               procedure.proconfig AS configuration
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
          JOIN pg_roles AS owner ON owner.oid = procedure.proowner
         WHERE procedure.proname IN (
           'enforce_mistral_conversation_key_binding_append_only',
           'enforce_mistral_conversation_key_version_floor',
           'enforce_mistral_conversation_persistence_key_range'
         )
           AND namespace.nspname = 'public'
         ORDER BY procedure.proname
      `;
      expect(functions).toEqual([
        {
          functionName: 'enforce_mistral_conversation_key_binding_append_only',
          namespaceName: 'public',
          ownerName: adminRoleName,
          runtimeInheritsOwner: false,
          returnType: 'trigger',
          argumentCount: 0,
          securityDefiner: false,
          configuration: ['search_path=pg_catalog, public'],
        },
        {
          functionName: 'enforce_mistral_conversation_key_version_floor',
          namespaceName: 'public',
          ownerName: adminRoleName,
          runtimeInheritsOwner: false,
          returnType: 'trigger',
          argumentCount: 0,
          securityDefiner: false,
          configuration: ['search_path=pg_catalog, public'],
        },
        {
          functionName: 'enforce_mistral_conversation_persistence_key_range',
          namespaceName: 'public',
          ownerName: adminRoleName,
          runtimeInheritsOwner: false,
          returnType: 'trigger',
          argumentCount: 0,
          securityDefiner: false,
          configuration: ['search_path=pg_catalog, public'],
        },
      ]);

      const [publicExecution] = await admin.$queryRaw<Array<{ grantCount: bigint }>>`
        SELECT count(*) AS "grantCount"
          FROM pg_proc AS procedure
          CROSS JOIN LATERAL aclexplode(
            COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
          ) AS privilege
         WHERE procedure.proname IN (
           'enforce_mistral_conversation_key_binding_append_only',
           'enforce_mistral_conversation_key_version_floor',
           'enforce_mistral_conversation_persistence_key_range'
         )
           AND procedure.pronamespace = 'public'::regnamespace
           AND procedure.pronargs = 0
           AND procedure.prorettype = 'trigger'::regtype
           AND privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
      `;
      expect(publicExecution?.grantCount).toBe(0n);
    });

    it('valide la version configurée sans aucune écriture lorsque le canary est actif', async () => {
      if (!FEATURE_ENABLED) return;
      const currentSecret = configuredSecrets().get(currentVersion);
      if (!currentSecret) {
        throw new Error('La clé Mistral active manque au keyring de certification.');
      }
      const authority = new PrismaMistralConversationKeyVersionAuthority(
        worker,
        currentVersion,
        currentSecret,
      );
      await expect(authority.assertCurrentVersion()).resolves.toBeUndefined();
    });

    it('certifie en lecture seule que le keyring couvre la plage et tous les chiffrés retenus', async () => {
      if (!FEATURE_ENABLED) return;
      const [range] = await worker.$queryRaw<Array<{
        minimumVersion: number;
        highestVersion: number;
      }>>`
        SELECT "minimumVersion", "highestVersion"
          FROM realtime_mistral_conversation_key_version_floors
         WHERE "keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
      `;
      expect(range).toBeDefined();

      const retained = await worker.$queryRaw<Array<{ version: number }>>`
        SELECT DISTINCT version
          FROM (
            SELECT "encryptionKeyVersion" AS version
              FROM realtime_mistral_conversation_outbox
            UNION
            SELECT "proofKeyVersion" AS version
              FROM realtime_mistral_conversation_commands
          ) AS retained_versions
         ORDER BY version
      `;
      const bindings = await worker.$queryRaw<Array<{
        keyVersion: number;
        keyFingerprint: string;
      }>>`
        SELECT "keyVersion", "keyFingerprint"
          FROM realtime_mistral_conversation_key_bindings
         WHERE "keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
      `;
      const secrets = configuredSecrets();
      const committed = new Map(
        bindings.map((binding) => [binding.keyVersion, binding.keyFingerprint]),
      );
      const requiredVersions = new Set([
        currentVersion,
        range!.minimumVersion,
        range!.highestVersion,
        ...retained.map((row) => row.version),
      ]);
      for (const version of requiredVersions) {
        const secret = secrets.get(version);
        expect(secret, `keyring version ${version}`).toBeDefined();
        expect(committed.get(version), `durable binding ${version}`).toBe(
          fingerprintMistralConversationPersistenceKey(secret!),
        );
      }
    });
  },
);
