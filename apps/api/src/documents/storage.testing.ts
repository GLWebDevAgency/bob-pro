import { type DocumentStoragePort, type LoadedStoredObject, type StoredObject } from '@bob/core';
import { documentSha256 } from './storage';

function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function assertTenantStorageKey(companyId: string, key: string): void {
  const root = `companies/${companyId}/`;
  const relative = key.startsWith(root) ? key.slice(root.length) : '';
  if (
    (!relative.startsWith('documents/') && !relative.startsWith('chantiers/'))
    || relative.includes('..')
    || relative.includes('//')
    || key.startsWith('/')
  ) {
    throw new Error('Document storage key outside tenant scope.');
  }
}

function normalizeContentType(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Double strict réservé aux tests ; aucun module runtime ne l'importe. */
export class InMemoryDocumentStorage implements DocumentStoragePort {
  private readonly objects = new Map<
    string,
    { companyId: string; bytes: Uint8Array; contentType: string; sha256: string }
  >();

  async put(input: {
    companyId: string;
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<StoredObject> {
    assertTenantStorageKey(input.companyId, input.key);
    const digest = documentSha256(input.bytes);
    const existing = this.objects.get(input.key);
    if (existing) {
      if (
        existing.companyId === input.companyId
        && existing.sha256 === digest
        && existing.bytes.byteLength === input.bytes.byteLength
        && normalizeContentType(existing.contentType) === normalizeContentType(input.contentType)
      ) {
        return {
          key: input.key,
          sizeBytes: existing.bytes.byteLength,
          sha256: existing.sha256,
          contentType: existing.contentType,
          created: false,
        };
      }
      throw new Error('Document object key collision with different content.');
    }
    this.objects.set(input.key, {
      companyId: input.companyId,
      bytes: copy(input.bytes),
      contentType: input.contentType,
      sha256: digest,
    });
    return {
      key: input.key,
      sizeBytes: input.bytes.byteLength,
      sha256: digest,
      contentType: input.contentType,
      created: true,
    };
  }

  async get(
    companyId: string,
    key: string,
  ): Promise<LoadedStoredObject | null> {
    assertTenantStorageKey(companyId, key);
    const object = this.objects.get(key);
    if (!object || object.companyId !== companyId) return null;
    return {
      key,
      bytes: copy(object.bytes),
      sizeBytes: object.bytes.byteLength,
      sha256: object.sha256,
      contentType: object.contentType,
    };
  }

  async getSignedUrl(companyId: string, key: string, ttlSeconds: number): Promise<string> {
    assertTenantStorageKey(companyId, key);
    if (!this.objects.has(key)) throw new Error('Document object not found.');
    return `memory://bob-documents/${encodePath(key)}?ttl=${ttlSeconds}`;
  }

  async stat(
    companyId: string,
    key: string,
  ): Promise<{ sizeBytes: number; contentType: string } | null> {
    assertTenantStorageKey(companyId, key);
    const object = this.objects.get(key);
    if (!object || object.companyId !== companyId) return null;
    return { sizeBytes: object.bytes.byteLength, contentType: object.contentType };
  }

  async remove(companyId: string, key: string): Promise<void> {
    assertTenantStorageKey(companyId, key);
    const object = this.objects.get(key);
    if (object?.companyId === companyId) this.objects.delete(key);
  }
}
