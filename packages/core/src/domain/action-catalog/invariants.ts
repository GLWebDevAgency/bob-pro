/**
 * Invariants structurels du catalogue (spec §4.4, §6.2, gate §21.1).
 *
 * Purs et exhaustifs : la CI échoue sur toute violation — double actionId, action
 * fermée sans motif ni décision, action ouverte sans autorité ou sans surface
 * manuelle, valeur d'entrée sous le plancher de la table §7.0.
 */

import { requiredPresentation, stepUpFloor } from './policy';
import type { ActionCatalogEntry } from './types';

export interface CatalogViolation {
  readonly actionId: string;
  readonly rule:
    | 'duplicate_action_id'
    | 'closed_without_reason'
    | 'closed_without_founder_decision'
    | 'open_without_authority'
    | 'open_without_manual_surface'
    | 'step_up_below_floor'
    | 'read_mode_requires_l0'
    | 'prepare_mode_requires_p1'
    | 'e3_voice_mode_forbidden'
    | 'mass_action_requires_e3';
  readonly detail: string;
}

export function validateCatalog(
  entries: readonly ActionCatalogEntry[],
): readonly CatalogViolation[] {
  const violations: CatalogViolation[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const key = `${entry.actionId}@${entry.version}`;
    if (seen.has(key)) {
      violations.push({
        actionId: entry.actionId,
        rule: 'duplicate_action_id',
        detail: `${key} apparaît plus d'une fois`,
      });
    }
    seen.add(key);

    if (entry.voiceMode === 'closed') {
      if (!entry.closedReason?.trim()) {
        violations.push({
          actionId: entry.actionId,
          rule: 'closed_without_reason',
          detail: 'une action `closed` fixe son motif de refus (gate §21.1)',
        });
      }
      if (entry.founderDecisionIds.length === 0) {
        violations.push({
          actionId: entry.actionId,
          rule: 'closed_without_founder_decision',
          detail: 'une action `closed` référence le founderDecisionId qui la gouverne (spec §20)',
        });
      }
    } else {
      if (!entry.commandAuthority?.trim()) {
        violations.push({
          actionId: entry.actionId,
          rule: 'open_without_authority',
          detail: 'une action ouverte nomme son autorité de commande canonique (spec §6.3)',
        });
      }
      if (entry.surfaces.length === 0) {
        violations.push({
          actionId: entry.actionId,
          rule: 'open_without_manual_surface',
          detail: 'toute entrée ouverte possède une surface manuelle réelle (spec §6.2)',
        });
      }
    }

    if (entry.stepUp === 'none' && stepUpFloor(entry) === 'biometric_or_pin') {
      violations.push({
        actionId: entry.actionId,
        rule: 'step_up_below_floor',
        detail: 'les flags de cette action imposent biométrie/PIN (table §7.0, liste R3)',
      });
    }

    if (entry.voiceMode === 'read' && entry.riskClass !== 'L0') {
      violations.push({
        actionId: entry.actionId,
        rule: 'read_mode_requires_l0',
        detail: `mode \`read\` mais classe ${entry.riskClass}`,
      });
    }
    if (entry.voiceMode === 'prepare' && entry.riskClass !== 'P1' && entry.riskClass !== 'L0') {
      violations.push({
        actionId: entry.actionId,
        rule: 'prepare_mode_requires_p1',
        detail: `mode \`prepare\` mais classe ${entry.riskClass}`,
      });
    }
    if (
      entry.voiceMode === 'confirmable' &&
      requiredPresentation(entry) === 'screen_ack' &&
      entry.stepUp === 'none' &&
      entry.riskClass === 'E3' &&
      entry.flags.length === 0
    ) {
      // E3 sans aucun flag est suspect : un engagement sans qualification bloque
      // plutôt que de laisser passer une classification incomplète.
      violations.push({
        actionId: entry.actionId,
        rule: 'e3_voice_mode_forbidden',
        detail: 'E3 sans flag qualifiant : préciser financial/external/legal/… avant ouverture',
      });
    }
    if (entry.flags.includes('mass_action') && entry.riskClass !== 'E3') {
      violations.push({
        actionId: entry.actionId,
        rule: 'mass_action_requires_e3',
        detail: 'une action de masse est E3 (FD-2026-0817-02)',
      });
    }
  }

  return violations;
}
