/**
 * Property test `customer_contact@1` (spec U1B §3) — patron du property test SBA.
 *
 * Séquences ARBITRAIRES de commandes (PRNG déterministe seedé, jamais Math.random) :
 * à CHAQUE pas accepté, le run vérifie le contrat — statut dans l'union fermée §5.1
 * (donc jamais `expired`), `terminalAt` posé si et seulement si le statut est terminal,
 * `nextWakeAt` = dérivation pure des réveils du state, state RE-PARSÉ par le parse
 * public du module (round-trip), et AU PLUS UN `JarvisWorkItemIntent` cumulé par run,
 * toujours porté par l'unique effectId serveur pincé au démarrage (§5.4).
 */

import { describe, expect, it } from 'vitest';

import { jsonUtf8Fits } from '../../../shared-kernel/json-size';
import {
  JARVIS_RUN_STATUSES,
  JARVIS_RUN_TERMINAL_STATUSES,
  deriveNextWakeAt,
  type JarvisRunEnvelope,
} from '../jarvis-run';
import { type JarvisReduceContext, type JarvisTargetRevalidation } from '../jarvis-run-reducer';
import {
  CUSTOMER_CONTACT_LIMITS,
  CUSTOMER_CONTACT_SENSITIVE_FIELDS,
  CUSTOMER_CONTACT_V1,
  parseCustomerContactState,
  type CustomerContactCommand,
  type CustomerContactDuplicateCandidateV1,
  type CustomerContactStateV1,
} from './customer-contact-v1';

type CustomerContactRunEnvelope = Extract<
  JarvisRunEnvelope,
  { readonly kind: 'single_business_action' | 'customer_contact' }
>;

const T0 = '2026-08-18T10:00:00.000Z';

// ---------------------------------------------------------------------------
// PRNG déterministe seedé — jamais Math.random (patron single-business-action-v1)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prngHex(random: () => number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index++) {
    out += '0123456789abcdef'[Math.floor(random() * 16)];
  }
  return out;
}

