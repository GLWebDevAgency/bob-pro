import { describe, it, expect } from 'vitest';
import { DemoTtsAdapter } from './demo-tts';

describe('DemoTtsAdapter', () => {
  it('synthèse démo = natif (aucun audio renvoyé), déterministe, healthy', async () => {
    const tts = new DemoTtsAdapter();
    const r = await tts.synthesize('Bonjour, facture encaissée.');
    expect(r.audioBase64).toBeNull();
    expect(r.mimeType).toBeNull();
    expect(r.model).toBe('demo');
    expect((await tts.health()).healthy).toBe(true);
  });
});
