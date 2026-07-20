import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  BOB_LIVE_SUBJECT_HMAC_KEY_SPACE,
  PrismaBobLiveSubjectHmacKeyVersionAuthority,
} from './mistral-conversation-subject-key-version.prisma';
import {
  fingerprintBobLiveSubjectHmacKey,
  type BobLiveSubjectHmacKeyRingAdmission,
} from './mistral-conversation-subject-key-version';

const RUN_POSTGRES_CERT =
  process.env.RUN_POSTGRES_MISTRAL_CONVERSATION_CERT === 'true';

function configuredSubjectKeys(): BobLiveSubjectHmacKeyRingAdmission {
  const rawVersion = process.env.BOB_LIVE_SUBJECT_KEY_VERSION ?? '1';
  const currentVersion = Number(rawVersion);
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.BOB_LIVE_SUBJECT_HMAC_KEYRING ?? '');
  } catch {
    throw new Error('Le keyring HMAC sujet de certification doit être un objet JSON valide.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Le keyring HMAC sujet de certification doit être un objet JSON.');
  }
  const secrets = parsed as Record<string, unknown>;
  const versions = Object.keys(secrets).map(Number).sort((left, right) => left - right);
  return Object.freeze({
    currentVersion,
    versions: Object.freeze(versions),
    secret: (version: number) => {
      const secret = secrets[String(version)];
      return typeof secret === 'string' ? secret : null;
    },
  });
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live — attestation PostgreSQL du keyring HMAC sujet',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let worker: PrismaService;
    let keys: BobLiveSubjectHmacKeyRingAdmission;
    let adminRoleName: string;
    let runtimeRoleName: string;

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) et DIRECT_URL (admin) sont requis.');
      }
      keys = configuredSubjectKeys();
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

    it('certifie migration, triggers, fonction minimale et privilèges fail-closed', async () => {
      const [migration] = await admin.$queryRaw<Array<{
        finished: boolean;
        rolledBack: boolean;
      }>>`
        SELECT "finished_at" IS NOT NULL AS finished,
               "rolled_back_at" IS NOT NULL AS "rolledBack"
          FROM _prisma_migrations
         WHERE migration_name = '20260719083000_mistral_conversation_subject_key_floor'
      `;
      expect(migration).toEqual({ finished: true, rolledBack: false });

      const [security] = await worker.$queryRaw<Array<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        canExecute: boolean;
        canInsertFloor: boolean;
        canUpdateFloor: boolean;
        canInsertBinding: boolean;
        canUpdateBinding: boolean;
      }>>`
        SELECT role.rolsuper,
               role.rolbypassrls,
               has_function_privilege(
                 current_user,
                 'retained_bob_live_subject_hmac_key_bindings()'::regprocedure,
                 'EXECUTE'
               ) AS "canExecute",
               has_table_privilege(
                 current_user,
                 'realtime_mistral_conversation_key_version_floors',
                 'INSERT'
               ) AS "canInsertFloor",
               has_table_privilege(
                 current_user,
                 'realtime_mistral_conversation_key_version_floors',
                 'UPDATE'
               ) AS "canUpdateFloor",
               has_table_privilege(
                 current_user,
                 'realtime_mistral_conversation_key_bindings',
                 'INSERT'
               ) AS "canInsertBinding",
               has_table_privilege(
                 current_user,
                 'realtime_mistral_conversation_key_bindings',
                 'UPDATE'
               ) AS "canUpdateBinding"
          FROM pg_roles AS role
         WHERE role.rolname = current_user
      `;
      expect(security).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        canExecute: true,
        canInsertFloor: false,
        canUpdateFloor: false,
        canInsertBinding: false,
        canUpdateBinding: false,
      });

      const [functionContract] = await admin.$queryRaw<Array<{
        securityDefiner: boolean;
        ownerName: string;
        resultType: string;
        definition: string;
        publicCanExecute: boolean;
      }>>`
        SELECT procedure.prosecdef AS "securityDefiner",
               owner.rolname AS "ownerName",
               pg_get_function_result(procedure.oid) AS "resultType",
               pg_get_functiondef(procedure.oid) AS definition,
               EXISTS (
                 SELECT 1
                   FROM aclexplode(
                     COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
                   ) AS privilege
                  WHERE privilege.grantee = 0
                    AND privilege.privilege_type = 'EXECUTE'
               ) AS "publicCanExecute"
          FROM pg_proc AS procedure
          JOIN pg_roles AS owner ON owner.oid = procedure.proowner
         WHERE procedure.oid =
           'retained_bob_live_subject_hmac_key_bindings()'::regprocedure
      `;
      expect(functionContract).toMatchObject({
        securityDefiner: true,
        ownerName: adminRoleName,
        resultType: 'TABLE("keyVersion" integer, "keyFingerprint" text)',
        publicCanExecute: false,
      });
      expect(functionContract?.ownerName).not.toBe(runtimeRoleName);
      expect(functionContract?.definition).toContain('SET row_security TO \'off\'');
      expect(functionContract?.definition).toContain(
        'realtime_mistral_conversation_terminal_receipts',
      );
      expect(functionContract?.definition).not.toMatch(/"companyId"|"subjectHash"/u);

      const keySpaceConstraints = await admin.$queryRaw<Array<{
        constraintName: string;
        definition: string;
        validated: boolean;
      }>>`
        SELECT constraint_record.conname AS "constraintName",
               pg_get_constraintdef(constraint_record.oid) AS definition,
               constraint_record.convalidated AS validated
          FROM pg_constraint AS constraint_record
         WHERE constraint_record.conname IN (
           'mistral_key_floor_key_space_check',
           'mistral_key_binding_key_space_check'
         )
         ORDER BY constraint_record.conname
      `;
      expect(keySpaceConstraints).toHaveLength(2);
      for (const constraint of keySpaceConstraints) {
        expect(constraint.validated).toBe(true);
        expect(constraint.definition).toContain('mistral-conversation-persistence-v1');
        expect(constraint.definition).toContain(BOB_LIVE_SUBJECT_HMAC_KEY_SPACE);
        expect(constraint.definition).not.toMatch(/identity|usage|control/iu);
      }

      const triggers = await admin.$queryRaw<Array<{ triggerName: string; enabled: string }>>`
        SELECT trigger_record.tgname AS "triggerName",
               trigger_record.tgenabled::text AS enabled
          FROM pg_trigger AS trigger_record
         WHERE NOT trigger_record.tgisinternal
           AND trigger_record.tgname IN (
             '00_mistral_bootstrap_00_persistence_key_order_guard',
             '01_mistral_bootstrap_subject_key_version_guard',
             '00_mistral_mission_subject_key_version_guard'
           )
         ORDER BY trigger_record.tgname
      `;
      expect(triggers).toEqual([
        { triggerName: '00_mistral_bootstrap_00_persistence_key_order_guard', enabled: 'O' },
        { triggerName: '00_mistral_mission_subject_key_version_guard', enabled: 'O' },
        { triggerName: '01_mistral_bootstrap_subject_key_version_guard', enabled: 'O' },
      ]);
    });

    it('admet le keyring exact et refuse le même numéro avec un autre matériau', async () => {
      const currentSecret = keys.secret(keys.currentVersion);
      if (!currentSecret) throw new Error('La clé sujet courante de certification est absente.');
      const [durable] = await worker.$queryRaw<Array<{
        minimumVersion: number;
        highestVersion: number;
        keyFingerprint: string;
      }>>`
        SELECT floor."minimumVersion",
               floor."highestVersion",
               binding."keyFingerprint"::text AS "keyFingerprint"
          FROM realtime_mistral_conversation_key_version_floors AS floor
          JOIN realtime_mistral_conversation_key_bindings AS binding
            ON binding."keySpace" = floor."keySpace"
           AND binding."keyVersion" = ${keys.currentVersion}
         WHERE floor."keySpace" = ${BOB_LIVE_SUBJECT_HMAC_KEY_SPACE}
      `;
      expect(durable).toMatchObject({
        minimumVersion: expect.any(Number),
        highestVersion: expect.any(Number),
        keyFingerprint: fingerprintBobLiveSubjectHmacKey(currentSecret),
      });

      const authority = new PrismaBobLiveSubjectHmacKeyVersionAuthority(worker, keys);
      await expect(authority.assertCurrentVersion()).resolves.toBeUndefined();

      const changedKeys: BobLiveSubjectHmacKeyRingAdmission = {
        currentVersion: keys.currentVersion,
        versions: keys.versions,
        secret: (version) => {
          const secret = keys.secret(version);
          return version === keys.currentVersion && secret ? `${secret}x` : secret;
        },
      };
      await expect(
        new PrismaBobLiveSubjectHmacKeyVersionAuthority(
          worker,
          changedKeys,
        ).assertCurrentVersion(),
      ).rejects.toThrow(
        `Bob Live subject HMAC key material does not match durable version ${keys.currentVersion}.`,
      );
    });
  },
);
