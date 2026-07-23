import type { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  assertBobLiveSubjectHmacVersion,
  fingerprintBobLiveSubjectHmacKey,
  type BobLiveSubjectHmacKeyRingAdmission,
} from './mistral-conversation-subject-key-version';

export const BOB_LIVE_SUBJECT_HMAC_KEY_SPACE = 'bob-live-subject-hmac-v1';

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Autorité de boot du HMAC sujet Bob Live.
 *
 * Le rôle runtime ne peut que lire le registre. Le boot échoue fermé si le pipeline n'a pas
 * préparé la version courante ou si un même numéro désigne un matériau différent.
 */
export class PrismaBobLiveSubjectHmacKeyVersionAuthority {
  private readonly configuredFingerprints: ReadonlyMap<number, string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: BobLiveSubjectHmacKeyRingAdmission,
  ) {
    assertBobLiveSubjectHmacVersion(keys.currentVersion);
    if (
      !Array.isArray(keys.versions)
      || keys.versions.length < 1
      || keys.versions.length > 32
      || new Set(keys.versions).size !== keys.versions.length
      || !keys.versions.includes(keys.currentVersion)
    ) throw new Error('Bob Live subject HMAC keyring versions are invalid.');
    const fingerprints = new Map<number, string>();
    const uniqueFingerprints = new Set<string>();
    for (const version of keys.versions) {
      assertBobLiveSubjectHmacVersion(version);
      const secret = keys.secret(version);
      if (secret === null) {
        throw new Error(`Bob Live subject HMAC key version ${version} is unavailable.`);
      }
      const fingerprint = fingerprintBobLiveSubjectHmacKey(secret);
      if (uniqueFingerprints.has(fingerprint)) {
        throw new Error('Bob Live subject HMAC keyring reuses key material across versions.');
      }
      uniqueFingerprints.add(fingerprint);
      fingerprints.set(version, fingerprint);
    }
    this.configuredFingerprints = fingerprints;
  }

  async assertCurrentVersion(): Promise<void> {
    if (this.prisma.inTransaction()) {
      throw new Error('Bob Live subject HMAC admission requires a root transaction.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock_shared(
          hashtextextended(${BOB_LIVE_SUBJECT_HMAC_KEY_SPACE}, 0)
        )
      `;
      const ranges = await tx.$queryRaw<Array<{
        minimumVersion: number;
        highestVersion: number;
      }>>`
        SELECT floor."minimumVersion", floor."highestVersion"
          FROM realtime_mistral_conversation_key_version_floors AS floor
         WHERE floor."keySpace" = ${BOB_LIVE_SUBJECT_HMAC_KEY_SPACE}
      `;

      const range = ranges[0];
      if (ranges.length !== 1 || !range) {
        throw new Error(
          'Bob Live subject HMAC key range is not initialized by the release pipeline.',
        );
      }
      assertBobLiveSubjectHmacVersion(range.minimumVersion);
      assertBobLiveSubjectHmacVersion(range.highestVersion);
      if (
        range.highestVersion < range.minimumVersion
        || range.highestVersion > range.minimumVersion + 1
        || this.keys.currentVersion < range.minimumVersion
        || this.keys.currentVersion > range.highestVersion
      ) {
        throw new Error(
          `Bob Live subject HMAC key version ${this.keys.currentVersion} is outside the admitted range ${range.minimumVersion}-${range.highestVersion}.`,
        );
      }

      const admittedBindings = await tx.$queryRaw<Array<{
        keyVersion: number;
        keyFingerprint: string;
      }>>`
        SELECT binding."keyVersion", binding."keyFingerprint"::text AS "keyFingerprint"
          FROM realtime_mistral_conversation_key_bindings AS binding
         WHERE binding."keySpace" = ${BOB_LIVE_SUBJECT_HMAC_KEY_SPACE}
           AND binding."keyVersion" BETWEEN ${range.minimumVersion} AND ${range.highestVersion}
         ORDER BY binding."keyVersion"
      `;
      const expectedAdmittedCount = range.highestVersion - range.minimumVersion + 1;
      if (admittedBindings.length !== expectedAdmittedCount) {
        throw new Error('Bob Live subject HMAC admitted key bindings are incomplete.');
      }

      const retainedBindings = await tx.$queryRaw<Array<{
        keyVersion: number;
        keyFingerprint: string | null;
      }>>`
        SELECT "keyVersion", "keyFingerprint"
          FROM retained_bob_live_subject_hmac_key_bindings()
         ORDER BY "keyVersion"
      `;

      const requiredBindings = new Map<number, string | null>();
      for (const binding of [...admittedBindings, ...retainedBindings]) {
        assertBobLiveSubjectHmacVersion(binding.keyVersion);
        const previous = requiredBindings.get(binding.keyVersion);
        if (previous !== undefined && previous !== binding.keyFingerprint) {
          throw new Error(
            `Bob Live subject HMAC durable binding ${binding.keyVersion} is inconsistent.`,
          );
        }
        requiredBindings.set(binding.keyVersion, binding.keyFingerprint);
      }

      for (const [version, durableFingerprint] of requiredBindings) {
        const configuredFingerprint = this.configuredFingerprints.get(version);
        if (
          typeof durableFingerprint !== 'string'
          || !SHA256.test(durableFingerprint)
          || configuredFingerprint !== durableFingerprint
        ) {
          throw new Error(
            `Bob Live subject HMAC key material does not match durable version ${version}.`,
          );
        }
      }
    });
  }
}