function prngUuid(random: () => number): string {
  return `${prngHex(random, 8)}-${prngHex(random, 4)}-4${prngHex(random, 3)}-8${prngHex(random, 3)}-${prngHex(random, 12)}`;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

// ---------------------------------------------------------------------------
// Générateurs de commandes — plausibles pour la phase courante, 30 % de bruit
// ---------------------------------------------------------------------------

function startCommand(random: () => number): CustomerContactCommand {
  if (random() < 0.6) return { type: 'start_run', intent: { mode: 'create' } };
  return {
    type: 'start_run',
    intent: {
      mode: 'update',
      target: {
        customerId: `customer-${prngHex(random, 6)}`,
        revision: 1 + Math.floor(random() * 5),
      },
    },
  };
}

function duplicateCandidates(random: () => number): readonly CustomerContactDuplicateCandidateV1[] {
  const count = 1 + Math.floor(random() * 3);
  const candidates: CustomerContactDuplicateCandidateV1[] = [];
  for (let index = 0; index < count; index++) {
    candidates.push({
      choiceId: prngUuid(random),
      // Suffixe d'index : unicité des customerIds garantie, pas seulement probable.
      customerId: `customer-${index}-${prngHex(random, 8)}`,
      matchDigest: prngHex(random, 64),
    });
  }
  return candidates;
}

function stageProposalCommand(
  random: () => number,
  state: CustomerContactStateV1,
): CustomerContactCommand {
  const targetRevision =
    state.intent.mode === 'update'
      ? random() < 0.85
        ? state.intent.target.revision
        : state.intent.target.revision + 1
      : random() < 0.9
        ? null
        : 1;
  return {
    type: 'stage_proposal',
    proposalId: prngUuid(random),
    confirmationId: prngUuid(random),
    fieldsDigest: prngHex(random, 64),
    sensitiveDigest: prngHex(random, 64),
    targetRevision,
  };
}

function confirmCommand(
  random: () => number,
  state: CustomerContactStateV1,
): CustomerContactCommand {
  // Le wire d'un confirm ne porte QUE ces trois clés : la cible relue vit dans le contexte.
  return {
    type: 'confirm',
    confirmationId: state.confirmation?.confirmationId ?? prngUuid(random),
    proposalHash: state.proposal?.proposalHash ?? prngHex(random, 64),
  };
}

/** Digest sensible d'une cible « qui n'a pas bougé » — l'admission le dérive, ici on le simule. */
const STABLE_TARGET_DIGEST = 'a1'.repeat(32);

/**
 * Ce que l'ADMISSION produirait pour ce state : `null` hors cible, sinon la cible relue sous
 * verrou — la plupart du temps intacte, 25 % du temps mutée entre présentation et confirm (§9.1,
 * l'artisan corrige sa fiche pendant que la proposition est à l'écran).
 */
function targetRevalidationFor(
  random: () => number,
  state: CustomerContactStateV1 | null,
): JarvisTargetRevalidation | null {
  if (state === null || state.intent.mode !== 'update') return null;
  const sealedRevision = state.proposal?.targetRevision ?? state.intent.target.revision;
  const sealedDigest = state.proposal?.targetSensitiveDigest ?? STABLE_TARGET_DIGEST;
  if (random() >= 0.25) return { revision: sealedRevision, sensitiveDigest: sealedDigest };
  return random() < 0.5
    ? { revision: sealedRevision + 1, sensitiveDigest: sealedDigest }
    : { revision: sealedRevision, sensitiveDigest: prngHex(random, 64) };
}

function receiptCommand(
  random: () => number,
  state: CustomerContactStateV1,
): CustomerContactCommand {
  if (random() < 0.6) {
    const customerId =
      state.intent.mode === 'update'
        ? state.intent.target.customerId
        : `customer-${prngHex(random, 8)}`;
    return {
      type: 'record_effect_receipt',
      effectId: state.effectId,
      outcome: { kind: 'succeeded', customerId, customerRevision: 1 + Math.floor(random() * 9) },
    };
  }
  return {
    type: 'record_effect_receipt',
    effectId: state.effectId,
    outcome: { kind: 'failed_terminal', reasonCode: `reason-${prngHex(random, 6)}` },
  };
}

/** Commande plausible pour la phase courante — 30 % de bruit arbitraire bien formé. */
function generateCommand(
  random: () => number,
  state: CustomerContactStateV1,
): CustomerContactCommand {
  const noise = random() < 0.3;
  const confirmationId = state.confirmation?.confirmationId ?? prngUuid(random);
  const anyCommand = (): CustomerContactCommand =>
    pick<CustomerContactCommand>(random, [
      { type: 'start_run', intent: { mode: 'create' } },
      { type: 'record_customer_resolution', resolution: { kind: 'no_duplicates' } },
      {
        type: 'choose_duplicate_resolution',
        reviewId: state.duplicateReview?.reviewId ?? prngUuid(random),
        decision: { kind: 'continue_create' },
      },
      stageProposalCommand(random, state),
      {
        type: 'record_presentation_ack',
        confirmationId,
        ack: pick(random, ['screen_ack', 'voice_presentation_ack'] as const),
      },
      confirmCommand(random, state),
      { type: 'reject_proposal', confirmationId },
      {
        type: 'record_effect_submitted',
        effectId: state.effectId,
        submittedJobRef: random() < 0.5 ? `job-${prngHex(random, 6)}` : null,
      },
      receiptCommand(random, state),
      {
        type: 'cancel_run',
        reason: pick(random, ['user_cancelled', 'manual_handoff'] as const),
      },
      { type: 'wake_run', wakeId: state.confirmation?.wakeId ?? prngUuid(random) },
    ]);
  if (noise) return anyCommand();
  switch (state.phase) {
    case 'resolving_customer':
      if (state.intent.mode === 'update') {
        return {
          type: 'record_customer_resolution',
          resolution: {
            kind: 'target_verified',
            // Plus aucune révision au wire (§8) : la résolution DÉSIGNE la cible, la relecture
            // d'admission la DATE. Le générateur ne peut donc plus fabriquer de dérive ici —
            // elle se prouve désormais par `targetRevalidation`, où elle est réelle.
            customerId: state.intent.target.customerId,
          },
        };
      }
      return random() < 0.5
        ? { type: 'record_customer_resolution', resolution: { kind: 'no_duplicates' } }
        : {
            type: 'record_customer_resolution',
            resolution: {
              kind: 'duplicate_candidates',
              reviewId: prngUuid(random),
              candidates: duplicateCandidates(random),
            },
          };
    case 'awaiting_duplicate_review': {
      const review = state.duplicateReview;
      if (review !== null && review.candidates.length > 0 && random() < 0.5) {
        return {
          type: 'choose_duplicate_resolution',
          reviewId: review.reviewId,
          decision: { kind: 'use_existing', choiceId: pick(random, review.candidates).choiceId },
        };
      }
      return {
        type: 'choose_duplicate_resolution',
        reviewId: review?.reviewId ?? prngUuid(random),
        decision: { kind: 'continue_create' },
      };
    }
    case 'preparing_proposal':
      return stageProposalCommand(random, state);
    case 'awaiting_confirmation': {
      if (state.confirmation?.status === 'issued' && random() < 0.7) {
        return {
          type: 'record_presentation_ack',
          confirmationId: state.confirmation.confirmationId,
          ack: pick(random, ['screen_ack', 'voice_presentation_ack'] as const),
        };
      }
      if (random() < 0.15) {
        return { type: 'reject_proposal', confirmationId };
      }
      if (state.intent.mode === 'update' && random() < 0.15) {
        return {
          type: 'record_target_mutation',
          mutatedField: pick(random, CUSTOMER_CONTACT_SENSITIVE_FIELDS),
          targetRevision: state.intent.target.revision + 1,
        };
      }
      if (state.confirmation !== null && random() < 0.1) {
        return { type: 'wake_run', wakeId: state.confirmation.wakeId };
      }
      return confirmCommand(random, state);
    }
    case 'committing':
      return random() < 0.5
        ? {
            type: 'record_effect_submitted',
            effectId: state.effectId,
            submittedJobRef: random() < 0.5 ? `job-${prngHex(random, 6)}` : null,
          }
        : receiptCommand(random, state);
    case 'awaiting_receipt':
    case 'cancelling':
      return receiptCommand(random, state);
    case 'completed':
    case 'cancelled':
    case 'failed':
      return anyCommand();
  }
}

// ---------------------------------------------------------------------------
// Property : le contrat U1B §3 tient sur toute séquence arbitraire de commandes
// ---------------------------------------------------------------------------

describe('customer_contact@1 — property : contrat §3 sous séquences arbitraires', () => {
  // 4 800 réductions + round-trip de parse : sous les 5 s en local, pas sur le runner CI.
  it(
    '120 séquences × 40 commandes : ≤ 1 intent cumulé, union §5.1, round-trip du state',
    { timeout: 60_000 },
    () => {
      for (let seed = 1; seed <= 120; seed++) {
        const random = mulberry32(seed);
        const allocatedEffectId = prngUuid(random);
        let run: CustomerContactRunEnvelope = {
          kind: 'customer_contact',
          runId: prngUuid(random),
          companyId: 'company-1',
          createdBy: 'user-1',
          definitionVersion: 1,
          status: 'active',
          revision: 0,
          stateVersion: 1,
          state: null,
          nextWakeAt: null,
          terminalAt: null,
        };
        let clockMs = Date.parse(T0);
        let transitionsWithIntents = 0;
        const emittedEffectIds = new Set<string>();

        for (let index = 0; index < 40; index++) {
          clockMs += 1_000 + Math.floor(random() * 30_000);
          if (random() < 0.05) clockMs += 6 * 60 * 60 * 1_000; // saut → expirations TTL
          let command: CustomerContactCommand;
          let current: CustomerContactStateV1 | null = null;
          if (run.state === null) {
            command = startCommand(random);
          } else {
            // Round-trip d'entrée : le state courant DOIT re-parser via le parse public.
            current = parseCustomerContactState(run.state);
            if (current === null) {
              throw new Error(
                `state courant invalide (seed ${seed}, pas ${index}) — invariant rompu`,
              );
            }
            command = generateCommand(random, current);
          }
          const context: JarvisReduceContext = {
            // commandId canonique : il devient proposalCommandId/consumedByCommandId re-parsés.
            commandId: prngUuid(random),
            expectedRevision: run.revision,
            occurredAt: new Date(clockMs).toISOString(),
            actingPrincipalId: 'principal-1',
            allocatedEffectIds: [allocatedEffectId],
            targetRevalidation: targetRevalidationFor(random, current),
          };
          const result = CUSTOMER_CONTACT_V1.reduce(run, command, context);
          if (result.ok) {
            const { postimage, workItemIntents, wakes } = result.value;
            // Union §5.1 fermée — le run ne devient JAMAIS `expired`.
            expect(JARVIS_RUN_STATUSES).toContain(postimage.status);
            expect(postimage.status).not.toBe('expired');
            if (postimage.kind !== 'customer_contact') {
              throw new Error('postimage inattendue : kind hors customer_contact');
            }
            // terminalAt non-null ⇔ statut terminal.
            expect(postimage.terminalAt !== null).toBe(
              JARVIS_RUN_TERMINAL_STATUSES.has(postimage.status),
            );
            // Round-trip de sortie : le state produit RE-PARSE via le parse public du module.
            const reparsed = parseCustomerContactState(postimage.state);
            if (reparsed === null) {
              throw new Error(`round-trip rompu (seed ${seed}, pas ${index})`);
            }
            // nextWakeAt = index DÉRIVÉ des réveils du state — jamais une valeur propre.
            expect(postimage.nextWakeAt).toBe(deriveNextWakeAt(reparsed.wakes));
            expect(postimage.nextWakeAt).toBe(deriveNextWakeAt(wakes));
            expect(jsonUtf8Fits(postimage.state, CUSTOMER_CONTACT_LIMITS.maxStateBytes)).toBe(true);
            // Révision : +1 sur commit, inchangée sur no-op idempotent — jamais autre chose.
            expect([run.revision, run.revision + 1]).toContain(postimage.revision);
            expect(workItemIntents.length).toBeLessThanOrEqual(
              CUSTOMER_CONTACT_LIMITS.maxOpenWorkItems,
            );
            if (workItemIntents.length > 0) {
              transitionsWithIntents += 1;
              for (const intent of workItemIntents) {
                emittedEffectIds.add(intent.effectId);
                expect(intent.effectId).toBe(allocatedEffectId);
                expect(intent.authorizationSource).toEqual({
                  source: 'confirmation',
                  receiptId: context.commandId,
                });
              }
            }
            run = postimage;
          } else if ('error' in result) {
            // Erreurs racine fermées — jamais autre chose pour une définition enregistrée.
            expect(['invalid_command', 'revision_conflict', 'run_terminal']).toContain(
              result.error.code,
            );
          } else {
            throw new Error('quarantaine inattendue pour une définition enregistrée');
          }
        }

        // ≤ 1 effet mutant par run, quel que soit l'ordre des commandes (§4.3, §5.4).
        expect(transitionsWithIntents).toBeLessThanOrEqual(1);
        expect(emittedEffectIds.size).toBeLessThanOrEqual(1);
      }
    },
  );
});
