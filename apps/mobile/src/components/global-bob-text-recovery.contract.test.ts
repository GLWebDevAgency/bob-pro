import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./GlobalBobAccess.tsx', import.meta.url), 'utf8');
const actionSource = readFileSync(
  new URL('./GlobalBobTextRecoveryAction.tsx', import.meta.url),
  'utf8',
);
const assistantSource = readFileSync(
  new URL('../../app/(tabs)/assistant.tsx', import.meta.url),
  'utf8',
);
const focusSource = readFileSync(
  new URL('../assistant/text-recovery-focus.ts', import.meta.url),
  'utf8',
);

describe('GlobalBobAccess — sortie texte après issue', () => {
  it('rend le CTA accessible et lui donne uniquement la capacité de navigation texte', () => {
    expect(source).toContain('<GlobalBobTextRecoveryAction');
    expect(source).toContain("visible={recoveryAction === 'write_in_assistant'}");
    expect(actionSource).toContain("title={t('agent.global.writeInAssistant'");
    expect(actionSource).toContain("accessibilityHint={t('agent.global.writeInAssistantHint'");
    expect(actionSource).toContain('navigateGlobalBobTextRecovery');
    expect(actionSource).not.toContain('session.toggle');
    expect(actionSource).not.toContain('session.requestHandoff');
    expect(actionSource).not.toContain('params');
  });

  it('annonce la cause précise puis focalise réellement le champ texte à l’arrivée', () => {
    expect(source).toContain('composeGlobalBobSilentIssueAlert');
    expect(source).toContain('accessibilityLabel={accessibleLiveCardLabel}');
    expect(assistantSource).toContain(
      'accessibilityLabel={assistantVoiceErrorMessage ?? displayedLiveCopy}',
    );
    expect(assistantSource).toContain('useAssistantTextRecoveryFocus(');
    expect(focusSource).toContain('focusAssistantTextRecoveryIfRequested');
    expect(focusSource).toContain('input.focus()');
    expect(assistantSource).toContain('accessibilityRole="header"');
  });
});
