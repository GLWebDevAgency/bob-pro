import { describe, expect, it } from 'vitest';

import {
  AMOUNT_STEP_UP_THRESHOLD_CENTS,
  amountEscalatesToStepUp,
  isMassAction,
  requiredPresentation,
  stepUpFloor,
} from './policy';
import type { ActionFlag, RiskClass } from './types';

const entry = (riskClass: RiskClass, flags: readonly ActionFlag[] = []) => ({
  riskClass,
  flags,
});

describe('requiredPresentation — table normative §7.0 (FD-2026-0817-02)', () => {
  it('L0 et P1 purs ne demandent aucun reçu de présentation', () => {
    expect(requiredPresentation(entry('L0'))).toBe('none');
    expect(requiredPresentation(entry('P1'))).toBe('none');
  });

  it('M2 sans flag sensible admet la confirmation vocale one-shot', () => {
    expect(requiredPresentation(entry('M2'))).toBe('voice_presentation_ack');
    expect(requiredPresentation(entry('M2', ['privacy_sensitive']))).toBe(
      'voice_presentation_ack',
    );
  });

  it('E3 exige toujours screen_ack — jamais de confirmation à la seule voix', () => {
    expect(requiredPresentation(entry('E3'))).toBe('screen_ack');
    expect(requiredPresentation(entry('E3', ['financial']))).toBe('screen_ack');
  });

  it.each<ActionFlag>([
    'financial',
    'external',
    'mass_action',
    'destructive',
    'irreversible',
    'security_sensitive',
  ])('le flag %s impose screen_ack même sur une M2', (flag) => {
    expect(requiredPresentation(entry('M2', [flag]))).toBe('screen_ack');
  });

  it('recipient_authority seul ne suffit pas à imposer l’écran (M2 corrigeable)', () => {
    expect(requiredPresentation(entry('M2', ['recipient_authority']))).toBe(
      'voice_presentation_ack',
    );
  });
});

describe('stepUpFloor — plancher R3 dérivable des flags', () => {
  it.each<ActionFlag>(['destructive', 'irreversible', 'mass_action', 'security_sensitive'])(
    'le flag %s impose biométrie/PIN',
    (flag) => {
      expect(stepUpFloor(entry('E3', [flag]))).toBe('biometric_or_pin');
    },
  );

  it('un engagement financier simple reste au niveau écran (R2)', () => {
    expect(stepUpFloor(entry('E3', ['financial', 'external']))).toBe('none');
  });
});

describe('escalades runtime (FD-2026-0817-02)', () => {
  it('5 000 € TTC est le seuil exact d’escalade R2→R3', () => {
    expect(AMOUNT_STEP_UP_THRESHOLD_CENTS).toBe(500_000);
    expect(amountEscalatesToStepUp(499_999)).toBe(false);
    expect(amountEscalatesToStepUp(500_000)).toBe(true);
  });

  it('deux destinataires suffisent à qualifier une action de masse', () => {
    expect(isMassAction(1)).toBe(false);
    expect(isMassAction(2)).toBe(true);
  });
});
