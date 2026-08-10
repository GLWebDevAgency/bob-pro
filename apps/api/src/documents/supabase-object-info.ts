import { performance } from 'node:perf_hooks';

const MIME_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MIME_TYPE_PATTERN = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}$`, 'u');
const MIME_CHARSET_PARAMETER_PATTERN = /^charset=([A-Za-z0-9][A-Za-z0-9._-]*)$/iu;
const MIME_CONTENT_TYPE_MAX_LENGTH = 255;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}

export interface SupabaseObjectInfo {
  sizeBytes: number;
  contentType: string;
}

export interface RequestDeadlineRuntime {
  now?: () => number;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}

/**
 * Budget monotone partagé par toutes les requêtes qui composent une même opération Storage.
 * Une seconde sous-requête hérite du temps restant au lieu de repartir avec un timeout neuf.
 */
export class CompositeRequestDeadline {
  private readonly deadlineAt: number;
  private readonly now: () => number;
  private readonly timeoutSignal: (milliseconds: number) => AbortSignal;

  constructor(timeoutMs: number, runtime: RequestDeadlineRuntime = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('Storage request timeout must be between 1 and 60000 ms.');
    }
    this.now = runtime.now ?? (() => performance.now());
    this.timeoutSignal =
      runtime.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
    this.deadlineAt = this.now() + timeoutMs;
  }

  remainingMs(): number {
    return Math.max(0, Math.ceil(this.deadlineAt - this.now()));
  }

  signal(): AbortSignal {
    const remainingMs = this.remainingMs();
    if (remainingMs < 1) {
      throw new DOMException('Storage request deadline exceeded.', 'TimeoutError');
    }
    return this.timeoutSignal(remainingMs);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valide l'identité MIME fermée acceptée à l'écriture comme à la relecture Storage. */
export function parseStorageContentType(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length > MIME_CONTENT_TYPE_MAX_LENGTH
    || containsControlCharacter(value)
  ) {
    throw new Error('Supabase Storage object info response missing valid content type.');
  }
  const contentType = value.trim();
  const [rawMediaType = '', ...rawParameters] = contentType.split(';');
  const mediaType = rawMediaType.trim();
  if (!MIME_TYPE_PATTERN.test(mediaType) || mediaType.includes('*')) {
    throw new Error('Supabase Storage object info response missing valid content type.');
  }
  // Les documents Bob ne déclarent qu'un éventuel charset. Accepter un suffixe arbitraire
  // (`boundary`, paramètre vide, doublon...) rendrait la métadonnée fournisseur fail-open et
  // permettrait à un retry d'adopter une identité MIME que l'application n'a jamais publiée.
  if (
    rawParameters.length > 1
    || rawParameters.some((parameter) => !MIME_CHARSET_PARAMETER_PATTERN.test(parameter.trim()))
  ) {
    throw new Error('Supabase Storage object info response missing valid content type.');
  }
  return contentType;
}

/** Parse uniquement les champs autoritatifs de GET /storage/v1/object/info. */
export function parseSupabaseObjectInfo(value: unknown): SupabaseObjectInfo {
  if (!isRecord(value) || !Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw new Error('Supabase Storage object info response missing valid size.');
  }
  return {
    sizeBytes: value.size as number,
    contentType: parseStorageContentType(value.content_type),
  };
}
