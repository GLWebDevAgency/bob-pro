/**
 * Port du payload store PII des propositions Jarvis (spec §5.1/§5.5) — lot U1-d,
 * SPEC_U1D_CALLERS_REELS_20260819 §3 « MOBILE » et greffe G4.
 *
 * Le state d'un run ne porte QUE des digests : les champs proposés — de la PII — vivent dans ce
 * store à finalité dédiée, scellé par `fieldsDigest`, écrit IDEMPOTENT **avant** `stage_proposal`
 * (un crash entre les deux laisse un orphelin, ramassé par la rétention §5.5, jamais une
 * proposition sans charge). La relecture revérifie le digest : toute divergence rend la charge
 * absente — fail-closed, jamais une présentation approximative.
 *
 * L'implémentation durable arrive avec la lane exécuteur ; les appelants (voix, tap, worker)
 * ne connaissent que ce contrat.
 */

import type { CustomerContactProposedFieldsV1 } from '../../domain/agent/customer-contact-semantic-frame';

/** Référence opaque d'une charge : le couple scellé (proposition, digest) du work item §5.3. */
export interface JarvisProposalPayloadRef {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly runId: string;
  readonly proposalId: string;
  readonly fieldsDigest: string;
}

export interface JarvisProposalPayloadV1 extends JarvisProposalPayloadRef {
  readonly sensitiveDigest: string;
  readonly fields: CustomerContactProposedFieldsV1;
}

export interface JarvisProposalPayloadSealInput extends JarvisProposalPayloadRef {
  readonly sensitiveDigest: string;
  readonly fields: CustomerContactProposedFieldsV1;
  /** Purge §5.5 : la charge s'efface d'elle-même, jamais « un jour, à la main ». */
  readonly retentionExpiresAt: string;
}

/**
 * Résultat fermé du scellement — l'appelant n'a jamais à deviner :
 * - `sealed` : la charge est écrite et lisible ;
 * - `replayed` : la MÊME charge existait déjà (retry du même tour) — zéro écriture ;
 * - `conflict` : le même `proposalId` porte déjà une charge différente — jamais d'écrasement ;
 * - `unavailable` : dépendance indisponible ; l'appelant n'admet alors AUCUNE proposition.
 */
export type JarvisProposalPayloadSealResult =
  | { readonly status: 'sealed' | 'replayed' }
  | { readonly status: 'conflict' }
  | { readonly status: 'unavailable' };

export interface JarvisProposalPayloadStorePort {
  sealProposalPayload(
    input: JarvisProposalPayloadSealInput,
  ): Promise<JarvisProposalPayloadSealResult>;
  /** `null` = absente OU digest divergent : la présentation se rend alors indisponible (G4). */
  readProposalPayload(ref: JarvisProposalPayloadRef): Promise<JarvisProposalPayloadV1 | null>;
}
