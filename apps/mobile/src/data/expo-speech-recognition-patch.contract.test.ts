import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const patch = readFileSync(
  new URL('patches/expo-speech-recognition@56.0.1.patch', root),
  'utf8',
);
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  readonly pnpm?: { readonly patchedDependencies?: Record<string, string> };
};
const lockfile = readFileSync(new URL('pnpm-lock.yaml', root), 'utf8');
const nativeWorkflow = readFileSync(
  new URL('.github/workflows/bob-live-native.yml', root),
  'utf8',
);

describe('expo-speech-recognition — patch iOS fail-closed', () => {
  it('est déclaré par le manifeste et verrouillé par un patch hash reproductible', () => {
    expect(packageJson.pnpm?.patchedDependencies?.['expo-speech-recognition@56.0.1'])
      .toBe('patches/expo-speech-recognition@56.0.1.patch');
    expect(lockfile).toContain('patchedDependencies:');
    expect(lockfile).toContain('path: patches/expo-speech-recognition@56.0.1.patch');
    expect(lockfile).toMatch(/expo-speech-recognition@56\.0\.1\(patch_hash=[a-z0-9]+\)/);
  });

  it('refuse la locale iOS non on-device avant de préparer le microphone', () => {
    expect(patch).toContain('let request = try Self.prepareRequest(');
    expect(patch).toContain(') throws -> SFSpeechRecognitionRequest {');
    expect(patch).toContain('guard recognizer.supportsOnDeviceRecognition else {');
    expect(patch).toContain('Function("supportsOnDeviceRecognitionForLocale")');
    expect(patch).toContain('SFSpeechRecognizer(locale: locale)');
    expect(patch).toContain('throw RecognizerError.onDeviceRecognitionUnavailable');
    expect(patch).toContain('request.requiresOnDeviceRecognition = true');
    expect(patch).toContain('"error": "language-not-supported"');
  });

  it('fence un start natif en attente et résout abort après teardown et end', () => {
    expect(patch).toContain('private var pendingStartTask: Task<Void, Never>?');
    expect(patch).toContain('private var pendingLifecycleTask: Task<Void, Never>?');
    expect(patch).toContain('private var recognitionGeneration: UInt64 = 0');
    expect(patch).toContain('let generation = nextRecognitionGeneration()');
    expect(patch).toContain('let previousLifecycleTask = pendingLifecycleTask');
    expect(patch).toContain('await previousLifecycleTask?.value');
    expect(patch).toContain('let replacement = try await ExpoSpeechRecognizer(locale: locale)');
    expect(patch).toContain('isCurrentRecognitionGeneration(generation)');
    expect(patch).toContain('let abortGeneration = nextRecognitionGeneration()');
    expect(patch).toContain('let recognizerToAbort = self.speechRecognizer');
    expect(patch).toContain('startTask?.cancel()');
    expect(patch).toContain('await previousLifecycleTask?.value');
    expect(patch).toContain(') async {');
    expect(patch).toContain('await startRecognizer(');
    expect(patch).toContain('@MainActor func abort() async');
    expect(patch).toContain('private func end() async');
    expect(patch).toContain('await MainActor.run {');
    expect(patch).toContain('self.errorHandler = nil');
    expect(patch).toContain('private func reset(andEmitEnd: Bool = false) async');
    expect(patch).toContain('await end()');
    expect(patch).toContain('pendingLifecycleTask = abortTask');
    expect(patch).toContain('let module = self');
    expect(patch).not.toContain('guard self.isCurrentRecognitionGeneration(abortGeneration) else');
    expect(patch).toContain('AsyncFunction("abortAndWaitAsync")');
    expect(patch).toContain('expoSpeechService.abort {');
    expect(patch).toContain('onComplete?.invoke()');
    expect(patch).toContain('abortAndWaitAsync(): Promise<void>;');
    expect(patch).toContain('val executor = Executors.newSingleThreadExecutor()');
    expect(patch).toContain('executor.shutdown()');
  });

  it('compile les modules patchés dans les applications natives exactes', () => {
    expect(nativeWorkflow).toContain('- patches/**');
    expect(nativeWorkflow).toContain('- apps/mobile/src/data/**');
    expect(nativeWorkflow).toContain(':app:compileDebugKotlin');
    expect(nativeWorkflow).toContain('xcodebuild');
    expect(nativeWorkflow).toContain('-workspace BobPro.xcworkspace');
  });
});
