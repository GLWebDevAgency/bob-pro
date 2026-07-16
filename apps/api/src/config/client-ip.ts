import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export type ClientIpTracker = (request: Record<string, unknown>) => string;

interface ClientIpTrackerOptions {
  readonly railwayRuntime?: boolean;
}

const RAILWAY_RUNTIME_KEYS = [
  'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_SERVICE_ID',
  'RAILWAY_DEPLOYMENT_ID',
  'RAILWAY_REPLICA_ID',
] as const;

const RAILWAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Les cinq valeurs sont injectées par Railway au déploiement. Les exiger ensemble évite qu'une
 * variable homonyme laissée dans un poste local active par accident la confiance dans X-Real-IP.
 */
export function isRailwayRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return RAILWAY_RUNTIME_KEYS.every((key) => RAILWAY_ID.test(environment[key] ?? ''));
}

function normalizeIpAddress(value: string): string | null {
  if (value.length === 0 || value.length > 45 || value.trim() !== value || value.includes('%')) {
    return null;
  }
  const version = isIP(value);
  if (version === 0) return null;
  try {
    // Le préfiltre node:net refuse notamment les IPv4 octales que ipaddr.js 1.x accepte.
    // `process` ramène aussi toutes les écritures IPv4-mapped IPv6 vers la même clé IPv4.
    return ipaddr.process(value).toString().toLowerCase();
  } catch {
    return null;
  }
}

function rawHeaderValues(request: Record<string, unknown>, headerName: string): string[] {
  const rawHeaders = request['rawHeaders'];
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return [];
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name === 'string' && name.toLowerCase() === headerName && typeof value === 'string')
      values.push(value);
  }
  return values;
}

function socketIp(request: Record<string, unknown>): string {
  const socket = request['socket'];
  const candidate =
    typeof socket === 'object' && socket !== null
      ? (socket as Record<string, unknown>)['remoteAddress']
      : null;
  return typeof candidate === 'string' ? (normalizeIpAddress(candidate) ?? 'unknown') : 'unknown';
}

function railwayClientIp(request: Record<string, unknown>): string | null {
  const railwayClientIps = rawHeaderValues(request, 'x-real-ip');
  return railwayClientIps.length === 1 ? normalizeIpAddress(railwayClientIps[0]!) : null;
}

export function clientIpSourceForRequest(
  request: Record<string, unknown>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): 'railway-x-real-ip' | 'railway-invalid' | 'socket' {
  if (!isRailwayRuntime(environment)) return 'socket';
  return railwayClientIp(request) === null ? 'railway-invalid' : 'railway-x-real-ip';
}

/**
 * Railway publie X-Real-IP comme adresse cliente canonique et ne publie pas de plage stable de
 * proxies edge. On n'active donc jamais `trust proxy`/X-Forwarded-For dans Express : hors Railway,
 * seul le peer TCP compte ; sur Railway, un unique X-Real-IP valide est accepté. Toute absence,
 * duplication ou ambiguïté retombe sur une clé d'échec fermée liée au socket edge.
 */
export function createClientIpTracker(options: ClientIpTrackerOptions = {}): ClientIpTracker {
  const railwayRuntime = options.railwayRuntime ?? isRailwayRuntime();
  return (request) => {
    const peer = socketIp(request);
    if (!railwayRuntime) return `peer:${peer}`;
    const clientIp = railwayClientIp(request);
    return clientIp === null ? `railway-invalid:${peer}` : `railway:${clientIp}`;
  };
}
