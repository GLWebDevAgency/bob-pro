/**
 * Adapter d'admission Jarvis (spec §5.2/§5.3/§17 — SPEC_U1D_CALLERS_REELS_20260819 §3
 * « HMAC/DEPS ») — lot U1-d, vague B du vertical.
 *
 * Le port core `JarvisAdmissionUnitOfWorkPort` est MONO-ARGUMENT : un appelant (voix, tap,
 * worker) ne connaît qu'une enveloppe. La persistance, elle, exige ses dépendances PAR APPEL
 * (`JarvisAdmissionDeps` : signeur HMAC, version de canonicalisation, kill switch, drapeau de
 * harnais). Ce fichier est la seule couture entre les deux — et il n'en existe qu'une :
 *
 * - le signeur est le keyring quote DÉJÀ construit (`AGENT_MISSION_FINGERPRINTS`, exporté par
 *   `AgentMissionModule`) : une seule instance, une seule readiness au boot, zéro duplication —
 *   ce fichier ne re-déclare JAMAIS le keyring ;
 * - `canonicalizationVersion` vaut 1 (contrat `agentMissionEvent` du journal durable) ;
 * - `admissionEnabled` est relu À CHAQUE APPEL (`BOB_JARVIS_ADMISSION_ENABLED`, patron
 *   `jarvisDispatchEnabled`) : un kill switch figé au boot ne se coupe jamais à chaud ;
 * - `allowCertificationAuthority` est LITTÉRALEMENT `false` — la source `certification_fixture`
 *   n'existe que pour le harnais, jamais dans un câblage de production.
 *
 * La MÊME instance sert le canal tactile (controller) et le worker de dispatch (§5.3) : deux
 * adapters signeraient les mêmes reçus avec deux configurations, donc un jour avec deux vérités.
 */

import type { Provider } from '@nestjs/common';
import type {
  AgentMissionFingerprintPort,
  JarvisAdmissionOwner,
  JarvisAdmissionResult,
  JarvisAdmissionUnitOfWorkPort,
  JarvisRunEnvelope,
  JarvisStatelessReadResult,
  JarvisSystemAdmissionEnvelope,
  JarvisUserAdmissionEnvelope,
} from '@bob/core';

import { AGENT_MISSION_FINGERPRINTS } from '../agent-missions/agent-mission-fingerprint.provider';
import { JARVIS_DISPATCH_ADMISSION } from '../jobs/jarvis-work-item-dispatch.service';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import type { JarvisAdmissionDeps } from '../persistence/prisma/jarvis-admission.persistence';

import { JARVIS_ADMISSION } from './jarvis.tokens';

/** Contrat `agentMissionEvent` du journal durable — jamais un nombre libre. */
export const JARVIS_CANONICALIZATION_VERSION = 1;

/**
 * Kill switch d'ADMISSION (§5.3), distinct du kill switch de dispatch : il bloque les nouvelles
 * commandes utilisateur et JAMAIS les signaux d'effets déjà autorisés (la persistance ne
 * l'oppose qu'aux enveloppes `user`). Lu à chaque appel — jamais figé au boot.
 */
export function jarvisAdmissionEnabled(): boolean {
  return process.env.BOB_JARVIS_ADMISSION_ENABLED !== 'false';
}

/**
 * Surface EXACTE consommée sur le UoW unique (§17 : un seul UoW, jamais un second). Elle n'est
 * pas le port core — elle en est la forme « à dépendances explicites » que la persistance
 * expose ; l'adapter ci-dessous est précisément ce qui les sépare.
 */
export interface JarvisAdmissionUnitOfWorkAuthority {
  runJarvisAdmission(
    envelope: JarvisUserAdmissionEnvelope,
    deps: JarvisAdmissionDeps,
  ): Promise<JarvisAdmissionResult>;
  runJarvisSystemAdmission(
    envelope: JarvisSystemAdmissionEnvelope,
    deps: JarvisAdmissionDeps,
  ): Promise<JarvisAdmissionResult>;
  readJarvisStateless<T>(
    owner: JarvisAdmissionOwner,
    read: (view: {
      readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
    }) => Promise<T>,
  ): Promise<JarvisStatelessReadResult<T>>;
}

