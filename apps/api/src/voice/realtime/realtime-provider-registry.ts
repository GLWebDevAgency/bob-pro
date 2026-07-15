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

/**
 * Port minimal de terminaison d'un fournisseur temps réel.
 *
 * L'identifiant du fournisseur appartient à l'adapter et non à la configuration courante :
 * après un déploiement OpenAI -> Mistral, un ancien bail OpenAI doit toujours être envoyé à
 * l'adapter OpenAI qui l'a créé.
 */
export interface RealtimeProviderTerminationAdapter {
  readonly providerId: RealtimeProviderId;
  hangupCall(
    providerCallId: string,
    hardExpiryProof?: RealtimeDatabaseHardExpiryProof,
  ): Promise<void>;
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

  async hangupCall(identity: RealtimeProviderCallIdentity): Promise<void> {
    if (
      !isRealtimeCompanyId(identity.companyId)
      || !isRealtimeSubjectHash(identity.subjectHash)
      || !isRealtimeSessionId(identity.sessionId)
      || !isRealtimeProviderId(identity.providerId)
      || !isRealtimeProviderCallId(identity.providerCallId)
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

    // Une preuve DB post-hard-cap ne doit pas rester coalescée derrière une tentative egress
    // antérieure sans preuve : elle constitue une autorité terminale plus forte.
    const key = `${identity.providerId}\u0000${identity.providerCallId}\u0000${identity.hardExpiryProof ? 'hard' : 'egress'}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const hangup = Promise.resolve().then(() => (
      identity.hardExpiryProof
        ? adapter.hangupCall(identity.providerCallId, identity.hardExpiryProof)
        : adapter.hangupCall(identity.providerCallId)
    ));
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
  provider: Pick<RealtimeProviderTerminationAdapter, 'hangupCall'>,
): RealtimeProviderTerminationAdapter {
  return Object.freeze({
    providerId,
    hangupCall: (
      providerCallId: string,
      hardExpiryProof?: RealtimeDatabaseHardExpiryProof,
    ) => (
      hardExpiryProof
        ? provider.hangupCall(providerCallId, hardExpiryProof)
        : provider.hangupCall(providerCallId)
    ),
  });
}
