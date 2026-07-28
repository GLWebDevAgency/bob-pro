import { describe, expect, it } from 'vitest';
import { retireConfirmMessage } from './equipment-retire.logic';

/**
 * [Amélioration 4] — l'avertissement contrat est DIT AVANT la confirmation (domaine §1.5-1.6,
 * écrans §2.1 : « la ConfirmSheet porte l'avertissement honnête du domaine »). La copy vient
 * de @bob/core (equipmentContractCoverageWarning) : une seule vérité use case/écran/voix.
 */
describe('retireConfirmMessage — la ConfirmSheet porte l’avertissement AVANT le geste', () => {
  const BASE = '« Fontaine accueil R+2 » passera dans les équipements retirés.';

  it('équipement couvert : le message de la feuille porte l’avertissement du domaine', () => {
    const r = retireConfirmMessage(BASE, ['Entretien fontaines 2026']);
    expect(r.warningShown).toBe(true);
    expect(r.message).toContain(BASE);
    expect(r.message).toContain(
      'Couvert par le contrat Entretien fontaines 2026 : la couverture (et son prix) continue jusqu\'à modification du contrat.',
    );
  });

  it('plusieurs contrats actifs : tous cités (même jonction que le use case)', () => {
    const r = retireConfirmMessage(BASE, ['Entretien 2026', 'Astreinte hiver']);
    expect(r.message).toContain('Entretien 2026, Astreinte hiver');
  });

  it('aucune couverture : la feuille reste inchangée, rien d’inventé', () => {
    const r = retireConfirmMessage(BASE, []);
    expect(r).toEqual({ message: BASE, warningShown: false });
  });

  it('couverture ILLISIBLE (null — lecture échouée) : feuille inchangée, warningShown=false pour laisser le filet post-ACK parler', () => {
    const r = retireConfirmMessage(BASE, null);
    expect(r).toEqual({ message: BASE, warningShown: false });
  });
});
