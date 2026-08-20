/**
 * Ce que ces preuves défendent : une donnée relue en base ne doit JAMAIS pouvoir rendre l'assistant
 * vocal muet. Le planner rejette tout l'historique — devis compris — dès qu'un tour porte un
 * caractère invisible ou dépasse sa borne ; l'assainisseur est le seul endroit où cela s'arrête.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeSpokenLabel } from './spoken-label';

const ZWSP = '\u200b';
const RLM = '\u200f';
const BOM = '\ufeff';
const NBSP = '\u00a0';

describe('sanitizeSpokenLabel — la frontière entre la base et la parole', () => {
  it('laisse intact un nom déjà propre — l’assainissement ne doit rien coûter au cas normal', () => {
    expect(sanitizeSpokenLabel('Dupont Plomberie SARL', 80)).toBe('Dupont Plomberie SARL');
    expect(sanitizeSpokenLabel('Éléonore Bâtiment & Fils', 80)).toBe('Éléonore Bâtiment & Fils');
  });

  it('RETIRE les invisibles que le validateur de création laisse passer', () => {
    // U+200B franchit `hasAsciiControlCharacter` : il est stocké, relu, et empoisonnerait la parole.
    expect(sanitizeSpokenLabel(`Dupont${ZWSP}Plomberie`, 80)).toBe('DupontPlomberie');
    expect(sanitizeSpokenLabel(`${RLM}Dupont${BOM}`, 80)).toBe('Dupont');
  });

  it('retire aussi les contrôles ASCII, sans jamais les remplacer par une espace muette', () => {
    expect(sanitizeSpokenLabel('Du\u0000pont', 80)).toBe('Dupont');
    expect(sanitizeSpokenLabel('Dupont\u007f', 80)).toBe('Dupont');
  });

  it('ÉCRASE toutes les espaces Unicode en une seule — sinon la parole n’est pas un point fixe', () => {
    expect(sanitizeSpokenLabel(`Dupont${NBSP}Plomberie`, 80)).toBe('Dupont Plomberie');
    expect(sanitizeSpokenLabel('  Dupont   Plomberie \n SARL  ', 80)).toBe('Dupont Plomberie SARL');
  });

  it('BORNE en points de code et S’ENTEND élidé — jamais un nom coupé qui se fait passer pour entier', () => {
    const sortie = sanitizeSpokenLabel('A'.repeat(200), 10);
    expect(Array.from(sortie ?? '')).toHaveLength(10);
    expect(sortie).toContain('…');
  });

  it('ÉLIDE AU MILIEU : le discriminant FINAL survit — sinon deux fiches deviennent une seule', () => {
    // LE DEFAUT QUE CETTE PREUVE FERME. Couper la fin rendait indiscernables deux fiches dont
    // seule la fin diffère — et l'artisan scellait alors un rattachement durable à l'aveugle.
    const prefixe = 'SYNDIC RESIDENCE LES JARDINS DE BELLEVUE - BATIMENT A - ESCALIER 2 - PORTE 12';
    const onze = sanitizeSpokenLabel(`${prefixe} - PARIS 11E`, 40);
    const douze = sanitizeSpokenLabel(`${prefixe} - PARIS 12E`, 40);
    expect(onze).not.toBe(douze);
    expect(onze).toContain('11E');
    expect(douze).toContain('12E');
    // La tête reste reconnaissable : l'artisan sait de quelle famille de fiches on parle.
    expect(onze?.startsWith('SYNDIC')).toBe(true);
  });

  it('ne COUPE JAMAIS une paire de substitution — un emoji dans un nom propre reste entier', () => {
    // 5 points de code, 10 unités UTF-16 : une troncature naïve couperait au milieu de la paire
    // et fabriquerait un caractère de remplacement au beau milieu d'un nom propre.
    const sortie = sanitizeSpokenLabel('\u{1f527}\u{1f528}\u{1f529}\u{1f52a}\u{1f52b}', 4);
    expect(sortie).toBe('\u{1f527}\u{1f528}\u2026\u{1f52b}');
    expect(sortie).not.toContain('\ufffd');
    expect(Array.from(sortie ?? '')).toHaveLength(4);
  });

  it('rend `null` quand il ne reste RIEN : c’est un signal de dérive, pas un libellé de secours', () => {
    expect(sanitizeSpokenLabel(`${ZWSP}${BOM}`, 80)).toBeNull();
    expect(sanitizeSpokenLabel('   ', 80)).toBeNull();
    expect(sanitizeSpokenLabel('\u0000\u0001', 80)).toBeNull();
    expect(sanitizeSpokenLabel('Dupont', 0)).toBeNull();
  });

  it('est IDEMPOTENT : réassainir une sortie ne la change plus', () => {
    for (const brut of [`Dupont${ZWSP} Plomberie`, `${NBSP}Éléonore  Bâtiment${BOM}`, 'X'.repeat(300)]) {
      const une = sanitizeSpokenLabel(brut, 40);
      expect(une).not.toBeNull();
      expect(sanitizeSpokenLabel(une ?? '', 40)).toBe(une);
    }
  });
});
