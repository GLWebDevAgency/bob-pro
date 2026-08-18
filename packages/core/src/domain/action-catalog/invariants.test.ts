import { describe, expect, it } from 'vitest';

import { validateCatalog } from './invariants';
import type { ActionCatalogEntry } from './types';

const base: ActionCatalogEntry = {
  actionId: 'client-creer',
  version: 1,
  label: 'Créer un client',
  domain: 'client',
  status: 'specified',
  voiceMode: 'confirmable',
  riskClass: 'M2',
  flags: [],
  stepUp: 'none',
  commandAuthority: 'customer.create',
  surfaces: [{ platform: 'mobile', route: '/clients', source: 'apps/mobile/app/clients.tsx:1' }],
  founderDecisionIds: [],
};

const rules = (entries: readonly ActionCatalogEntry[]) =>
  validateCatalog(entries).map((violation) => violation.rule);

describe('validateCatalog', () => {
  it('accepte une entrée ouverte complète', () => {
    expect(validateCatalog([base])).toEqual([]);
  });

  it('rejette un actionId@version dupliqué', () => {
    expect(rules([base, { ...base }])).toContain('duplicate_action_id');
  });

  it('exige motif ET founderDecisionId sur une action fermée', () => {
    const closed = { ...base, voiceMode: 'closed' as const };
    expect(rules([closed])).toEqual(
      expect.arrayContaining(['closed_without_reason', 'closed_without_founder_decision']),
    );
  });

  it('accepte une action fermée correctement gouvernée', () => {
    const closed: ActionCatalogEntry = {
      ...base,
      voiceMode: 'closed',
      closedReason: 'fusion de doublons fermée en V1',
      founderDecisionIds: ['FD-2026-0817-06'],
      commandAuthority: null,
      surfaces: [],
    };
    expect(validateCatalog([closed])).toEqual([]);
  });

  it('rejette une action ouverte sans autorité ou sans surface manuelle', () => {
    expect(rules([{ ...base, commandAuthority: null }])).toContain('open_without_authority');
    expect(rules([{ ...base, surfaces: [] }])).toContain('open_without_manual_surface');
  });

  it('rejette un step-up déclaré sous le plancher des flags', () => {
    const massWithoutStepUp: ActionCatalogEntry = {
      ...base,
      riskClass: 'E3',
      flags: ['mass_action', 'external'],
      stepUp: 'none',
    };
    expect(rules([massWithoutStepUp])).toContain('step_up_below_floor');
  });

  it('verrouille la cohérence mode↔classe', () => {
    expect(rules([{ ...base, voiceMode: 'read', riskClass: 'M2' }])).toContain(
      'read_mode_requires_l0',
    );
    expect(rules([{ ...base, voiceMode: 'prepare', riskClass: 'E3' }])).toContain(
      'prepare_mode_requires_p1',
    );
  });

  it('exige un flag qualifiant sur toute E3 confirmable', () => {
    expect(rules([{ ...base, riskClass: 'E3', flags: [] }])).toContain('e3_voice_mode_forbidden');
  });

  it('force la classe E3 sur toute action de masse', () => {
    const mass: ActionCatalogEntry = {
      ...base,
      riskClass: 'M2',
      flags: ['mass_action'],
      stepUp: 'biometric_or_pin',
    };
    expect(rules([mass])).toContain('mass_action_requires_e3');
  });
});