/**
 * Résolution FERMÉE de l'autorité transactionnelle : un adapter de persistance qui ne sait pas
 * prouver l'admission Jarvis (double mémoire, harnais partiel) n'en fournit pas une moitié — il
 * n'en fournit AUCUNE, et l'appelant échoue fermé (503) plutôt que d'écrire à l'aveugle.
 */
export function jarvisAdmissionUnitOfWork(
  persistence: Pick<Persistence, 'createAgentMissionUnitOfWork'>,
): JarvisAdmissionUnitOfWorkAuthority | null {
  const candidate = persistence.createAgentMissionUnitOfWork() as
    | Partial<JarvisAdmissionUnitOfWorkAuthority>
    | null;
  if (candidate === null) return null;
  return typeof candidate.runJarvisAdmission === 'function'
    && typeof candidate.runJarvisSystemAdmission === 'function'
    && typeof candidate.readJarvisStateless === 'function'
    ? (candidate as JarvisAdmissionUnitOfWorkAuthority)
    : null;
}

/** Le port mono-argument, réalisé : les deps sont capturées ici et nulle part ailleurs. */
export class JarvisAdmissionAdapter implements JarvisAdmissionUnitOfWorkPort {
  constructor(
    private readonly unitOfWork: JarvisAdmissionUnitOfWorkAuthority,
    private readonly fingerprints: AgentMissionFingerprintPort,
  ) {}

  private deps(): JarvisAdmissionDeps {
    return Object.freeze({
      fingerprints: this.fingerprints,
      canonicalizationVersion: JARVIS_CANONICALIZATION_VERSION,
      admissionEnabled: jarvisAdmissionEnabled(),
      // Jamais `true` dans un câblage de production : la fixture est réservée au harnais.
      allowCertificationAuthority: false,
    });
  }

  runJarvisAdmission(envelope: JarvisUserAdmissionEnvelope): Promise<JarvisAdmissionResult> {
    return this.unitOfWork.runJarvisAdmission(envelope, this.deps());
  }

  runJarvisSystemAdmission(
    envelope: JarvisSystemAdmissionEnvelope,
  ): Promise<JarvisAdmissionResult> {
    return this.unitOfWork.runJarvisSystemAdmission(envelope, this.deps());
  }

  readJarvisStateless<T>(
    owner: JarvisAdmissionOwner,
    read: (view: {
      readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
    }) => Promise<T>,
  ): Promise<JarvisStatelessReadResult<T>> {
    return this.unitOfWork.readJarvisStateless(owner, read);
  }
}

export function buildJarvisAdmission(
  persistence: Pick<Persistence, 'createAgentMissionUnitOfWork'>,
  fingerprints: AgentMissionFingerprintPort,
): JarvisAdmissionUnitOfWorkPort | null {
  const unitOfWork = jarvisAdmissionUnitOfWork(persistence);
  return unitOfWork === null ? null : new JarvisAdmissionAdapter(unitOfWork, fingerprints);
}

export const jarvisAdmissionProvider: Provider = {
  provide: JARVIS_ADMISSION,
  inject: [PERSISTENCE, AGENT_MISSION_FINGERPRINTS],
  useFactory: buildJarvisAdmission,
};

/**
 * Le worker de dispatch (§5.3) reçoit LA MÊME instance : `useExisting`, jamais une seconde
 * fabrique. Un adapter par appelant serait deux configurations de signature pour un seul journal.
 */
export const jarvisDispatchAdmissionProvider: Provider = {
  provide: JARVIS_DISPATCH_ADMISSION,
  useExisting: JARVIS_ADMISSION,
};

/**
 * Autorité métier de l'exécuteur d'effet fiche client (`JarvisCustomerEffectAuthority`). Elle
 * n'est PAS fournie par cette tranche : l'écriture canonique passe par les use cases customer
 * (`createCustomer`/`updateCustomer`), dont l'adapter — avec sa portée tenant/principal et son
 * identifiant IMPOSÉ par le coordinateur §9.1 — est un livrable à part entière. Tant que ce
 * jeton n'est pas lié, le registre du worker reste VIDE pour ces actions : `executor_unregistered`
 * fail-closed, exactement comme en U1-c. Jamais un effet sans autorité.
 */
export const JARVIS_CUSTOMER_EFFECT_AUTHORITY = Symbol('JARVIS_CUSTOMER_EFFECT_AUTHORITY');
