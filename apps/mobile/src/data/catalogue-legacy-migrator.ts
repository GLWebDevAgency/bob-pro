import {
  CatalogueStorageError,
  type CatalogueKeyValueStore,
  type CatalogueStorageRuntime,
} from './catalogue-storage';

export const LEGACY_CATALOGUE_ASYNC_STORAGE_KEY = 'bob.catalogue.perso';
export const LEGACY_CATALOGUE_QUARANTINE_KEY = 'bob.catalogue.legacy-quarantine.v1';
const LEGACY_QUARANTINE_VERSION = 1 as const;
const LEGACY_MAX_BYTES = 1_000_000;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export interface LegacyCatalogueSource {
  readonly get: (key: string) => Promise<string | null>;
  readonly remove: (key: string) => Promise<void>;
}

export interface LegacyCatalogueMigratorRuntime extends CatalogueStorageRuntime {
  readonly now: () => number;
}

export type LegacyCatalogueProtection =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'protected_unattributed';
      readonly quarantinedAt: number;
      readonly retention: 'until_user_deletes';
    }
  | {
      readonly kind: 'protection_incomplete';
      readonly quarantinedAt: number;
      readonly retention: 'until_user_deletes';
    }
  | { readonly kind: 'blocked' };

interface LegacyCatalogueQuarantineV1 {
  readonly version: typeof LEGACY_QUARANTINE_VERSION;
  readonly digest: string;
  readonly bytes: number;
  readonly quarantinedAt: number;
  readonly retention: 'until_user_deletes';
  /** Blob historique opaque : jamais parsé, affiché, loggé ni attribué à un compte. */
  readonly raw: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeQuarantine(raw: string): LegacyCatalogueQuarantineV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new CatalogueStorageError('invalid_payload');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'digest', 'bytes', 'quarantinedAt', 'retention', 'raw']) ||
    value['version'] !== LEGACY_QUARANTINE_VERSION ||
    typeof value['digest'] !== 'string' ||
    !SHA256_HEX.test(value['digest']) ||
    !Number.isSafeInteger(value['bytes']) ||
    (value['bytes'] as number) < 0 ||
    (value['bytes'] as number) > LEGACY_MAX_BYTES ||
    !Number.isSafeInteger(value['quarantinedAt']) ||
    (value['quarantinedAt'] as number) < 0 ||
    value['retention'] !== 'until_user_deletes' ||
    typeof value['raw'] !== 'string' ||
    utf8Bytes(value['raw']) !== value['bytes']
  ) {
    throw new CatalogueStorageError('invalid_payload');
  }
  return {
    version: LEGACY_QUARANTINE_VERSION,
    digest: value['digest'],
    bytes: value['bytes'] as number,
    quarantinedAt: value['quarantinedAt'] as number,
    retention: 'until_user_deletes',
    raw: value['raw'],
  };
}

function publicState(
  quarantine: LegacyCatalogueQuarantineV1 | null,
  sourceRemoved: boolean,
): LegacyCatalogueProtection {
  if (quarantine === null) return sourceRemoved ? { kind: 'none' } : { kind: 'blocked' };
  return {
    kind: sourceRemoved ? 'protected_unattributed' : 'protection_incomplete',
    quarantinedAt: quarantine.quarantinedAt,
    retention: quarantine.retention,
  };
}

/**
 * Protège l'ancien blob global sans prétendre connaître son owner.
 *
 * Ordre de commit : coffre chiffré vérifié → suppression source vérifiée. Un crash à n'importe
 * quelle étape converge au prochain `prepare`; aucune donnée n'est adoptée par un tenant.
 */
export class CatalogueLegacyMigrator {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly source: LegacyCatalogueSource,
    private readonly quarantine: CatalogueKeyValueStore,
    private readonly runtime: LegacyCatalogueMigratorRuntime,
  ) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.catch(() => undefined).then(() => current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readQuarantine(): Promise<LegacyCatalogueQuarantineV1 | null> {
    const raw = await this.quarantine.get(LEGACY_CATALOGUE_QUARANTINE_KEY);
    return raw === null ? null : decodeQuarantine(raw);
  }

  private async removeLegacySource(): Promise<boolean> {
    try {
      await this.source.remove(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY);
      return (await this.source.get(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY)) === null;
    } catch {
      return false;
    }
  }

  async prepare(): Promise<LegacyCatalogueProtection> {
    return this.exclusive(async () => {
      const existing = await this.readQuarantine();
      let legacyRaw: string | null;
      try {
        legacyRaw = await this.source.get(LEGACY_CATALOGUE_ASYNC_STORAGE_KEY);
      } catch {
        throw new CatalogueStorageError('unavailable');
      }
      if (legacyRaw === null) return publicState(existing, true);

      const bytes = utf8Bytes(legacyRaw);
      if (bytes > LEGACY_MAX_BYTES) return { kind: 'blocked' };
      const digest = (await this.runtime.sha256(legacyRaw)).toLowerCase();
      if (!SHA256_HEX.test(digest)) throw new CatalogueStorageError('invalid_digest');

      if (existing !== null) {
        // Même blob = reprise idempotente après un crash/échec de remove. Un blob différent ne
        // peut jamais écraser silencieusement l'archive déjà protégée.
        if (existing.digest !== digest || existing.bytes !== bytes || existing.raw !== legacyRaw) {
          return { kind: 'blocked' };
        }
        return publicState(existing, await this.removeLegacySource());
      }

      const candidate: LegacyCatalogueQuarantineV1 = {
        version: LEGACY_QUARANTINE_VERSION,
        digest,
        bytes,
        quarantinedAt: this.runtime.now(),
        retention: 'until_user_deletes',
        raw: legacyRaw,
      };
      await this.quarantine.set(LEGACY_CATALOGUE_QUARANTINE_KEY, JSON.stringify(candidate));
      const verified = await this.readQuarantine();
      if (
        verified === null ||
        verified.digest !== candidate.digest ||
        verified.bytes !== candidate.bytes ||
        verified.raw !== candidate.raw
      ) {
        throw new CatalogueStorageError('write_failed');
      }
      return publicState(verified, await this.removeLegacySource());
    });
  }

  /** Suppression explicite uniquement, appelée après une confirmation UI non vocale. */
  async discard(): Promise<void> {
    await this.exclusive(async () => {
      if (!(await this.removeLegacySource())) throw new CatalogueStorageError('clear_failed');
      await this.quarantine.remove(LEGACY_CATALOGUE_QUARANTINE_KEY);
    });
  }
}
