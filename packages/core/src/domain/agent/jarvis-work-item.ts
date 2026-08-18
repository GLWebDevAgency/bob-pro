/**
 * Domaine des work items Jarvis (spec §5.3) — lot U1-b.
 *
 * Le reducer ÉMET des intentions (`JarvisWorkItemIntent`) ; il ne lease, n'autorise ni
 * n'exécute jamais (worker U1-c). L'intention est le miroir 1:1 des colonnes de la
 * table `jarvis_work_items` posée par U1-a : l'admission U1-c ne fait que mapper.
 * Un work item ne duplique jamais une outbox métier : il soumettra UNE fois la
 * commande idempotente à l'outbox canonique puis l'observera (`submittedJobRef`).
 */

import { type Instant } from '../../shared-kernel/time';

// BEGIN GENERATED JARVIS_WORK_ITEM_STATUSES (miroir migration U1-a)
export const JARVIS_WORK_ITEM_STATUSES = Object.freeze([
  'prepared',
  'leased',
  'authorized',
  'retry_due',
  'succeeded',
  'failed_terminal',
  'outcome_unknown',
  'cancelling',
  'cancelled',
] as const);
// END GENERATED JARVIS_WORK_ITEM_STATUSES
export type JarvisWorkItemStatus = (typeof JARVIS_WORK_ITEM_STATUSES)[number];

/**
 * Source d'autorisation fermée (spec §5.3). `authorized` est le point de non-retour :
 * après lui, une annulation OBSERVE (`cancelling`), elle ne prétend jamais qu'un appel
 * possiblement parti est annulé.
 */
export type JarvisAuthorizationSource =
  | { readonly source: 'confirmation'; readonly receiptId: string }
  | {
      readonly source: 'mandate_grant';
      readonly grantId: string;
      readonly revision: number;
      readonly digest: string;
      readonly expiresAt: Instant;
    }
  | {
      readonly source: 'certified_system_rule';
      readonly ruleId: string;
      readonly ruleVersion: number;
      readonly observationScope: string;
    };

const AUTHORIZATION_KEYS: Record<JarvisAuthorizationSource['source'], readonly string[]> = {
  confirmation: ['source', 'receiptId'],
  mandate_grant: ['source', 'grantId', 'revision', 'digest', 'expiresAt'],
  certified_system_rule: ['source', 'ruleId', 'ruleVersion', 'observationScope'],
};

export type JarvisAuthorizationSourceParseError = {
  readonly code: 'invalid_authorization_source';
  readonly reason: 'invalid_shape' | 'unknown_source' | 'unexpected_key' | 'missing_key';
};

/** Parse exact-keys : toute clé inconnue ou manquante refuse — jamais de tolérance. */
export function parseJarvisAuthorizationSource(
  value: unknown,
):
  | { readonly ok: true; readonly value: JarvisAuthorizationSource }
  | { readonly ok: false; readonly error: JarvisAuthorizationSourceParseError } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: { code: 'invalid_authorization_source', reason: 'invalid_shape' } };
  }
  const record = value as Record<string, unknown>;
  const source = record['source'];
  if (
    source !== 'confirmation' &&
    source !== 'mandate_grant' &&
    source !== 'certified_system_rule'
  ) {
    return { ok: false, error: { code: 'invalid_authorization_source', reason: 'unknown_source' } };
  }
  const expected = AUTHORIZATION_KEYS[source];
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!expected.includes(key)) {
      return {
        ok: false,
        error: { code: 'invalid_authorization_source', reason: 'unexpected_key' },
      };
    }
  }
  for (const key of expected) {
    if (!(key in record)) {
      return { ok: false, error: { code: 'invalid_authorization_source', reason: 'missing_key' } };
    }
  }
  return { ok: true, value: value as JarvisAuthorizationSource };
}

/**
 * Intention d'effet émise par une transition pure — miroir exact des colonnes
 * `jarvis_work_items` (U1-a). L'`effectId` est préalloué par le SERVEUR dans la
 * transaction d'admission (spec §5.4) : la transition le reçoit, ne l'invente pas.
 */
export interface JarvisWorkItemIntent {
  readonly effectId: string;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly authorizationSource: JarvisAuthorizationSource;
  readonly actingPrincipalId: string;
  readonly targetDigest: string | null;
  readonly payloadRef: Readonly<Record<string, string>> | null;
  readonly executeBy: Instant;
}
