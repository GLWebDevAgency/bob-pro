import { describe, expect, it } from 'vitest';
import {
  LEGAL_HINT_HIT_TARGET,
  LEGAL_HINT_ICON_DIAMETER,
  LEGAL_HINT_ICON_HIT_SLOP,
  resolveLegalHintCopy,
} from './legal-hint.logic';

const input = {
  lawKey: 'legal.embargo.law',
  whyKey: 'legal.embargo.why',
  source: 'art. L221-10 du code de la consommation',
} as const;

describe('LegalHint — logique pure', () => {
  it('la cible tactile respecte le minimum de 44 pt, la pastille reste discrète', () => {
    expect(LEGAL_HINT_HIT_TARGET).toBeGreaterThanOrEqual(44);
    expect(LEGAL_HINT_ICON_DIAMETER).toBeLessThan(LEGAL_HINT_HIT_TARGET);
  });

  it('la hitbox RÉELLE (pastille + hitSlop) atteint la cible — jamais une constante fictive', () => {
    // Invariant de comportement : le Pressable fait ICON_DIAMETER et hitSlop étend chaque côté.
    // diamètre + 2 × slop DOIT couvrir la cible de 44 pt (le composant garantit par ailleurs
    // minHeight = cible sur la rangée, condition RN pour que la zone étendue soit touchable).
    expect(LEGAL_HINT_ICON_HIT_SLOP).toBeGreaterThanOrEqual(0);
    expect(LEGAL_HINT_ICON_DIAMETER + 2 * LEGAL_HINT_ICON_HIT_SLOP).toBeGreaterThanOrEqual(
      LEGAL_HINT_HIT_TARGET,
    );
  });

  it('résout les 2 blocs + source + a11y pour la personnalité active (défaut pote)', () => {
    const copy = resolveLegalHintCopy(input, 'pote');
    expect(copy.lawTitle).toBe('Ce que dit la loi');
    expect(copy.whyTitle).toBe('Pourquoi Bob fait ça');
    expect(copy.lawBody).toContain('7 jours');
    expect(copy.whyBody.length).toBeGreaterThan(0);
    expect(copy.sourceLine).toBe('Source : art. L221-10 du code de la consommation');
    expect(copy.iconLabel.length).toBeGreaterThan(0);
    expect(copy.iconHint.length).toBeGreaterThan(0);
    expect(copy.sheetLabel.length).toBeGreaterThan(0);
  });

  it('suit la personnalité : pro vouvoie, direct condense — jamais la même copy', () => {
    const pote = resolveLegalHintCopy(input, 'pote');
    const pro = resolveLegalHintCopy(input, 'pro');
    const direct = resolveLegalHintCopy(input, 'direct');
    expect(pro.lawBody).not.toBe(pote.lawBody);
    expect(direct.lawBody).not.toBe(pote.lawBody);
    // Le ton pote tutoie, le ton pro reste impersonnel/vouvoyé : jamais de « tu » côté pro.
    expect(pote.lawBody).toContain('tu ');
    expect(pro.lawBody).not.toContain('tu ');
  });

  it('interpole les paramètres partagés ({date}) dans les blocs qui les portent', () => {
    const copy = resolveLegalHintCopy(
      {
        lawKey: 'legal.embargo.inline',
        whyKey: 'legal.embargo.why',
        source: 'art. L221-10 du code de la consommation',
        params: { date: '09/06/2026' },
      },
      'pote',
    );
    expect(copy.lawBody).toContain('09/06/2026');
  });

  it('couvre les trois hints livrés (embargo, dépannage urgent, canal de signature)', () => {
    for (const keys of [
      { lawKey: 'legal.embargo.law', whyKey: 'legal.embargo.why' },
      { lawKey: 'legal.urgentRepair.law', whyKey: 'legal.urgentRepair.why' },
      { lawKey: 'legal.signatureChannel.law', whyKey: 'legal.signatureChannel.why' },
    ] as const) {
      for (const personality of ['pote', 'pro', 'direct'] as const) {
        const copy = resolveLegalHintCopy({ ...keys, source: 'art. test' }, personality);
        expect(copy.lawBody.length).toBeGreaterThan(0);
        expect(copy.whyBody.length).toBeGreaterThan(0);
      }
    }
  });
});
