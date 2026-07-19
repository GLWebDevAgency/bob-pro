import { createHash } from 'node:crypto';
import {
  isRealtimeDatabaseHardExpiryProof,
  isRealtimeCompanyId,
  isRealtimeProviderCallId,
  isRealtimeProviderId,
  isRealtimeSessionId,
  isRealtimeSubjectHash,
  type RealtimeDatabaseHardExpiryProof,
  type RealtimeProviderId,
} from './realtime-admission';

export interface RealtimeProviderCallIdentity {
  companyId: string;
  subjectHash: string;
  sessionId: string;
  providerId: RealtimeProviderId;
  providerCallId: string;
  hardExpiryProof: RealtimeDatabaseHardExpiryProof | null;
}

export type RealtimeProviderTerminationCause =
  | 'explicit_hangup'
  | 'lease_expired'
  | 'reservation_recovery';

/** Claim complet owner-fencé. Le token brut n'est ni loggé ni utilisé comme clé en mémoire. */
export interface RealtimeProviderTerminationRequest extends RealtimeProviderCallIdentity {
  reaperToken: string;
  reaperLeaseExpiresAt: string;
  terminationCause: RealtimeProviderTerminationCause;
}

/**
 * Port minimal de terminaison d'un fournisseur temps réel.
 *
 * L'identifiant du fournisseur appartient à l'adapter et non à la configuration courante :
 * après un déploiement OpenAI -> Mistral, un ancien bail OpenAI doit toujours être envoyé à
 * l'adapter OpenAI qui l'a créé.
 */
export interface RealtimeProviderTerminationAdapter {
  readonly providerId: RealtimeProviderId;
  hangupCall(request: RealtimeProviderTerminationRequest): Promise<void>;
}

export class RealtimeProviderRegistryError extends Error {
  readonly code:
    | 'invalid_provider_adapter'
    | 'duplicate_provider_adapter'
    | 'invalid_provider_identity'
    | 'provider_adapter_unavailable';

  constructor(code: RealtimeProviderRegistryError['code']) {
    // Aucun providerCallId n'est incorporé au message : les logs restent sans identifiant distant.
    super(`realtime_${code}`);
    this.name = 'RealtimeProviderRegistryError';
    this.code = code;
  }
}

/**
 * Registre fermé des adapters de terminaison.
 *
 * Le routage dépend exclusivement du couple durable `(providerId, providerCallId)`. Il ne consulte
 * jamais le provider actuellement sélectionné dans l'environnement. Une identité non reconnue est
 * conservée sous fence reaper au lieu d'être envoyée à un endpoint potentiellement incorrect.
 */
export class RealtimeProviderTerminationRegistry {
  private readonly adapters = new Map<RealtimeProviderId, RealtimeProviderTerminationAdapter>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(adapters: readonly RealtimeProviderTerminationAdapter[]) {
    for (const adapter of adapters) {
      if (!adapter || !isRealtimeProviderId(adapter.providerId) || typeof adapter.hangupCall !== 'function') {
        throw new RealtimeProviderRegistryError('invalid_provider_adapter');
      }
      if (this.adapters.has(adapter.providerId)) {
        throw new RealtimeProviderRegistryError('duplicate_provider_adapter');
      }
      // Capturer la méthode à l'enregistrement empêche une mutation ultérieure de l'objet DI de
      // changer silencieusement la cible réseau d'un provider déjà certifié.
      const hangupCall = adapter.hangupCall.bind(adapter);
      this.adapters.set(adapter.providerId, Object.freeze({
        providerId: adapter.providerId,
        hangupCall,
      }));
    }
  }

  has(providerId: RealtimeProviderId): boolean {
    return this.adapters.has(providerId);
  }

  async hangupCall(identity: RealtimeProviderTerminationRequest): Promise<void> {
    const reaperExpiry = Date.parse(identity.reaperLeaseExpiresAt);
    if (
      !isRealtimeCompanyId(identity.companyId)
      || !isRealtimeSubjectHash(identity.subjectHash)
      || !isRealtimeSessionId(identity.sessionId)
      || !isRealtimeProviderId(identity.providerId)
      || !isRealtimeProviderCallId(identity.providerCallId)
      || !/^[A-Za-z0-9_-]{32,128}$/u.test(identity.reaperToken)
      || !Number.isFinite(reaperExpiry)
      || new Date(reaperExpiry).toISOString() !== identity.reaperLeaseExpiresAt
      || (
        identity.terminationCause !== 'explicit_hangup'
        && identity.terminationCause !== 'lease_expired'
        && identity.terminationCause !== 'reservation_recovery'
      )
      || (
        identity.hardExpiryProof !== null
        && (
          !isRealtimeDatabaseHardExpiryProof(identity.hardExpiryProof)
          || identity.hardExpiryProof.companyId !== identity.companyId
          || identity.hardExpiryProof.subjectHash !== identity.subjectHash
          || identity.hardExpiryProof.sessionId !== identity.sessionId
          || identity.hardExpiryProof.providerId !== identity.providerId
          || identity.hardExpiryProof.providerCallId !== identity.providerCallId
        )
      )
    ) {
      throw new RealtimeProviderRegistryError('invalid_provider_identity');
    }
    const adapter = this.adapters.get(identity.providerId);
    if (!adapter) throw new RealtimeProviderRegistryError('provider_adapter_unavailable');

    // Deux claims successifs portent des fences différents et ne doivent jamais être coalescés.
    // Seule l'empreinte du secret vit en mémoire ; le token brut ne devient pas une clé JS longue.
    const reaperTokenHash = createHash('sha256')
      .update(identity.reaperToken, 'utf8')
      .digest('hex');
    const proofVersion = identity.hardExpiryProof?.leaseVersion ?? 0;
    const key = [
      identity.companyId,
      identity.subjectHash,
      identity.sessionId,
      identity.providerId,
      identity.providerCallId,
      reaperTokenHash,
      identity.reaperLeaseExpiresAt,
      identity.terminationCause,
      String(proofVersion),
    ].join('\u0000');
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const request = Object.freeze({
      ...identity,
      hardExpiryProof: identity.hardExpiryProof
        ? Object.freeze({ ...identity.hardExpiryProof })
        : null,
    });
    const hangup = Promise.resolve().then(() => adapter.hangupCall(request));
    this.inFlight.set(key, hangup);
    try {
      await hangup;
    } finally {
      if (this.inFlight.get(key) === hangup) this.inFlight.delete(key);
    }
  }
}

/** Associe explicitement un port historique à son fournisseur, sans lui faire lire la config live. */
export function realtimeProviderTerminationAdapter(
  providerId: RealtimeProviderId,
  provider: {
    hangupCall(
      providerCallId: string,
      hardExpiryProof?: RealtimeDatabaseHardExpiryProof,
    ): Promise<void>;
  },
): RealtimeProviderTerminationAdapter {
  return Object.freeze({
    providerId,
    hangupCall: (request: RealtimeProviderTerminationRequest) => (
      request.hardExpiryProof
        ? provider.hangupCall(request.providerCallId, request.hardExpiryProof)
        : provider.hangupCall(request.providerCallId)
    ),
  });
}
