import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoOcrAdapter } from '@bob/core';
import { buildOcrAdapter, FallbackOcrChain, UnavailableOcrAdapter } from './ocr';

function clearProviderKeys(): void {
  vi.stubEnv('MISTRAL_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
}

describe('composition OCR — démo explicitement opt-in', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('retourne unavailable en live sans fournisseur, jamais DemoOcrAdapter', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    clearProviderKeys();

    const adapter = buildOcrAdapter();

    expect(adapter).toBeInstanceOf(UnavailableOcrAdapter);
    expect(adapter).not.toBeInstanceOf(DemoOcrAdapter);
    await expect(
      adapter.extractDocument({
        mimeType: 'application/pdf',
        contentBase64: '',
      }),
    ).resolves.toEqual({ ok: false, error: { kind: 'unavailable', service: 'ocr' } });
    await expect(adapter.health()).resolves.toEqual({ healthy: false });
  });

  it('compose un moteur réel en live lorsqu’une clé OCR existe', () => {
    vi.stubEnv('DEMO_MODE', 'false');
    vi.stubEnv('MISTRAL_API_KEY', 'mistral-test-key');
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    expect(buildOcrAdapter()).toBeInstanceOf(FallbackOcrChain);
  });

  it('autorise le moteur déterministe seulement avec DEMO_MODE=true', () => {
    vi.stubEnv('DEMO_MODE', 'true');
    clearProviderKeys();

    expect(buildOcrAdapter()).toBeInstanceOf(DemoOcrAdapter);
  });
});
