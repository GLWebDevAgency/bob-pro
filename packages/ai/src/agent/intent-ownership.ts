import {
  QUOTE_CREATION_MISSION_KIND_V1,
  sha256Hex,
  type MissionKindId,
} from '@bob/core';
import type { BobIntent } from './intent';
import { RUNTIME_TOOL_INTENTS } from './runtime-tool-intent';

export type IntentOwnership =
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'mission';
      readonly missionKind: MissionKindId;
      readonly legacyWhenNotAdmitted: true;
    }
  | {
      readonly kind: 'direct_capability';
      readonly capability: string;
    };

export type EffectiveIntentOwner =
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'mission';
      readonly missionKind: MissionKindId;
    }
  | {
      readonly kind: 'direct_capability';
      readonly capability: string;
    };

const LEGACY = Object.freeze({ kind: 'legacy' } as const);
const QUOTE_CREATION = Object.freeze({
  kind: 'mission',
  missionKind: QUOTE_CREATION_MISSION_KIND_V1,
  legacyWhenNotAdmitted: true,
} as const);

/**
 * Autorité exhaustive de transition.
 *
 * Une nouvelle intention casse le typecheck tant que son propriétaire n'est pas décidé.
 * Déclarer une capacité directe ne suffit pas à la migrer : le runtime correspondant doit être
 * câblé et certifié dans le même lot. K2 ne migre volontairement que `nouveau_devis`.
 */
export const INTENT_OWNERSHIP = Object.freeze({
  contexte_ecran: LEGACY,
  payout: LEGACY,
  relance: LEGACY,
  encaisser: LEGACY,
  factures: LEGACY,
  envoyer_devis: LEGACY,
  emettre_facture: LEGACY,
  generer_facture: LEGACY,
  export_fec: LEGACY,
  documents: LEGACY,
  scan: LEGACY,
  nouveau_devis: QUOTE_CREATION,
  creer_client: LEGACY,
  voir_chantiers: LEGACY,
  voir_catalogue: LEGACY,
  cloture: LEGACY,
  diagnostic: LEGACY,
  echeances: LEGACY,
  tva: LEGACY,
  balance: LEGACY,
  marquer_notifications_lues: LEGACY,
  payer_depense: LEGACY,
  depense_dictee: LEGACY,
  lier_depense_chantier: LEGACY,
  ajouter_equipement: LEGACY,
  parc_equipements: LEGACY,
  historique_equipement: LEGACY,
  retirer_equipement: LEGACY,
  preparer_facture_annuelle: LEGACY,
  statut_contrat: LEGACY,
  contrats_a_renouveler: LEGACY,
  creer_contrat_maintenance: LEGACY,
  activer_contrat: LEGACY,
  resilier_contrat: LEGACY,
  renommer_contrat: LEGACY,
  commencer_intervention: LEGACY,
  terminer_intervention: LEGACY,
  faire_signer_intervention: LEGACY,
  envoyer_fiche_passage: LEGACY,
  facturer_intervention: LEGACY,
  passages_intervention: LEGACY,
  reglages_intervention: LEGACY,
  valider_document: LEGACY,
  classer_document: LEGACY,
  renommer_document: LEGACY,
  chercher_document: LEGACY,
  lier_bon_commande: LEGACY,
  envoyer_facture: LEGACY,
  relance_devis: LEGACY,
  declarer_transmission: LEGACY,
  cadence_relances: LEGACY,
  facture_directe: LEGACY,
  facturer_situation: LEGACY,
  conditions_paiement: LEGACY,
  resultat: LEGACY,
  bilan: LEGACY,
  revue_cloture: LEGACY,
  pilotage: LEGACY,
  dso: LEGACY,
  top_clients: LEGACY,
  abonnement: LEGACY,
  aide: LEGACY,
  unknown: LEGACY,
} satisfies Readonly<Record<BobIntent, IntentOwnership>>);

export function effectiveIntentOwner(
  intent: BobIntent,
  admittedMissionKinds: ReadonlySet<MissionKindId>,
): EffectiveIntentOwner {
  const declared = INTENT_OWNERSHIP[intent];
  if (
    declared.kind === 'mission'
    && !admittedMissionKinds.has(declared.missionKind)
  ) {
    return LEGACY;
  }
  if (declared.kind === 'mission') {
    return Object.freeze({
      kind: 'mission',
      missionKind: declared.missionKind,
    });
  }
  return declared;
}

export function legacyBlockedIntents(
  admittedMissionKinds: readonly MissionKindId[],
): readonly BobIntent[] {
  const admitted = new Set(admittedMissionKinds);
  return Object.freeze(
    (Object.keys(INTENT_OWNERSHIP) as BobIntent[]).filter(
      (intent) => effectiveIntentOwner(intent, admitted).kind !== 'legacy',
    ),
  );
}

export const LEGACY_EXECUTION_AUTHORITY_SCHEMA_VERSION = 1 as const;

const ownershipContractCanonical = JSON.stringify([
  'bob.legacy-execution-authority.v1',
  (Object.keys(INTENT_OWNERSHIP) as BobIntent[])
    .sort()
    .map((intent) => [intent, INTENT_OWNERSHIP[intent]]),
  Object.entries(RUNTIME_TOOL_INTENTS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tool, toolContract]) => [
      tool,
      toolContract.resultIntent,
      [...toolContract.authorityIntents],
    ]),
]);

/** Change automatiquement si l'ownership ou le contrat d'un outil change. */
export const LEGACY_EXECUTION_AUTHORITY_CONTRACT_SHA256 = sha256Hex(
  ownershipContractCanonical,
);

export interface LegacyExecutionAuthority {
  readonly schemaVersion: typeof LEGACY_EXECUTION_AUTHORITY_SCHEMA_VERSION;
  readonly contractSha256: string;
  readonly admittedMissionKinds: readonly MissionKindId[];
  readonly blockedIntents: readonly BobIntent[];
  isIntentBlocked(intent: BobIntent): boolean;
}

/**
 * Factory unique de l'autorité historique. L'hôte fournit les kinds admis depuis son transport
 * authentifié ; aucun DTO utilisateur ne peut construire ou réduire cette policy.
 */
export function createLegacyExecutionAuthority(
  admittedMissionKinds: readonly MissionKindId[],
): LegacyExecutionAuthority {
  const admitted = Object.freeze(
    [...new Set(admittedMissionKinds)].sort(),
  ) as readonly MissionKindId[];
  const blockedIntents = legacyBlockedIntents(admitted);
  const blocked = new Set(blockedIntents);
  return Object.freeze({
    schemaVersion: LEGACY_EXECUTION_AUTHORITY_SCHEMA_VERSION,
    contractSha256: LEGACY_EXECUTION_AUTHORITY_CONTRACT_SHA256,
    admittedMissionKinds: admitted,
    blockedIntents,
    isIntentBlocked: (intent: BobIntent): boolean => blocked.has(intent),
  });
}
