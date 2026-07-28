export const LOCAL_WHISPER_AUDIT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  privateHostname: 'bob-live-whisper-audit.railway.internal',
  privatePort: '8080',
  basePath: '/v1',
  engine: Object.freeze({
    id: 'whisper.cpp',
    version: 'v1.9.1',
    sourceSha256: '147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447',
  }),
  model: Object.freeze({
    id: 'whisper-large-v3-turbo',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    bytes: 574_041_195,
  }),
  healthPath: '/health',
  transcriptionPath: '/audio/transcriptions',
  maxRequestBytes: 4_259_840,
  maxHealthResponseBytes: 4 * 1024,
  healthTimeoutMs: 1_500,
});

const LOCAL_WHISPER_AUDIT_TOKEN_PATTERN = /^[\x21-\x7e]{32,256}$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Le jeton traverse deux processus distincts. Cette validation reste donc byte-identique au
 * gateway : ASCII visible uniquement, sans trim implicite ni secret surdimensionné.
 */
export function isValidLocalWhisperAuditToken(token: unknown): token is string {
  return typeof token === 'string' && LOCAL_WHISPER_AUDIT_TOKEN_PATTERN.test(token);
}

export interface LocalWhisperAuditEndpoints {
  readonly topology: 'loopback' | 'railway-private';
  readonly baseUrl: string;
  readonly healthUrl: string;
  readonly transcriptionUrl: string;
}

export function parseLocalWhisperAuditBaseUrl(baseUrl: string): LocalWhisperAuditEndpoints {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('local_whisper_invalid_config');
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  const railwayPrivate = parsed.hostname === LOCAL_WHISPER_AUDIT_CONTRACT.privateHostname;
  const canonicalPath = parsed.pathname === LOCAL_WHISPER_AUDIT_CONTRACT.basePath
    || parsed.pathname === `${LOCAL_WHISPER_AUDIT_CONTRACT.basePath}/`;
  const canonicalPrivateDestination = railwayPrivate
    && parsed.protocol === 'http:'
    && parsed.port === LOCAL_WHISPER_AUDIT_CONTRACT.privatePort;
  const canonicalLoopbackDestination = loopback
    && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  if (
    !canonicalPath
    || (!canonicalPrivateDestination && !canonicalLoopbackDestination)
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('local_whisper_invalid_config');
  }
  const canonicalBaseUrl = `${parsed.protocol}//${parsed.host}${LOCAL_WHISPER_AUDIT_CONTRACT.basePath}`;
  return Object.freeze({
    topology: railwayPrivate ? 'railway-private' : 'loopback',
    baseUrl: canonicalBaseUrl,
    healthUrl: `${canonicalBaseUrl}${LOCAL_WHISPER_AUDIT_CONTRACT.healthPath}`,
    transcriptionUrl: `${canonicalBaseUrl}${LOCAL_WHISPER_AUDIT_CONTRACT.transcriptionPath}`,
  });
}

export function isLocalWhisperAuditHealthPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const payload = value as {
    readonly status?: unknown;
    readonly schemaVersion?: unknown;
    readonly engine?: {
      readonly id?: unknown;
      readonly version?: unknown;
      readonly sourceSha256?: unknown;
    };
    readonly model?: {
      readonly id?: unknown;
      readonly sha256?: unknown;
      readonly bytes?: unknown;
    };
    readonly capacity?: {
      readonly active?: unknown;
      readonly queued?: unknown;
    };
  };
  return payload.status === 'ready'
    && payload.schemaVersion === LOCAL_WHISPER_AUDIT_CONTRACT.schemaVersion
    && payload.engine?.id === LOCAL_WHISPER_AUDIT_CONTRACT.engine.id
    && payload.engine.version === LOCAL_WHISPER_AUDIT_CONTRACT.engine.version
    && payload.engine.sourceSha256 === LOCAL_WHISPER_AUDIT_CONTRACT.engine.sourceSha256
    && payload.model?.id === LOCAL_WHISPER_AUDIT_CONTRACT.model.id
    && payload.model.sha256 === LOCAL_WHISPER_AUDIT_CONTRACT.model.sha256
    && payload.model.bytes === LOCAL_WHISPER_AUDIT_CONTRACT.model.bytes
    && Number.isInteger(payload.capacity?.active)
    && Number.isInteger(payload.capacity?.queued)
    && Number(payload.capacity?.active) >= 0
    && Number(payload.capacity?.active) <= 1
    && Number(payload.capacity?.queued) >= 0
    && Number(payload.capacity?.queued) <= 2;
}
