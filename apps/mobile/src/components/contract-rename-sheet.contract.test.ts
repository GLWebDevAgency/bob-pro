import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Ce que la feuille « Renommer » de la fiche contrat DOIT tenir à l'écran — des garanties qui
 * ne vivent que dans le JSX (ce qui est affiché, ce qui est seulement dit au lecteur d'écran,
 * par quelles portes on sort d'un conflit) et qu'aucune fonction pure ne peut prouver seule.
 * Patron des contrats de source déjà en place (`screen-authoritative-data-contract.test.ts`).
 */
const source = readFileSync(new URL('../../app/contrat/[id].tsx', import.meta.url), 'utf8');

describe('feuille « Renommer » — ce que l’écran DIT, et à qui', () => {
  it('l’explication du bouton désactivé est VISIBLE, pas réservée au lecteur d’écran', () => {
    // Le verdict du champ est rendu en TEXTE sous le champ : un voyant voyait jusqu'ici un
    // bouton gris sans raison, l'explication n'atteignant que l'accessibilityLabel.
    expect(source).toContain('contractRenameNotice(renameSubmission.blocked)');
    expect(source).toContain('renameNotice !== null');
    expect(source).toContain('t(renameNotice.key,');
    // Plus aucune explication cachée dans un libellé d'accessibilité du bouton.
    expect(source).not.toContain('renameUnchanged');
    expect(source).not.toContain('renameBlockSaid');
  });

  it('le ton distingue « ça attend » de « ça ne passera pas » — jamais du rouge sur une attente', () => {
    expect(source).toContain("renameNotice.tone === 'refus'");
  });

  it('l’indice du champ est dit UNE fois : visible OU accessibilityHint, jamais les deux', () => {
    // Le même paragraphe servait d'accessibilityHint du champ ET de texte visible juste
    // dessous : un lecteur d'écran le lisait deux fois de suite.
    const mentions = source.match(/contrat\.renameHint/gu) ?? [];
    expect(mentions).toHaveLength(1);
    expect(source).not.toContain("accessibilityHint={t('contrat.renameHint'");
  });

  it('toutes les portes de sortie d’un conflit passent par le rechargement', () => {
    // `contractRenameCloseEffect` décide, et la feuille ET le bouton « Recharger la fiche »
    // sortent par la MÊME porte : fermer une feuille périmée ne peut pas laisser la vue
    // afficher un nom que le serveur a déjà remplacé.
    expect(source).toContain('contractRenameCloseEffect({');
    expect(source).toContain('onClose={closeRename}');
    expect(source).toContain('onPress={closeRename}');
    expect(source).toContain("effect === 'close_and_reload'");
    expect(source).toContain('void query.refetch()');
    // Le rechargement s'ANNONCE : sans cela, seul un voyant sait que la fiche a bougé.
    expect(source).toContain("t('contrat.renameReloaded'");
    // L'ancienne sortie muette (fermeture conditionnée au seul `isPending`) a disparu.
    expect(source).not.toContain('if (!rename.isPending) setRenameOpen(false)');
  });
});
