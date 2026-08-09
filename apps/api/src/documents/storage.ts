import { createHash } from 'node:crypto';
import { type DocumentStoragePort, type LoadedStoredObject, type StoredObject } from '@bob/core';
import { loadEnv } from '../config/env';
import {
  CompositeRequestDeadline,
  parseSupabaseObjectInfo,
  type RequestDeadlineRuntime,
} from './supabase-object-info';

export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');
const DOCUMENT_STORAGE_REQUEST_TIMEOUT_MS = 15_000;

export function documentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Adaptateur fail-closed uniquement utilisé quand BackendService est instancié manuellement sans
 * son module Nest (tests unitaires qui n'exercent pas le coffre). Le runtime AppModule injecte
 * toujours le provider live construit par `buildDocumentStorage`.
 */
export class UnavailableDocumentStorage implements DocumentStoragePort {
  private fail(): never {
    throw new Error('DOCUMENT_STORAGE_UNAVAILABLE');
  }

  put(_input: {
    companyId: string;
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<StoredObject> {
    return this.fail();
  }

  get(
    _companyId: string,
    _key: string,
  ): Promise<LoadedStoredObject | null> {
    return this.fail();
  }

  getSignedUrl(_companyId: string, _key: string, _ttlSeconds: number): Promise<string> {
    return this.fail();
  }

  stat(
    _companyId: string,
    _key: string,
  ): Promise<{ sizeBytes: number; contentType: string } | null> {
    return this.fail();
  }

  remove(_companyId: string, _key: string): Promise<void> {
    return this.fail();
  }
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

function encodePath(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

export class SupabaseDocumentStorage implements DocumentStoragePort {
  constructor(
    private readonly config: {
      url: string;
      serviceRoleKey: string;
      bucket?: string;
      requestTimeoutMs?: number;
    },
    private readonly requestRuntime: RequestDeadlineRuntime = {},
  ) {
    const timeoutMs = this.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('Document storage request timeout must be between 1 and 60000 ms.');
    }
  }

  private get requestTimeoutMs(): number {
    return this.config.requestTimeoutMs ?? DOCUMENT_STORAGE_REQUEST_TIMEOUT_MS;
  }

  private requestDeadline(): CompositeRequestDeadline {
    return new CompositeRequestDeadline(this.requestTimeoutMs, this.requestRuntime);
  }

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
    return (
      status === 404 || (status === 400 && /not_found|"statusCode"\s*:\s*"404"/.test(bodyText))
    );
  }

  async put(input: {
    companyId: string;
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<StoredObject> {
    assertTenantStorageKey(input.companyId, input.key);
    const expectedSha256 = documentSha256(input.bytes);
    const isExact = (object: LoadedStoredObject | null): object is LoadedStoredObject =>
      object !== null
      && object.sizeBytes === input.bytes.byteLength
      && object.sha256 === expectedSha256
      && normalizedContentType(object.contentType) === normalizedContentType(input.contentType);
    const existing = await this.get(input.companyId, input.key);
    if (existing) {
      if (isExact(existing)) {
        return { ...existing, created: false };
      }
      throw new Error('Document object key collision with different content.');
    }
    let response: Response;
    try {
      response = await fetch(this.objectUrl(input.key), {
        method: 'POST',
        headers: { ...this.headers(input.contentType), 'x-upsert': 'false' },
        body: Buffer.from(input.bytes),
        signal: this.requestDeadline().signal(),
      });
    } catch (error) {
      // Une coupure après acceptation du POST est indiscernable d'un refus réseau. Une relecture
      // exacte transforme ce cas en succès idempotent ; sinon l'erreur primaire est conservée.
      const raced = await this.get(input.companyId, input.key).catch(() => null);
      if (isExact(raced)) return { ...raced, created: false };
      throw error;
    }
    if (!response.ok) {
      const responseText = await response.text();
      // Deux workers peuvent constater l'absence puis uploader la même clé. Le perdant adopte
      // uniquement un objet strictement identique ; une collision différente reste fatale.
      const raced = await this.get(input.companyId, input.key);
      if (isExact(raced)) {
        return { ...raced, created: false };
      }
      throw new Error(`Supabase storage upload failed: ${response.status} ${responseText}`);
    }
    const stored = await this.get(input.companyId, input.key);
    if (!isExact(stored)) {
      // Une clé publiée peut déjà avoir été adoptée par un retry concurrent. La supprimer ici
      // créerait une référence cassée ; une purge dédiée devra prouver l'absence de référence.
      throw new Error('Supabase storage read-after-write integrity mismatch.');
    }
    return { ...stored, created: true };
  }

  async get(
    companyId: string,
    key: string,
  ): Promise<LoadedStoredObject | null> {
    return this.getUntil(companyId, key, this.requestDeadline());
  }

  private async getUntil(
    companyId: string,
    key: string,
    deadline: CompositeRequestDeadline,
  ): Promise<LoadedStoredObject | null> {
    assertTenantStorageKey(companyId, key);
    const response = await fetch(this.objectUrl(key), {
      method: 'GET',
      headers: this.headers(),
      signal: deadline.signal(),
    });
    if (!response.ok) {
      const text = await response.text();
      if (SupabaseDocumentStorage.isNotFound(response.status, text)) return null;
      throw new Error(`Supabase storage download failed: ${response.status} ${text}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // L'en-tête du téléchargement n'est pas la métadonnée objet autoritative. Supabase peut
    // servir un XML byte-identique en `text/plain` alors que `/object/info` conserve bien
    // `application/xml` (incident staging du 2026-08-05). Taille/SHA restent dérivés des octets ;
    // seul le MIME vient de la métadonnée persistée, avec cohérence de taille fail-closed.
    const metadata = await this.statUntil(companyId, key, deadline);
    if (metadata === null) {
      throw new Error('Supabase storage metadata missing after object download.');
    }
    if (metadata.sizeBytes !== bytes.byteLength) {
      throw new Error('Supabase storage object and metadata size mismatch.');
    }
    return {
      key,
      bytes,
      sizeBytes: bytes.byteLength,
      sha256: documentSha256(bytes),
      contentType: metadata.contentType,
    };
  }

  async getSignedUrl(companyId: string, key: string, ttlSeconds: number): Promise<string> {
    assertTenantStorageKey(companyId, key);
    const deadline = this.requestDeadline();
    const response = await fetch(this.signUrl(key), {
      method: 'POST',
      headers: this.headers('application/json'),
      body: JSON.stringify({ expiresIn: ttlSeconds }),
      signal: deadline.signal(),
    });
    if (!response.ok)
      throw new Error(
        `Supabase storage signed URL failed: ${response.status} ${await response.text()}`,
      );
    const payload = (await response.json()) as { signedURL?: string; signedUrl?: string };
    const signed = payload.signedURL ?? payload.signedUrl;
    if (!signed) throw new Error('Supabase storage signed URL response missing URL.');
    if (signed.startsWith('http')) return signed;
    // Supabase renvoie un chemin relatif à /storage/v1 (« /object/sign/… ») : sans ce segment,
    // la gateway répond « requested path is invalid » (constaté en prod le 2026-07-18).
    const base = this.config.url.replace(/\/$/, '');
    return signed.startsWith('/storage/v1/') ? `${base}${signed}` : `${base}/storage/v1${signed}`;
  }

  async stat(
    companyId: string,
    key: string,
  ): Promise<{ sizeBytes: number; contentType: string } | null> {
    return this.statUntil(companyId, key, this.requestDeadline());
  }

  private async statUntil(
    companyId: string,
    key: string,
    deadline: CompositeRequestDeadline,
  ): Promise<{ sizeBytes: number; contentType: string } | null> {
    assertTenantStorageKey(companyId, key);
    // GET /object/info/ et non HEAD : un HEAD sans corps ne permet pas de distinguer le 400
    // « not_found » de Supabase d'une vraie erreur (cause du xmlDocumentId null en prod).
    const response = await fetch(this.infoUrl(key), {
      method: 'GET',
      headers: this.headers(),
      signal: deadline.signal(),
    });
    if (!response.ok) {
      const text = await response.text();
      if (SupabaseDocumentStorage.isNotFound(response.status, text)) return null;
      throw new Error(`Supabase storage stat failed: ${response.status} ${text}`);
    }
    let info: unknown;
    try {
      info = await response.json();
    } catch {
      throw new Error('Supabase Storage object info response is not valid JSON.');
    }
    // Une réponse Storage malformée ne doit jamais être présentée comme un vrai fichier vide.
    return parseSupabaseObjectInfo(info);
  }

  async remove(companyId: string, key: string): Promise<void> {
    assertTenantStorageKey(companyId, key);
    const deadline = this.requestDeadline();
    const response = await fetch(this.objectUrl(key), {
      method: 'DELETE',
      headers: this.headers(),
      signal: deadline.signal(),
    });
    if (!response.ok) {
      const text = await response.text();
      if (SupabaseDocumentStorage.isNotFound(response.status, text)) return;
      throw new Error(`Supabase storage delete failed: ${response.status} ${text}`);
    }
  }
}

function normalizedContentType(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

export function buildDocumentStorage(): DocumentStoragePort {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis pour le stockage documentaire live.',
    );
  }
  return new SupabaseDocumentStorage({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_STORAGE_BUCKET,
  });
}
