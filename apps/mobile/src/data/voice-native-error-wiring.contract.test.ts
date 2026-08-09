import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./voice.ts', import.meta.url), 'utf8');

function section(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`section voice.ts absente: ${startMarker}`);
  return source.slice(start, end);
}

describe('useVoiceInput — branchement terminal ASR natif', () => {
  it('classe puis fence une erreur avant de notifier réellement onIssue', () => {
    const handler = section("useSpeechRecognitionEvent('error'", '\n\n  const start =');
    const classifyAt = handler.indexOf('classifyNativeSpeechError(e)');
    const terminalAt = handler.indexOf('advanceNativeTerminal(');
    const reportAt = handler.indexOf("report('denied'");
    expect(classifyAt).toBeGreaterThan(0);
    expect(terminalAt).toBeGreaterThan(classifyAt);
    expect(reportAt).toBeGreaterThan(terminalAt);
    expect(handler).toContain("transition.effect !== 'issue'");
    expect(handler).not.toContain('JSON.stringify(e)');
    expect(handler).not.toContain('decision.message');
  });

  it('fence cancel avant abort et final avant livraison du transcript', () => {
    const cancel = section('const cancel = useCallback(', '\n  preemptRef.current =');
    const cancelFenceAt = cancel.indexOf("advanceNativeTerminal(generation, 'cancel_requested')");
    const cancelDispatchAt = cancel.indexOf("dispatchNativeCommand(generation, nativeTransition?.command");
    expect(cancelFenceAt).toBeGreaterThan(-1);
    expect(cancelDispatchAt).toBeGreaterThan(-1);
    expect(cancelFenceAt).toBeLessThan(cancelDispatchAt);

    const result = section("useSpeechRecognitionEvent('result'", "useSpeechRecognitionEvent('end'");
    const finalFenceAt = result.indexOf("advanceNativeTerminal(generation, 'final')");
    const transcriptAt = result.indexOf('onTranscriptRef.current(text)');
    expect(finalFenceAt).toBeGreaterThan(-1);
    expect(transcriptAt).toBeGreaterThan(-1);
    expect(finalFenceAt).toBeLessThan(transcriptAt);
  });

  it('ne rend le lease qu’après end et fence les commandes stop/cancel', () => {
    const stop = section('const stop = useCallback', '\n\n  /** Abandon sans transcription');
    expect(stop).toContain("advanceNativeTerminal(generation, 'stop_requested')");
    expect(stop).toContain('dispatchNativeCommand');
    expect(stop).not.toContain('releaseNativeGenerationAfterEndGrace');

    const result = section("useSpeechRecognitionEvent('result'", "useSpeechRecognitionEvent('end'");
    const end = section("useSpeechRecognitionEvent('end'", "useSpeechRecognitionEvent('nomatch'");
    const error = section("useSpeechRecognitionEvent('error'", '\n\n  const start =');
    expect(result).not.toContain('releaseNativeGenerationAfterEndGrace');
    expect(error).not.toContain('releaseNativeGenerationAfterEndGrace');
    expect(end).toContain("advanceNativeTerminal(session.generation, 'end')");
    expect(end).toContain('releaseNativeGenerationAfterEndGrace(session.generation)');
  });

  it('écoute start/nomatch et impose la reconnaissance locale sans repli réseau', () => {
    expect(source).toContain("useSpeechRecognitionEvent('start'");
    expect(source).toContain("useSpeechRecognitionEvent('nomatch'");
    expect(source).toContain('requiresOnDeviceRecognition: true');
    expect(source).toContain('supportsPrivateNativeSpeech({');
    expect(source).toContain('requestMicrophonePermissionsAsync()');
    expect(source).toContain("advanceNativeTerminal(generation, 'start_requested')");
    expect(source).toContain("nativeState !== 'inactive'");
    expect(source).not.toContain('client.transcribe');
    expect(source).not.toContain('client.synthesizeSpeech');
    expect(source).not.toContain('useBobClient');
    expect(source).not.toContain('getVoiceMode');
  });
});
