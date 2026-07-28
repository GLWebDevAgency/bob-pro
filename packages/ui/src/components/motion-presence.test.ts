import { describe, expect, it } from 'vitest';
import { motionSemantic } from '@bob/tokens';
import {
  diffRowPresence,
  mergeExitingKeys,
  resolvePresenceMotion,
} from './motion-presence.logic';

/**
 * [Revue train n°2] — les micro-interactions §2.1 consomment les tokens motionSemantic :
 * enter 240 (insertion après ACK), exitFast 140 (sortie vers Retirés), replace 280 (morph).
 * Reduce-motion = ÉQUIVALENCE D'INFORMATION : immédiat (durées 0) + annonce côté écran.
 */
describe('resolvePresenceMotion — table motion/reduce-motion', () => {
  it('consomme les tokens motionSemantic nommés par intention', () => {
    expect(resolvePresenceMotion(false)).toEqual({
      enter: motionSemantic.enter,
      exitFast: motionSemantic.exitFast,
      replace: motionSemantic.replace,
      animated: true,
    });
    expect(motionSemantic.enter).toBe(240);
    expect(motionSemantic.exitFast).toBe(140);
    expect(motionSemantic.replace).toBe(280);
  });

  it('reduce-motion : IMMÉDIAT (toutes durées 0) — jamais une animation résiduelle', () => {
    expect(resolvePresenceMotion(true)).toEqual({
      enter: 0,
      exitFast: 0,
      replace: 0,
      animated: false,
    });
  });
});

describe('diffRowPresence — insertion/retrait dans la MÊME vue uniquement', () => {
  it('amorçage et bascule de vue (segment/filtre) : reset SANS animation', () => {
    expect(diffRowPresence(null, { viewKey: 'active|', keys: ['a', 'b'] }).reset).toBe(true);
    expect(
      diffRowPresence(
        { viewKey: 'active|', keys: ['a', 'b'] },
        { viewKey: 'retired|', keys: ['c'] },
      ).reset,
    ).toBe(true);
  });

  it('insertion réelle → entered ; retrait réel → exited avec index d’origine', () => {
    const diff = diffRowPresence(
      { viewKey: 'active|', keys: ['a', 'b', 'c'] },
      { viewKey: 'active|', keys: ['a', 'nouveau', 'c'] },
    );
    expect(diff.reset).toBe(false);
    expect(diff.entered).toEqual(['nouveau']);
    expect(diff.exited).toEqual([{ key: 'b', index: 1 }]);
  });

  it('liste inchangée : aucun mouvement', () => {
    const diff = diffRowPresence(
      { viewKey: 'active|', keys: ['a', 'b'] },
      { viewKey: 'active|', keys: ['a', 'b'] },
    );
    expect(diff.entered).toEqual([]);
    expect(diff.exited).toEqual([]);
  });
});

describe('mergeExitingKeys — la rangée sortante reste affichée le temps de l’exit', () => {
  it('réinsère la sortante à son index d’origine (borné à la longueur courante)', () => {
    expect(mergeExitingKeys(['a', 'c'], [{ key: 'b', index: 1 }])).toEqual(['a', 'b', 'c']);
    expect(mergeExitingKeys([], [{ key: 'b', index: 4 }])).toEqual(['b']);
  });

  it('retrait ANNULÉ (clé revenue dans les données) : jamais de doublon, la vivante prime', () => {
    expect(mergeExitingKeys(['a', 'b'], [{ key: 'b', index: 1 }])).toEqual(['a', 'b']);
  });

  it('plusieurs sortantes gardent leur ordre relatif', () => {
    expect(
      mergeExitingKeys(['a'], [
        { key: 'c', index: 2 },
        { key: 'b', index: 1 },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });
});
