/**
 * U1-h L1 — LE NOM D'UNE FICHE N'A QU'UNE RÈGLE DE FRONTIÈRE.
 *
 * Ce que ces preuves défendent : deux Bob ne doivent pas prononcer deux noms différents pour la
 * même fiche. La règle était appliquée par quatre lectures du devis et ignorée par son jumeau
 * Jarvis, qui rendait la colonne BRUTE — une divergence invisible parce que le chemin Jarvis était
 * livré sans appelant. U1-h le branche : on répare AVANT de brancher.
 */
import { describe, expect, it } from 'vitest';

import { canonicalCustomerName } from './customer-candidate-sql';

describe('canonicalCustomerName — la seule règle de frontière du nom de fiche', () => {
  it('RÉPARE les espaces sans sémantique, celles que la base a laissé passer', () => {
    // Ce sont exactement les formes qui, servies telles quelles dans une parole de Bob, feraient
    // refuser l'historique ENTIER au planner du tour suivant — toutes lanes muettes.
    expect(canonicalCustomerName('  Dupont Plomberie  ')).toBe('Dupont Plomberie');
    expect(canonicalCustomerName('Dupont   Plomberie')).toBe('Dupont Plomberie');
    // Espace insécable, puis tabulation : invisibles à l'œil, fatales à la parole si elles
    // survivent — le planner refuse alors l'historique entier au tour suivant.
    expect(canonicalCustomerName('Dupont\u00a0Plomberie')).toBe('Dupont Plomberie');
    expect(canonicalCustomerName('Dupont\tPlomberie')).toBe('Dupont Plomberie');
  });

  it('LAISSE INTACTE une valeur réellement invalide — le validateur du noyau doit échouer FERMÉ', () => {
    // Réparer ici masquerait la dérive : une ligne hors forme doit rester hors forme, pour que le
    // domaine la refuse en la nommant plutôt que de la voir passer maquillée.
    const controle = 'Dupont\u0000Plomberie';
    expect(canonicalCustomerName(controle)).toBe(controle);
    expect(canonicalCustomerName('')).toBe('');
    expect(canonicalCustomerName('   ')).toBe('   ');
  });

  it('est IDEMPOTENTE : renormaliser une sortie ne la change plus', () => {
    for (const brut of ['  Dupont   Plomberie ', 'Éléonore\u00a0Bâtiment', 'SARL M&M']) {
      const une = canonicalCustomerName(brut);
      expect(canonicalCustomerName(une)).toBe(une);
    }
  });

  it('ne touche PAS aux noms déjà propres — la règle ne coûte rien au cas normal', () => {
    for (const propre of [
      'Dupont Plomberie SARL',
      'Éléonore Bâtiment & Fils',
      "L'Atelier d'À Côté",
      'H&M Paris Centre',
      '4 Murs',
    ]) {
      expect(canonicalCustomerName(propre)).toBe(propre);
    }
  });
});
