import { describe, expect, it } from 'vitest';
import { formatEUR } from '@bob/core';
import { planSpokenDelivery, sanitizeForSpeech } from './speech-sanitizer';

// Les gabarits testés sont CEUX de bob-agent.ts (impayés, compte de résultat, top clients) —
// pas des textes inventés : si un gabarit change de typographie, ce test doit le voir.

describe('sanitizeForSpeech — gabarits réels pour l’oreille, affichage intact', () => {
  it('impayés (bob-agent « À encaisser ») : puce muette, incise respirée, montant prononcé', () => {
    // bob-agent.ts (intent factures) : `• ${number} — ${customerName} : ${formatEUR(remainingCents)}`
    const body = [
      `• 2026-014 — Durand SARL : ${formatEUR(138650)}`,
      `• 2026-015 — Camping Les Pins : ${formatEUR(41580)}`,
    ].join('\n');
    expect(sanitizeForSpeech(body)).toBe(
      '2026-014, Durand SARL : 1386 euros 50\n2026-015, Camping Les Pins : 415 euros 80',
    );
  });

  it('compte de résultat (bob-agent « resultat ») : signes en toutes lettres, emoji muet', () => {
    // bob-agent.ts (intent resultat) : signed() = `+`/`−` + formatEUR, verdict 🎉.
    const signed = (c: number): string => `${c >= 0 ? '+' : '−'}${formatEUR(Math.abs(c))}`;
    const body = [
      `Résultat d'exploitation : ${signed(523400)}`,
      `Résultat financier : ${signed(-12050)}`,
      `Résultat net : +${formatEUR(511350)} 🎉`,
    ].join('\n');
    expect(sanitizeForSpeech(body)).toBe(
      [
        "Résultat d'exploitation : plus 5234 euros",
        'Résultat financier : moins 120 euros 50',
        'Résultat net : plus 5113 euros 50',
      ].join('\n'),
    );
  });

  it('top clients (bob-agent « top_clients ») : rang conservé, ⚠ muet, dépendance respirée', () => {
    // bob-agent.ts (intent top_clients) : `${i + 1}. ${name} — ${formatEUR(...)} (${share} %)` + alerte ⚠.
    const body = [
      `1. Durand SARL — ${formatEUR(1200000)} (34 %)`,
      `2. Camping Les Pins — ${formatEUR(640000)} (18 %)`,
      '⚠ Durand SARL pèse 34 % de ton activité — une dépendance à surveiller.',
    ].join('\n');
    expect(sanitizeForSpeech(body)).toBe(
      [
        '1. Durand SARL, 12000 euros (34 %)',
        '2. Camping Les Pins, 6400 euros (18 %)',
        'Durand SARL pèse 34 % de ton activité, une dépendance à surveiller.',
      ].join('\n'),
    );
  });

  it('centimes nuls tus, montants nus prononcés, flèche TVA muette', () => {
    expect(sanitizeForSpeech(`→ À provisionner : ${formatEUR(41500)} (déjà déduit).`)).toBe(
      'À provisionner : 415 euros (déjà déduit).',
    );
    expect(sanitizeForSpeech('ajoute 2 h de main-d’œuvre à 55 €')).toBe(
      'ajoute 2 h de main-d’œuvre à 55 euros',
    );
  });

  it('ne touche jamais les traits d’union porteurs de sens ni les dates', () => {
    expect(sanitizeForSpeech('La facture 2026-014 arrive à échéance le 20/07/2026.')).toBe(
      'La facture 2026-014 arrive à échéance le 20/07/2026.',
    );
  });

  it('est idempotent : un texte déjà prononçable ressort inchangé', () => {
    const once = sanitizeForSpeech(`• Reste dû : ${formatEUR(138650)} — en retard.`);
    expect(sanitizeForSpeech(once)).toBe(once);
  });
});

describe('planSpokenDelivery — say() découpe en phrases SAUF consentement', () => {
  it('découpe une réponse multi-phrases en file, texte sanitizé comme référence echo-guard', () => {
    const plan = planSpokenDelivery(
      `La facture 2026-014 de Durand SARL fait ${formatEUR(138650)}. Elle est en retard. Je peux préparer la relance.`,
    );
    expect(plan.sentences).not.toBeNull();
    expect(plan.sentences!.length).toBeGreaterThanOrEqual(2);
    expect(plan.text).toContain('1386 euros 50');
    // Chaque phrase prononcée appartient au texte de référence (echo-guard conservé par phrase).
    for (const sentence of plan.sentences!) expect(plan.text).toContain(sentence);
  });

  it('consentement (bargeIn:false) : monobloc — le prompt ne se coupe jamais en deux', () => {
    const plan = planSpokenDelivery(
      `J’envoie la relance de ${formatEUR(138650)} à Durand SARL. Je confirme ou j’annule ?`,
      { monolithic: true },
    );
    expect(plan.sentences).toBeNull();
    expect(plan.text).toBe(
      'J’envoie la relance de 1386 euros 50 à Durand SARL. Je confirme ou j’annule ?',
    );
  });
});
