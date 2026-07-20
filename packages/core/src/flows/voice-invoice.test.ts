import { describe, it, expect } from 'vitest';
import {
  startVoiceInvoice,
  voiceCaptured,
  voiceRetry,
  voiceConfirm,
} from './voice-invoice';

const DRAFT = {
  transcript: 'Facture de 300 euros pour le débouchage chez Mme Durand',
  customerId: 'durand',
  lines: [{ label: 'Débouchage canalisation', category: 'labor' as const, qty: 1, unitPriceHT: 25000, vatRate: 20 as const }],
};

describe('flows/voiceInvoice (C20 — écoute → revue → terminée)', () => {
  it('happy path : écoute → revue pré-remplie → encaissée (confirmation explicite)', () => {
    const s0 = startVoiceInvoice();
    expect(s0.step).toBe('ecoute');

    const s1 = voiceCaptured(s0, DRAFT);
    expect(s1.ok && s1.value.step).toBe('revue');
    if (!s1.ok) return;

    const s2 = voiceConfirm(s1.value, 'encaissee');
    expect(s2.ok && s2.value.step).toBe('terminee');
    expect(s2.ok && s2.value.outcome).toBe('encaissee');
  });

  it('préparer ≠ envoyer : impossible de terminer sans passer par la revue', () => {
    const s0 = startVoiceInvoice();
    const confirm = voiceConfirm(s0, 'envoyee');
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) expect(confirm.error.code).toBe('INVALID_TRANSITION');
  });

  it("annulation : retour à l'écoute depuis la revue, brouillon conservé", () => {
    const s1 = voiceCaptured(startVoiceInvoice(), DRAFT);
    if (!s1.ok) throw new Error('capture attendue');
    const retry = voiceRetry(s1.value);
    expect(retry.ok && retry.value.step).toBe('ecoute');
    expect(retry.ok && retry.value.draft.transcript).toBe(DRAFT.transcript);
  });

  it('gardes : pas de revue sans prestation, pas de facture sans client, terminal figé', () => {
    const vide = voiceCaptured(startVoiceInvoice(), { transcript: '…', customerId: null, lines: [] });
    expect(vide.ok).toBe(false);

    const sansClient = voiceCaptured(startVoiceInvoice(), { ...DRAFT, customerId: null });
    if (!sansClient.ok) throw new Error('revue attendue');
    expect(voiceConfirm(sansClient.value, 'envoyee').ok).toBe(false);

    const captured = voiceCaptured(startVoiceInvoice(), DRAFT);
    if (!captured.ok) throw new Error('revue attendue');
    const fini = voiceConfirm(captured.value, 'envoyee');
    if (!fini.ok) throw new Error('terminee attendue');
    expect(voiceRetry(fini.value).ok).toBe(false);
    expect(voiceConfirm(fini.value, 'encaissee').ok).toBe(false);
  });
});
