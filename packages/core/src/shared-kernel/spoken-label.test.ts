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
    // 5 points de code, 10 unités UTF-16. Le DÉCOUPAGE se fait par points de code (sans quoi une
    // paire coupée fabriquerait un caractère de remplacement au milieu d'un nom propre), mais la
    // BORNE se compte en unités : c'est ce que mesure celui qui la fait respecter.
    const sortie = sanitizeSpokenLabel('\u{1f527}\u{1f528}\u{1f529}\u{1f52a}\u{1f52b}', 6);
    expect(sortie).toBe('\u{1f527}\u2026\u{1f52b}');
    expect(sortie).not.toContain('\ufffd');
    expect((sortie ?? '').length).toBeLessThanOrEqual(6);
  });

  it('BORNE EN UNITÉS UTF-16, jamais en points de code — un nom d’emoji pèse le double', () => {
    // LE DEFAUT QUE CETTE PREUVE FERME. Compter en points de code paraissait plus juste : un nom de
    // 160 emoji tenait la borne « 160 » tout en pesant 320 unités. Cinq de ces libellés faisaient
    // franchir au tour de parole la borne du planner, qui refuse alors l'historique ENTIER — et
    // l'assistant devenait muet sur toutes les lanes, exactement ce que ce module doit empêcher.
    const astral = '\u{1f527}'.repeat(100); // 100 points de code, 200 unités
    const sortie = sanitizeSpokenLabel(astral, 160);
    expect((sortie ?? '').length).toBeLessThanOrEqual(160);
    expect(sortie).not.toContain('\ufffd');
    // Un nom latin de 160 unités, lui, passe ENTIER : la borne ne punit pas le cas normal.
    const latin = 'A'.repeat(160);
    expect(sanitizeSpokenLabel(latin, 160)).toBe(latin);
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
