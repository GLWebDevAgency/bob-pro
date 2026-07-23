import type { PrismaService } from '../../persistence/prisma/prisma.service';
import type { BobLiveSubjectHmacKeyRingAdmission } from './mistral-conversation-subject-key-version';
import { PrismaBobLiveSubjectHmacKeyVersionAuthority } from './mistral-conversation-subject-key-version.prisma';
import {
  assertOpenAiNativeProofKeyVersion,
  fingerprintOpenAiNativeProofKey,
  type OpenAiNativeKeyVersionAuthorityPort,
  type OpenAiNativeProofKeyRingAdmission,
} from './openai-native-proof-key-version';

export const OPENAI_NATIVE_PROOF_HMAC_KEY_SPACE = 'openai-native-speech-proof-hmac-v1';

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Autorité de boot de la clé de preuve acoustique native.
 *
 * Le registre ne contient que des empreintes non secrètes. Le verrou partagé rend le snapshot
 * atomique vis-à-vis de stage/retire ; aucune activation ne peut observer une demi-rotation.
 */
export class PrismaOpenAiNativeProofKeyVersionAuthority {
  private readonly configuredFingerprints: ReadonlyMap<number, string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: OpenAiNativeProofKeyRingAdmission,
  ) {
    assertOpenAiNativeProofKeyVersion(keys.currentVersion);
    if (
      !Array.isArray(keys.versions)
      || keys.versions.length < 1
      || keys.versions.length > 2
      || new Set(keys.versions).size !== keys.versions.length
      || !keys.versions.includes(keys.currentVersion)
    ) throw new Error('OpenAI native proof HMAC keyring versions are invalid.');
    const ordered = [...keys.versions].sort((left, right) => left - right);
    if (
      ordered.at(-1) !== keys.currentVersion
      || (ordered.length === 2 && ordered[1] !== ordered[0]! + 1)
    ) throw new Error('OpenAI native proof HMAC keyring rotation is invalid.');

    const fingerprints = new Map<number, string>();
    const uniqueFingerprints = new Set<string>();
    for (const version of ordered) {
      assertOpenAiNativeProofKeyVersion(version);
      const secret = keys.secret(version);
      if (secret === null) {
        throw new Error(`OpenAI native proof HMAC key version ${version} is unavailable.`);
      }
      const fingerprint = fingerprintOpenAiNativeProofKey(secret);
      if (uniqueFingerprints.has(fingerprint)) {
        throw new Error('OpenAI native proof HMAC keyring reuses key material across versions.');
      }
      uniqueFingerprints.add(fingerprint);
      fingerprints.set(version, fingerprint);
    }
    this.configuredFingerprints = fingerprints;
  }

  async assertCurrentVersion(): Promise<void> {
    if (this.prisma.inTransaction()) {
      throw new Error('OpenAI native proof HMAC admission requires a root transaction.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock_shared(
          hashtextextended(${OPENAI_NATIVE_PROOF_HMAC_KEY_SPACE}, 0)
        )
      `;
      const ranges = await tx.$queryRaw<Array<{
        minimumVersion: number;
        highestVersion: number;
      }>>`
        SELECT floor."minimumVersion", floor."highestVersion"
          FROM realtime_mistral_conversation_key_version_floors AS floor
         WHERE floor."keySpace" = ${OPENAI_NATIVE_PROOF_HMAC_KEY_SPACE}
      `;
      const range = ranges[0];
      if (ranges.length !== 1 || !range) {
        throw new Error(
          'OpenAI native proof HMAC key range is not initialized by the release pipeline.',
        );
      }
      assertOpenAiNativeProofKeyVersion(range.minimumVersion);
      assertOpenAiNativeProofKeyVersion(range.highestVersion);
      if (
        range.highestVersion < range.minimumVersion
        || range.highestVersion > range.minimumVersion + 1
        || this.keys.currentVersion < range.minimumVersion
        || this.keys.currentVersion > range.highestVersion
      ) {
        throw new Error('OpenAI native proof HMAC current version is outside the admitted range.');
      }

      const admittedBindings = await tx.$queryRaw<Array<{
        keyVersion: number;
        keyFingerprint: string;
      }>>`
        SELECT binding."keyVersion", binding."keyFingerprint"::text AS "keyFingerprint"
          FROM realtime_mistral_conversation_key_bindings AS binding
         WHERE binding."keySpace" = ${OPENAI_NATIVE_PROOF_HMAC_KEY_SPACE}
           AND binding."keyVersion" BETWEEN ${range.minimumVersion} AND ${range.highestVersion}
         ORDER BY binding."keyVersion"
      `;
      if (admittedBindings.length !== range.highestVersion - range.minimumVersion + 1) {
        throw new Error('OpenAI native proof HMAC admitted key bindings are incomplete.');
      }

      const retainedBindings = await tx.$queryRaw<Array<{
        keyVersion: number;
        keyFingerprint: string | null;
      }>>`
        SELECT "keyVersion", "keyFingerprint"
          FROM retained_openai_native_proof_hmac_key_bindings()
         ORDER BY "keyVersion"
      `;
      const required = new Map<number, string | null>();
      for (const binding of [...admittedBindings, ...retainedBindings]) {
        assertOpenAiNativeProofKeyVersion(binding.keyVersion);
        const previous = required.get(binding.keyVersion);
        if (previous !== undefined && previous !== binding.keyFingerprint) {
          throw new Error(
            `OpenAI native proof HMAC durable binding ${binding.keyVersion} is inconsistent.`,
          );
        }
        required.set(binding.keyVersion, binding.keyFingerprint);
      }
      for (const [version, durableFingerprint] of required) {
        if (
          typeof durableFingerprint !== 'string'
          || !SHA256.test(durableFingerprint)
          || this.configuredFingerprints.get(version) !== durableFingerprint
        ) {
          throw new Error(
            `OpenAI native proof HMAC key material does not match durable version ${version}.`,
          );
        }
      }
    });
  }
}

/** Une seule porte de boot pour les deux identités cryptographiques d'une livraison native. */
export class PrismaOpenAiNativeKeyVersionAuthority
implements OpenAiNativeKeyVersionAuthorityPort {
  private readonly subject: PrismaBobLiveSubjectHmacKeyVersionAuthority;
  private readonly proof: PrismaOpenAiNativeProofKeyVersionAuthority;

  constructor(
    prisma: PrismaService,
    subjectKeys: BobLiveSubjectHmacKeyRingAdmission,
    proofKeys: OpenAiNativeProofKeyRingAdmission,
  ) {
    this.subject = new PrismaBobLiveSubjectHmacKeyVersionAuthority(prisma, subjectKeys);
    this.proof = new PrismaOpenAiNativeProofKeyVersionAuthority(prisma, proofKeys);
  }

  async assertCurrentKeyVersions(): Promise<void> {
    await this.subject.assertCurrentVersion();
    await this.proof.assertCurrentVersion();
  }
}
