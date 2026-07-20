import { parseCustomPrestation, type CustomPrestation } from '@bob/core';

export const CATALOGUE_STORAGE_SCHEMA_VERSION = 2 as const;
const STORE_PREFIX = `bob.catalogue.perso.v${String(CATALOGUE_STORAGE_SCHEMA_VERSION)}`;
const IDENTIFIER = /^[A-Za-z0-9-]{1,128}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_PRESTATIONS = 1_000;

export interface CatalogueStorageIdentity {
  readonly mode: 'authenticated';
  readonly companyId: string;
  readonly userId: string;
}

export interface CatalogueStorageSnapshot {
  readonly version: typeof CATALOGUE_STORAGE_SCHEMA_VERSION;
  readonly revision: number;
  readonly prestations: readonly CustomPrestation[];
}

export interface CatalogueKeyValueStore {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

export interface CatalogueStorageRuntime {
  readonly sha256: (value: string) => Promise<string>;
}

export type CatalogueStorageErrorCode =
  | 'owner_required'
  | 'invalid_digest'
  | 'invalid_payload'
  | 'payload_too_large'
  | 'unavailable'
  | 'write_failed'
  | 'clear_failed';

export class CatalogueStorageError extends Error {
  readonly code: CatalogueStorageErrorCode;

  constructor(code: CatalogueStorageErrorCode) {
    super(`catalogue_storage_${code}`);
    this.name = 'CatalogueStorageError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function assertIdentity(identity: CatalogueStorageIdentity): void {
  if (
    identity.mode !== 'authenticated' ||
    !IDENTIFIER.test(identity.companyId) ||
    !IDENTIFIER.test(identity.userId)
  ) {
    throw new CatalogueStorageError('owner_required');
  }
}

export function resolveCatalogueStorageIdentity(input: {
  readonly authenticatedCompanyId: string | null;
  readonly authenticatedUserId: string | null;
}): CatalogueStorageIdentity {
  const identity: CatalogueStorageIdentity = {
    mode: 'authenticated',
    companyId: input.authenticatedCompanyId ?? '',
    userId: input.authenticatedUserId ?? '',
  };
  assertIdentity(identity);
  return identity;
}

function parseCatalogueList(value: unknown): CustomPrestation[] | null {
  if (!Array.isArray(value) || value.length > MAX_PRESTATIONS) return null;
  const parsed = value.map((prestation) => parseCustomPrestation(prestation));
  if (parsed.some((prestation) => prestation === null)) return null;
  const canonical = parsed as CustomPrestation[];
  if (new Set(canonical.map((prestation) => prestation.id)).size !== canonical.length) return null;
  return canonical;
}

function scopeMaterial(identity: CatalogueStorageIdentity): string {
  return JSON.stringify([
    CATALOGUE_STORAGE_SCHEMA_VERSION,
    identity.mode,
    identity.companyId,
    identity.userId,
  ]);
}

function decodeSnapshot(raw: string, expectedScopeHash: string): CatalogueStorageSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new CatalogueStorageError('invalid_payload');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'scopeHash', 'revision', 'prestations'])
  ) {
    throw new CatalogueStorageError('invalid_payload');
  }
  const revision = value['revision'];
  const prestations = parseCatalogueList(value['prestations']);
  if (
    value['version'] !== CATALOGUE_STORAGE_SCHEMA_VERSION ||
    value['scopeHash'] !== expectedScopeHash ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0 ||
    prestations === null
  ) {
    throw new CatalogueStorageError('invalid_payload');
  }
  return {
    version: CATALOGUE_STORAGE_SCHEMA_VERSION,
    revision: revision as number,
    prestations,
  };
}

/**
 * Decode a locally persisted catalogue without ever turning corruption into an empty state.
 * The getter is injected so this financial-data boundary remains testable without React Native.
 */
export async function readCustomPrestations(
  getItem: () => Promise<string | null>,
): Promise<CustomPrestation[]> {
  const raw = await getItem();
  if (raw === null) return [];

  const parsed = parseCatalogueList(JSON.parse(raw) as unknown);
  if (parsed === null) {
    throw new Error('CATALOGUE_STORAGE_INVALID');
  }
  return parsed;
}

/**
 * Stockage local strictement cloisonné par propriétaire.
 *
 * La clé historique globale `bob.catalogue.perso` n'est volontairement jamais lue : son owner ne
 * peut pas être prouvé, donc l'adopter dans un compte authentifié risquerait une fuite de prix.
 * Les identifiants bruts ne figurent ni dans la clé physique ni dans l'enveloppe persistée.
 * L'adaptateur de production chiffre/authentifie ensuite cette enveloppe avant AsyncStorage.
 */
export class ScopedCatalogueStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly keyValue: CatalogueKeyValueStore,
    private readonly runtime: CatalogueStorageRuntime,
  ) {}

  private async scopeHash(identity: CatalogueStorageIdentity): Promise<string> {
    assertIdentity(identity);
    const digest = (await this.runtime.sha256(scopeMaterial(identity))).toLowerCase();
    if (!SHA256_HEX.test(digest)) throw new CatalogueStorageError('invalid_digest');
    return digest;
  }

  private key(scopeHash: string): string {
    return `${STORE_PREFIX}.${scopeHash}`;
  }

  private async runExclusive<T>(scopeHash: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(scopeHash) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(scopeHash, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(scopeHash) === tail) this.tails.delete(scopeHash);
    }
  }

  async storageKey(identity: CatalogueStorageIdentity): Promise<string> {
    return this.key(await this.scopeHash(identity));
  }

  async load(identity: CatalogueStorageIdentity): Promise<CatalogueStorageSnapshot> {
    const scopeHash = await this.scopeHash(identity);
    const raw = await this.keyValue.get(this.key(scopeHash));
    if (raw === null) {
      return {
        version: CATALOGUE_STORAGE_SCHEMA_VERSION,
        revision: 0,
        prestations: [],
      };
    }
    return decodeSnapshot(raw, scopeHash);
  }

  async update(
    identity: CatalogueStorageIdentity,
    change: (current: readonly CustomPrestation[]) => readonly CustomPrestation[],
  ): Promise<CatalogueStorageSnapshot> {
    const scopeHash = await this.scopeHash(identity);
    return this.runExclusive(scopeHash, async () => {
      const currentRaw = await this.keyValue.get(this.key(scopeHash));
      const current =
        currentRaw === null
          ? {
              version: CATALOGUE_STORAGE_SCHEMA_VERSION,
              revision: 0,
              prestations: [] as readonly CustomPrestation[],
            }
          : decodeSnapshot(currentRaw, scopeHash);
      const prestations = parseCatalogueList([...change(current.prestations)]);
      if (prestations === null || current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new CatalogueStorageError('invalid_payload');
      }
      const next: CatalogueStorageSnapshot = {
        version: CATALOGUE_STORAGE_SCHEMA_VERSION,
        revision: current.revision + 1,
        prestations,
      };
      try {
        await this.keyValue.set(this.key(scopeHash), JSON.stringify({ ...next, scopeHash }));
      } catch {
        throw new CatalogueStorageError('write_failed');
      }
      return next;
    });
  }
}
