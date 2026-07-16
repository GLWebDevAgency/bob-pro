import {
  assertQuoteDraftStorageIdentity,
  decodeQuoteDraftSnapshot,
  encodeQuoteDraftSnapshot,
  type QuoteDraftStorageIdentity,
} from './quote-draft-codec';
import type { QuoteDraftState } from './quote-draft-model';

/** Valeur volontairement sous l'ancien plafond iOS historique de 2 048 octets. */
export const QUOTE_DRAFT_SECURE_CHUNK_BYTES = 1_800;
export const QUOTE_DRAFT_SECURE_MAX_CHUNKS = 24;
export const QUOTE_DRAFT_SECURE_STORE_VERSION = 1 as const;

type Generation = 'a' | 'b';

export interface QuoteDraftKeyValueStore {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

export interface QuoteDraftStoreRuntime {
  /** SHA-256 hexadécimal : fourni par expo-crypto en production. */
  readonly sha256: (value: string) => Promise<string>;
}

export interface QuoteDraftPersistence {
  readonly load: (identity: QuoteDraftStorageIdentity) => Promise<QuoteDraftState | null>;
  /** Retourne l'état exact effectivement écrit (sanitisé et marqué enregistré). */
  readonly save: (
    identity: QuoteDraftStorageIdentity,
    state: QuoteDraftState,
    savedAt: number,
  ) => Promise<QuoteDraftState>;
  readonly clear: (identity: QuoteDraftStorageIdentity) => Promise<void>;
}

export type QuoteDraftStoreErrorCode =
  'unavailable' | 'invalid_digest' | 'payload_too_large' | 'write_failed' | 'clear_failed';

export class QuoteDraftStoreError extends Error {
  readonly code: QuoteDraftStoreErrorCode;

  constructor(code: QuoteDraftStoreErrorCode) {
    super(`quote_draft_store_${code}`);
    this.name = 'QuoteDraftStoreError';
    this.code = code;
  }
}

interface PointerV1 {
  readonly version: typeof QUOTE_DRAFT_SECURE_STORE_VERSION;
  readonly generation: Generation;
  readonly sha256: string;
}

interface ManifestV1 {
  readonly version: typeof QUOTE_DRAFT_SECURE_STORE_VERSION;
  readonly generation: Generation;
  readonly chunks: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly scopeHash: string;
}

const STORE_PREFIX = 'bob.quote-draft.secure.v1';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parsePointer(value: string | null): PointerV1 | null {
  if (value === null) return null;
  const candidate = parseJson(value);
  if (!isRecord(candidate) || !hasExactKeys(candidate, ['version', 'generation', 'sha256']))
    return null;
  if (
    candidate['version'] !== QUOTE_DRAFT_SECURE_STORE_VERSION ||
    (candidate['generation'] !== 'a' && candidate['generation'] !== 'b') ||
    typeof candidate['sha256'] !== 'string' ||
    !DIGEST_PATTERN.test(candidate['sha256'])
  )
    return null;
  return {
    version: QUOTE_DRAFT_SECURE_STORE_VERSION,
    generation: candidate['generation'],
    sha256: candidate['sha256'],
  };
}

function parseManifest(value: string | null): ManifestV1 | null {
  if (value === null) return null;
  const candidate = parseJson(value);
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, ['version', 'generation', 'chunks', 'bytes', 'sha256', 'scopeHash'])
  )
    return null;
  const generation = candidate['generation'];
  const chunks = candidate['chunks'];
  const bytes = candidate['bytes'];
  const sha256 = candidate['sha256'];
  const scopeHash = candidate['scopeHash'];
  if (
    candidate['version'] !== QUOTE_DRAFT_SECURE_STORE_VERSION ||
    (generation !== 'a' && generation !== 'b') ||
    !Number.isSafeInteger(chunks) ||
    (chunks as number) < 1 ||
    (chunks as number) > QUOTE_DRAFT_SECURE_MAX_CHUNKS ||
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 1 ||
    (bytes as number) > QUOTE_DRAFT_SECURE_CHUNK_BYTES * QUOTE_DRAFT_SECURE_MAX_CHUNKS ||
    typeof sha256 !== 'string' ||
    !DIGEST_PATTERN.test(sha256) ||
    typeof scopeHash !== 'string' ||
    !DIGEST_PATTERN.test(scopeHash)
  )
    return null;
  return {
    version: QUOTE_DRAFT_SECURE_STORE_VERSION,
    generation,
    chunks: chunks as number,
    bytes: bytes as number,
    sha256,
    scopeHash,
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Coupe uniquement aux frontières de points de code, jamais au milieu d'un caractère UTF-16. */
export function chunkQuoteDraftPayload(value: string): readonly string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const codePoint of value) {
    const size = utf8Bytes(codePoint);
    if (size > QUOTE_DRAFT_SECURE_CHUNK_BYTES) {
      throw new QuoteDraftStoreError('payload_too_large');
    }
    if (currentBytes + size > QUOTE_DRAFT_SECURE_CHUNK_BYTES) {
      chunks.push(current);
      current = codePoint;
      currentBytes = size;
    } else {
      current += codePoint;
      currentBytes += size;
    }
  }
  if (current !== '') chunks.push(current);
  if (chunks.length === 0 || chunks.length > QUOTE_DRAFT_SECURE_MAX_CHUNKS) {
    throw new QuoteDraftStoreError('payload_too_large');
  }
  return chunks;
}

