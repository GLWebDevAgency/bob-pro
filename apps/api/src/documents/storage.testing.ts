import { type DocumentStoragePort, type StoredObject } from '@bob/core';
import { documentSha256 } from './storage';

function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function assertTenantStorageKey(companyId: string, key: string): void {
  const prefix = `companies/${companyId}/documents/`;
  if (!key.startsWith(prefix) || key.includes('..') || key.startsWith('/')) {
    throw new Error('Document storage key outside tenant scope.');
  }
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
    if (this.objects.has(input.key)) throw new Error('Document object already exists.');
    const digest = documentSha256(input.bytes);
    this.objects.set(input.key, {
      companyId: input.companyId,
      bytes: copy(input.bytes),
      contentType: input.contentType,
      sha256: digest,
    });
    return { key: input.key, sizeBytes: input.bytes.byteLength, sha256: digest };
  }

  async get(
    companyId: string,
    key: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    assertTenantStorageKey(companyId, key);
    const object = this.objects.get(key);
    if (!object || object.companyId !== companyId) return null;
    return { bytes: copy(object.bytes), contentType: object.contentType };
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
