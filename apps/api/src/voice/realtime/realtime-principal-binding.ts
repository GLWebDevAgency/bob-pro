import { createHmac } from 'node:crypto';
import type { RealtimeVoiceSettings } from './realtime.types';

export interface RealtimeSubjectBinding {
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
}

export interface RealtimeSubjectBindings extends RealtimeSubjectBinding {
  readonly historicalSubjectBindings: readonly RealtimeSubjectBinding[];
}

export function admissionSubjectHash(
  secret: string,
  companyId: string,
  userId: string,
): string {
  return createHmac('sha256', secret)
    .update('bob-pro:realtime-admission:v1\u0000', 'utf8')
    .update(companyId, 'utf8')
    .update('\u0000', 'utf8')
    .update(userId, 'utf8')
    .digest('hex');
}

/**
 * Dérive l'identité de session depuis la configuration déjà validée au boot. La version courante
 * reste l'unique writer ; les versions retenues servent uniquement aux recherches/rotations.
 */
export function realtimeSubjectBindings(
  settings: RealtimeVoiceSettings,
  companyId: string,
  userId: string,
): RealtimeSubjectBindings | null {
  if (!settings.safetySecret) return null;
  const configured = settings.subjectHmacKeyRing ?? [];
  const keyRing = configured.length === 0
    ? [{ version: settings.subjectKeyVersion, secret: settings.safetySecret }]
    : configured;
  if (keyRing.length < 1 || keyRing.length > 32) return null;

  const versions = new Set<number>();
  const secrets = new Set<string>();
  const bindings: RealtimeSubjectBinding[] = [];
  for (const entry of keyRing) {
    if (
      !Number.isSafeInteger(entry.version)
      || entry.version < 1
      || entry.version > 0x7fff_ffff
      || typeof entry.secret !== 'string'
      || entry.secret.length < 32
      || versions.has(entry.version)
      || secrets.has(entry.secret)
    ) return null;
    versions.add(entry.version);
    secrets.add(entry.secret);
    bindings.push(Object.freeze({
      subjectHash: admissionSubjectHash(entry.secret, companyId, userId),
      subjectKeyVersion: entry.version,
    }));
  }
  const current = bindings.find(
    (binding) => binding.subjectKeyVersion === settings.subjectKeyVersion,
  );
  const currentConfig = keyRing.find(
    (entry) => entry.version === settings.subjectKeyVersion,
  );
  if (!current || currentConfig?.secret !== settings.safetySecret) return null;
  return Object.freeze({
    subjectHash: current.subjectHash,
    subjectKeyVersion: current.subjectKeyVersion,
    historicalSubjectBindings: Object.freeze(
      bindings.filter((binding) => binding !== current),
    ),
  });
}