function scopeMaterial(identity: QuoteDraftStorageIdentity): string {
  return [identity.mode, identity.userId, identity.companyId].join('\u0000');
}

function opposite(generation: Generation): Generation {
  return generation === 'a' ? 'b' : 'a';
}

export class GenerationQuoteDraftStore implements QuoteDraftPersistence {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly keyValue: QuoteDraftKeyValueStore,
    private readonly runtime: QuoteDraftStoreRuntime,
  ) {}

  private async scopeHash(identity: QuoteDraftStorageIdentity): Promise<string> {
    assertQuoteDraftStorageIdentity(identity);
    const hash = (await this.runtime.sha256(scopeMaterial(identity))).toLowerCase();
    if (!DIGEST_PATTERN.test(hash)) throw new QuoteDraftStoreError('invalid_digest');
    return hash;
  }

  private prefix(scopeHash: string): string {
    return `${STORE_PREFIX}.${scopeHash}`;
  }

  private pointerKey(prefix: string): string {
    return `${prefix}.head`;
  }

  private manifestKey(prefix: string, generation: Generation): string {
    return `${prefix}.${generation}.manifest`;
  }

  private chunkKey(prefix: string, generation: Generation, index: number): string {
    return `${prefix}.${generation}.${String(index)}`;
  }

  private async runExclusive<T>(
    identity: QuoteDraftStorageIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockKey = scopeMaterial(identity);
    const previous = this.tails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => next);
    this.tails.set(lockKey, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(lockKey) === tail) this.tails.delete(lockKey);
    }
  }

  private generationKeys(prefix: string, generation: Generation): readonly string[] {
    return [
      this.manifestKey(prefix, generation),
      ...Array.from({ length: QUOTE_DRAFT_SECURE_MAX_CHUNKS }, (_, index) =>
        this.chunkKey(prefix, generation, index),
      ),
    ];
  }

  private async removeWithRetry(key: string): Promise<boolean> {
    try {
      await this.keyValue.remove(key);
      return true;
    } catch {
      try {
        await this.keyValue.remove(key);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async purgeGeneration(
    prefix: string,
    generation: Generation,
    strict: boolean,
  ): Promise<void> {
    const results = await Promise.all(
      this.generationKeys(prefix, generation).map((key) => this.removeWithRetry(key)),
    );
    if (strict && results.some((result) => !result)) {
      throw new QuoteDraftStoreError('clear_failed');
    }
  }

  private async purgeScope(prefix: string, strict: boolean): Promise<void> {
    // Le pointeur disparaît d'abord : même si un nettoyage suivant échoue, aucun snapshot ancien
    // ne peut être repris par l'application.
    const pointerRemoved = await this.removeWithRetry(this.pointerKey(prefix));
    const results = await Promise.all([
      this.purgeGeneration(prefix, 'a', strict).then(
        () => true,
        () => false,
      ),
      this.purgeGeneration(prefix, 'b', strict).then(
        () => true,
        () => false,
      ),
    ]);
    if (strict && (!pointerRemoved || results.some((result) => !result))) {
      throw new QuoteDraftStoreError('clear_failed');
    }
  }

  async load(identity: QuoteDraftStorageIdentity): Promise<QuoteDraftState | null> {
    return this.runExclusive(identity, async () => {
      const scopeHash = await this.scopeHash(identity);
      const prefix = this.prefix(scopeHash);
      let rawPointer: string | null;
      try {
        rawPointer = await this.keyValue.get(this.pointerKey(prefix));
      } catch {
        throw new QuoteDraftStoreError('unavailable');
      }
      if (rawPointer === null) return null;
      const pointer = parsePointer(rawPointer);
      if (pointer === null) {
        await this.purgeScope(prefix, false);
        return null;
      }
      let manifest: ManifestV1 | null;
      try {
        manifest = parseManifest(
          await this.keyValue.get(this.manifestKey(prefix, pointer.generation)),
        );
      } catch {
        throw new QuoteDraftStoreError('unavailable');
      }
      if (
        manifest === null ||
        manifest.generation !== pointer.generation ||
        manifest.scopeHash !== scopeHash ||
        manifest.sha256 !== pointer.sha256
      ) {
        await this.purgeScope(prefix, false);
        return null;
      }
      const chunks: string[] = [];
      try {
        for (let index = 0; index < manifest.chunks; index += 1) {
          const chunk = await this.keyValue.get(this.chunkKey(prefix, pointer.generation, index));
          if (chunk === null || utf8Bytes(chunk) > QUOTE_DRAFT_SECURE_CHUNK_BYTES) {
            await this.purgeScope(prefix, false);
            return null;
          }
          chunks.push(chunk);
        }
      } catch {
        throw new QuoteDraftStoreError('unavailable');
      }
      const serialized = chunks.join('');
      if (utf8Bytes(serialized) !== manifest.bytes) {
        await this.purgeScope(prefix, false);
        return null;
      }
      const digest = (await this.runtime.sha256(serialized)).toLowerCase();
      if (!DIGEST_PATTERN.test(digest) || digest !== manifest.sha256) {
        await this.purgeScope(prefix, false);
        return null;
      }
      try {
        const state = decodeQuoteDraftSnapshot(serialized, identity);
        // L'autre slot ne peut être qu'une ancienne génération ou une écriture interrompue.
        await this.purgeGeneration(prefix, opposite(pointer.generation), false);
        return state;
      } catch {
        await this.purgeScope(prefix, false);
        return null;
      }
    });
  }

  async save(
    identity: QuoteDraftStorageIdentity,
    state: QuoteDraftState,
    savedAt: number,
  ): Promise<QuoteDraftState> {
    return this.runExclusive(identity, async () => {
      const scopeHash = await this.scopeHash(identity);
      const prefix = this.prefix(scopeHash);
      const encoded = encodeQuoteDraftSnapshot(state, identity, savedAt);
      const chunks = chunkQuoteDraftPayload(encoded.serialized);
      const digest = (await this.runtime.sha256(encoded.serialized)).toLowerCase();
      if (!DIGEST_PATTERN.test(digest)) throw new QuoteDraftStoreError('invalid_digest');
      let previous: PointerV1 | null = null;
      try {
        previous = parsePointer(await this.keyValue.get(this.pointerKey(prefix)));
      } catch {
        throw new QuoteDraftStoreError('unavailable');
      }
      const generation: Generation = previous === null ? 'a' : opposite(previous.generation);
      try {
        // Nettoie aussi les restes d'un process kill sur ce slot avant de le réutiliser.
        await this.purgeGeneration(prefix, generation, true);
        for (let index = 0; index < chunks.length; index += 1) {
          await this.keyValue.set(this.chunkKey(prefix, generation, index), chunks[index]!);
        }
        const manifest: ManifestV1 = {
          version: QUOTE_DRAFT_SECURE_STORE_VERSION,
          generation,
          chunks: chunks.length,
          bytes: utf8Bytes(encoded.serialized),
          sha256: digest,
          scopeHash,
        };
        await this.keyValue.set(this.manifestKey(prefix, generation), JSON.stringify(manifest));
        const pointer: PointerV1 = {
          version: QUOTE_DRAFT_SECURE_STORE_VERSION,
          generation,
          sha256: digest,
        };
        // Commit atomique logique : l'ancienne génération reste la vérité jusqu'à cet ultime write.
        await this.keyValue.set(this.pointerKey(prefix), JSON.stringify(pointer));
      } catch (error: unknown) {
        await this.purgeGeneration(prefix, generation, false);
        if (error instanceof QuoteDraftStoreError && error.code === 'clear_failed') throw error;
        throw new QuoteDraftStoreError('write_failed');
      }
      // Nettoie systématiquement l'autre slot : il peut aussi provenir d'un pointeur ancien
      // corrompu ou d'une interruption de processus antérieure.
      await this.purgeGeneration(prefix, opposite(generation), false);
      return encoded.state;
    });
  }

  async clear(identity: QuoteDraftStorageIdentity): Promise<void> {
    await this.runExclusive(identity, async () => {
      const scopeHash = await this.scopeHash(identity);
      await this.purgeScope(this.prefix(scopeHash), true);
    });
  }
}
