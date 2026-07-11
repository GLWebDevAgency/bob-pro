import { createHash } from 'node:crypto';
import { type DocumentStoragePort, type StoredObject } from '@bob/core';
import { isDemoMode, loadEnv } from '../config/env';

export function documentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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

export class InMemoryDocumentStorage implements DocumentStoragePort {
  private readonly objects = new Map<string, { companyId: string; bytes: Uint8Array; contentType: string; sha256: string }>();

  async put(input: { companyId: string; key: string; bytes: Uint8Array; contentType: string }): Promise<StoredObject> {
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

  async get(companyId: string, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
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

  async stat(companyId: string, key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
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

export class SupabaseDocumentStorage implements DocumentStoragePort {
  constructor(
    private readonly config: {
      url: string;
      serviceRoleKey: string;
      bucket?: string;
    },
  ) {}

  private get bucket(): string {
    return this.config.bucket ?? 'bob-documents';
  }

  private objectUrl(key: string): string {
    return `${this.config.url.replace(/\/$/, '')}/storage/v1/object/${this.bucket}/${encodePath(key)}`;
  }

  private signUrl(key: string): string {
    return `${this.config.url.replace(/\/$/, '')}/storage/v1/object/sign/${this.bucket}/${encodePath(key)}`;
  }

  private headers(contentType?: string): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.serviceRoleKey}`,
      apikey: this.config.serviceRoleKey,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
  }

  private infoUrl(key: string): string {
    return `${this.config.url.replace(/\/$/, '')}/storage/v1/object/info/${this.bucket}/${encodePath(key)}`;
  }

  /**
   * Supabase Storage ne renvoie PAS un 404 HTTP pour un objet inexistant : il répond 400 avec un
   * corps `{"statusCode":"404","error":"not_found",...}` (constaté en prod le 2026-07-11 — le
   * HEAD aveugle sur ce 400 faisait échouer stat, donc TOUT put/get). On discrimine par le corps.
   */
  private static isNotFound(status: number, bodyText: string): boolean {
    return status === 404 || (status === 400 && /not_found|"statusCode"\s*:\s*"404"/.test(bodyText));
  }

  async put(input: { companyId: string; key: string; bytes: Uint8Array; contentType: string }): Promise<StoredObject> {
    assertTenantStorageKey(input.companyId, input.key);
    if (await this.stat(input.companyId, input.key)) throw new Error('Document object already exists.');
    const response = await fetch(this.objectUrl(input.key), {
      method: 'POST',
      headers: { ...this.headers(input.contentType), 'x-upsert': 'false' },
      body: Buffer.from(input.bytes),
    });
    if (!response.ok) throw new Error(`Supabase storage upload failed: ${response.status} ${await response.text()}`);
    return { key: input.key, sizeBytes: input.bytes.byteLength, sha256: documentSha256(input.bytes) };
  }

  async get(companyId: string, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    assertTenantStorageKey(companyId, key);
    const response = await fetch(this.objectUrl(key), { method: 'GET', headers: this.headers() });
    if (!response.ok) {
      const text = await response.text();
      if (SupabaseDocumentStorage.isNotFound(response.status, text)) return null;
      throw new Error(`Supabase storage download failed: ${response.status} ${text}`);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async getSignedUrl(companyId: string, key: string, ttlSeconds: number): Promise<string> {
    assertTenantStorageKey(companyId, key);
    const response = await fetch(this.signUrl(key), {
      method: 'POST',
      headers: this.headers('application/json'),
      body: JSON.stringify({ expiresIn: ttlSeconds }),
    });
    if (!response.ok) throw new Error(`Supabase storage signed URL failed: ${response.status} ${await response.text()}`);
    const payload = (await response.json()) as { signedURL?: string; signedUrl?: string };
    const signed = payload.signedURL ?? payload.signedUrl;
    if (!signed) throw new Error('Supabase storage signed URL response missing URL.');
    return signed.startsWith('http') ? signed : `${this.config.url.replace(/\/$/, '')}${signed}`;
  }

  async stat(companyId: string, key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
    assertTenantStorageKey(companyId, key);
    // GET /object/info/ et non HEAD : un HEAD sans corps ne permet pas de distinguer le 400
    // « not_found » de Supabase d'une vraie erreur (cause du xmlDocumentId null en prod).
    const response = await fetch(this.infoUrl(key), { method: 'GET', headers: this.headers() });
    if (!response.ok) {
      const text = await response.text();
      if (SupabaseDocumentStorage.isNotFound(response.status, text)) return null;
      throw new Error(`Supabase storage stat failed: ${response.status} ${text}`);
    }
    const info = (await response.json()) as { size?: number; content_type?: string };
    return {
      sizeBytes: Number.isSafeInteger(info.size) ? (info.size as number) : 0,
      contentType: info.content_type ?? 'application/octet-stream',
    };
  }

  async remove(companyId: string, key: string): Promise<void> {
    assertTenantStorageKey(companyId, key);
    const response = await fetch(this.objectUrl(key), { method: 'DELETE', headers: this.headers() });
    if (!response.ok) {
      const text = await response.text();
      if (SupabaseDocumentStorage.isNotFound(response.status, text)) return;
      throw new Error(`Supabase storage delete failed: ${response.status} ${text}`);
    }
  }
}

export function buildDocumentStorage(): DocumentStoragePort {
  const env = loadEnv();
  if (!isDemoMode()) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis pour le stockage documentaire live.');
    }
    return new SupabaseDocumentStorage({
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: env.SUPABASE_STORAGE_BUCKET,
    });
  }
  return new InMemoryDocumentStorage();
}
