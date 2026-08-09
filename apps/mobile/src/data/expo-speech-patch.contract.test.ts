import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootPackage = readFileSync(
  new URL('../../../../package.json', import.meta.url),
  'utf8',
);
const lockfile = readFileSync(
  new URL('../../../../pnpm-lock.yaml', import.meta.url),
  'utf8',
);
const patch = readFileSync(
  new URL('../../../../patches/expo-speech@57.0.1.patch', import.meta.url),
  'utf8',
);
const additions = patch
  .split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .map((line) => line.slice(1))
  .join('\n');

describe('expo-speech — preuve voix Android hors réseau', () => {
  it('versionne et verrouille le patch pnpm', () => {
    expect(rootPackage).toContain('"expo-speech@57.0.1"');
    expect(rootPackage).toContain('patches/expo-speech@57.0.1.patch');
    expect(lockfile).toContain('expo-speech@57.0.1:');
    expect(lockfile).toContain('path: patches/expo-speech@57.0.1.patch');
    expect(lockfile).toMatch(/expo-speech@57\.0\.1\(patch_hash=[^)]+\)/);
  });

  it('expose les preuves réseau/installée et revalide la voix au moment de parler', () => {
    expect(patch).toContain('networkConnectionRequired = it.isNetworkConnectionRequired');
    expect(patch).toContain('installed = !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)');
    expect(patch).toContain('@Field val networkConnectionRequired: Boolean');
    expect(patch).toContain('@Field val installed: Boolean');
    expect(patch).toContain('@Field val requiresOfflineVoice: Boolean?');
    expect(patch).toContain('selectedVoice.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)');
    expect(patch).toContain('textToSpeech.setVoice(selectedVoice)');
    expect(patch).toContain('sendEvent(speakingErrorEvent, idToMap(id))');
    const strictGuardAt = additions.indexOf('if (options.requiresOfflineVoice == true)');
    const legacySetLanguageAt = additions.indexOf('textToSpeech.language = options.language?.let');
    expect(strictGuardAt).toBeGreaterThan(-1);
    expect(legacySetLanguageAt).toBeGreaterThan(-1);
    expect(strictGuardAt).toBeLessThan(legacySetLanguageAt);
    expect(patch).toContain('networkConnectionRequired?: boolean;');
    expect(patch).toContain('installed?: boolean;');
    expect(patch).toContain('requiresOfflineVoice?: boolean;');
    expect(patch).toContain('a/build/Speech.types.d.ts');
    expect(patch).toContain('b/build/Speech.types.d.ts');
  });
});
