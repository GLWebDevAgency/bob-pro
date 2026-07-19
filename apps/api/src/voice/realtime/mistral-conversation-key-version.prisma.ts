import { createHash } from 'node:crypto';
import type { PrismaService } from '../../persistence/prisma/prisma.service';

export const MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE =
  'mistral-conversation-persistence-v1';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const SHA256 = /^[a-f0-9]{64}$/u;

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > POSTGRES_INTEGER_MAX) {
    throw new Error('Mistral conversation persistence key version must be a positive integer.');
  }
}

export function fingerprintMistralConversationPersistenceKey(
  secret: Uint8Array,
): string {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
    throw new Error('Mistral conversation persistence key must contain exactly 32 bytes.');
  }
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Autorité globale d'admission des versions de clé de persistance Mistral.
 *
 * Le rôle runtime est strictement read-only sur ce registre. Seul le rituel de déploiement, via
 * DIRECT_URL, peut préparer une nouvelle clé puis retirer l'ancienne après drainage des replicas.
 */
export class PrismaMistralConversationKeyVersionAuthority {
  private readonly currentFingerprint: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly currentVersion: number,
    currentSecret: Uint8Array,
  ) {
    assertVersion(currentVersion);
    this.currentFingerprint = fingerprintMistralConversationPersistenceKey(currentSecret);
  }

  async assertCurrentVersion(): Promise<void> {
    if (this.prisma.inTransaction()) {
      throw new Error(
        'Mistral conversation key-version admission requires a root transaction.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        minimumVersion: number;
        highestVersion: number;
        keyFingerprint: string | null;
      }>>`
        SELECT floor."minimumVersion",
               floor."highestVersion",
               binding."keyFingerprint"
          FROM realtime_mistral_conversation_key_version_floors AS floor
          LEFT JOIN realtime_mistral_conversation_key_bindings AS binding
            ON binding."keySpace" = floor."keySpace"
           AND binding."keyVersion" = ${this.currentVersion}
         WHERE floor."keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
      `;

      const range = rows[0];
      if (rows.length !== 1 || !range) {
        throw new Error(
          'Mistral conversation persistence key range is not initialized by the release pipeline.',
        );
      }
      assertVersion(range.minimumVersion);
      assertVersion(range.highestVersion);
      if (
        this.currentVersion < range.minimumVersion
        || this.currentVersion > range.highestVersion
      ) {
        throw new Error(
          `Mistral conversation persistence key version ${this.currentVersion} is outside the admitted range ${range.minimumVersion}-${range.highestVersion}.`,
        );
      }
      if (
        typeof range.keyFingerprint !== 'string'
        || !SHA256.test(range.keyFingerprint)
        || range.keyFingerprint !== this.currentFingerprint
      ) {
        throw new Error(
          `Mistral conversation persistence key material does not match durable version ${this.currentVersion}.`,
        );
      }
    });
  }
}
