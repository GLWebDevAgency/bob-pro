import { describe, expect, it } from 'vitest';

import {
  CLOSED_JARVIS_ACTION_RELEASE_POLICY,
  evaluateJarvisActionPublication,
  isCanonicalJarvisActionReference,
  type JarvisActionReleasePolicy,
} from './jarvis-admission';

const REF = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
  actionId: 'client-modifier',
  actionVersion: 1,
});

describe('isCanonicalJarvisActionReference', () => {
  it('valide seulement la forme wire, sans décider la publication', () => {
    expect(isCanonicalJarvisActionReference('client-supprimer', 1)).toBe(true);
    expect(isCanonicalJarvisActionReference('client-modifier', 2_147_483_647)).toBe(true);
    expect(isCanonicalJarvisActionReference('Client/modifier', 1)).toBe(false);
    expect(isCanonicalJarvisActionReference('client-modifier', 0)).toBe(false);
    expect(isCanonicalJarvisActionReference('client-modifier', 1.5)).toBe(false);
    expect(isCanonicalJarvisActionReference('x'.repeat(101), 1)).toBe(false);
  });
});

describe('evaluateJarvisActionPublication', () => {
  it('le manifest vide refuse toujours', () => {
    expect(evaluateJarvisActionPublication(CLOSED_JARVIS_ACTION_RELEASE_POLICY, REF)).toEqual({
      published: false,
      reason: 'action_not_released',
    });
  });

  it('transmet le contexte serveur et l’entrée catalogue exacte à l’unique policy', () => {
    let seenStatus: string | null = null;
    const policy: JarvisActionReleasePolicy = {
      isPublished: (ref, entry) => {
        expect(ref).toEqual(REF);
        seenStatus = entry.status;
        return true;
      },
    };

    expect(evaluateJarvisActionPublication(policy, REF).published).toBe(true);
    expect(seenStatus).toBe('specified');
  });

  it('une décision négative de la policy reste fermée', () => {
    const refused: JarvisActionReleasePolicy = {
      isPublished: () => false,
    };

    expect(evaluateJarvisActionPublication(refused, REF).published).toBe(false);
  });

  it('retourne une raison unique pour les trois frontières de publication', () => {
    const testPolicy: JarvisActionReleasePolicy = {
      isPublished: () => true,
    };

    expect(
      evaluateJarvisActionPublication(testPolicy, { ...REF, actionId: 'action-inconnue' }),
    ).toEqual({ published: false, reason: 'unknown_action' });
    expect(
      evaluateJarvisActionPublication(testPolicy, {
        ...REF,
        actionId: 'devis-envoyer',
        actionVersion: 1,
      }),
    ).toEqual({ published: false, reason: 'action_closed' });
    expect(evaluateJarvisActionPublication(CLOSED_JARVIS_ACTION_RELEASE_POLICY, REF)).toEqual({
      published: false,
      reason: 'action_not_released',
    });
  });
});
