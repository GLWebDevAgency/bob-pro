import { describe, expect, it } from 'vitest';
import {
  FIXED_SAFE_SPEECH,
  createCanonicalSpeechEnvelope,
  extractCanonicalSpeechFacts,
  isFixedSafeSpeech,
} from './canonical-speech';

function normalizedFacts(text: string, kind: ReturnType<typeof extractCanonicalSpeechFacts>[number]['kind']): string[] {
  return extractCanonicalSpeechFacts(text)
    .filter((fact) => fact.kind === kind)
    .map((fact) => fact.normalized);
}

describe('CanonicalSpeechEnvelope — classification fail-closed', () => {
  it('n’autorise que les phrases statiques exactes de la petite allowlist', () => {
    expect(createCanonicalSpeechEnvelope(FIXED_SAFE_SPEECH.listening)).toMatchObject({
      version: 1,
      classification: 'fixed_safe',
      fixedPhraseId: 'listening',
      facts: [],
    });
    expect(createCanonicalSpeechEnvelope(FIXED_SAFE_SPEECH.checking)).toMatchObject({
      classification: 'fixed_safe',
      fixedPhraseId: 'checking',
    });
    expect(isFixedSafeSpeech(FIXED_SAFE_SPEECH.listening)).toBe(true);
  });

  it.each([
    ' Je t’écoute.',
    'Je t’écoute. ',
    'Je t\'écoute.',
    'Je t’écoute.\u0000',
    'Je\u200bt’écoute.',
    'Je vérifie.\n',
  ])('ferme le chemin sûr pour une variante whitespace/control : %j', (text) => {
    expect(createCanonicalSpeechEnvelope(text).classification).toBe('dynamic_sensitive');
    expect(isFixedSafeSpeech(text)).toBe(false);
  });

  it.each([
    'Bonjour, comment puis-je vous aider ?',
    'Je peux vous aider.',
    'La facture de Durand est disponible.',
    'La facture de Dupont est disponible.',
    '',
  ])('classe tout texte arbitraire ou dynamique comme sensible : %j', (text) => {
    const envelope = createCanonicalSpeechEnvelope(text);
    expect(envelope.classification).toBe('dynamic_sensitive');
    expect(envelope).not.toHaveProperty('fixedPhraseId');
    expect(envelope).not.toHaveProperty('digest');
  });
});

describe('CanonicalSpeechEnvelope — faits typés et normalisés', () => {
  it('extrait montants, pourcentages, dates, références et statuts métier', () => {
    const text =
      'La facture F2026-014 de Durand, de 1\u202f320,50 € TTC à 20 %, est partiellement payée et en retard au 20/07/2026. ' +
      'Le devis n° D2026/031 expire le 3 février 2027.';

    expect(normalizedFacts(text, 'amount')).toContain('EUR:1320.5');
    expect(normalizedFacts(text, 'percentage')).toContain('20%');
    expect(normalizedFacts(text, 'date')).toEqual(expect.arrayContaining(['2026-07-20', '2027-02-03']));
    expect(normalizedFacts(text, 'document_reference')).toEqual(expect.arrayContaining(['F2026-014', 'D2026-031']));
    expect(normalizedFacts(text, 'business_status')).toEqual(
      expect.arrayContaining(['partially_paid', 'late', 'expired']),
    );
    expect(normalizedFacts(text, 'business_status')).not.toContain('paid');
    expect(normalizedFacts(text, 'number').length).toBeGreaterThan(0);
  });

  it('normalise SIREN, SIRET, TVA, IBAN, email et téléphone sans dépendance Node', () => {
    const text =
      'SIREN : 732 829 320 ; SIRET : 732 829 320 00074 ; TVA FR 44 732 829 320 ; ' +
      'IBAN FR76 3000 6000 0112 3456 7890 189 ; contact Factures@Durand-Pro.fr ; tél. +33 (0)6 12 34 56 78.';
    const facts = extractCanonicalSpeechFacts(text);

    expect(facts).toContainEqual({ kind: 'siren', normalized: '732829320' });
    expect(facts).toContainEqual({ kind: 'siret', normalized: '73282932000074' });
    expect(facts).toContainEqual({ kind: 'vat_number', normalized: 'FR44732829320' });
    expect(facts).toContainEqual({ kind: 'iban', normalized: 'FR7630006000011234567890189' });
    expect(facts).toContainEqual({ kind: 'email', normalized: 'factures@durand-pro.fr' });
    expect(facts).toContainEqual({ kind: 'phone', normalized: '+33612345678' });
  });

  it('assainit les contrôles sans rendre la phrase sûre et conserve les faits séparés par whitespace', () => {
    const envelope = createCanonicalSpeechEnvelope('Durand\u0000\u0007 : 1\u00a0320 € — payée.');
    expect(envelope.classification).toBe('dynamic_sensitive');
    expect(envelope.canonicalText).toBe('Durand : 1 320 € — payée.');
    expect(envelope.facts).toContainEqual({ kind: 'amount', normalized: 'EUR:1320' });
    expect(envelope.facts).toContainEqual({ kind: 'business_status', normalized: 'paid' });
  });

  it('rejette les dates calendaires impossibles comme dates, tout en restant sensible', () => {
    const envelope = createCanonicalSpeechEnvelope('Échéance le 31/02/2027.');
    expect(envelope.classification).toBe('dynamic_sensitive');
    expect(envelope.facts.some((fact) => fact.kind === 'date')).toBe(false);
    expect(envelope.facts.some((fact) => fact.kind === 'number')).toBe(true);
  });
});
