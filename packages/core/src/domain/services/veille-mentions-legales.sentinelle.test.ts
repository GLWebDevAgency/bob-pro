import { describe, it, expect } from 'vitest';
import { parisDateOnly } from '../../shared-kernel/time';
import { veilleMentionsLegales, messageVeilleMentions } from './veille-mentions-legales';

/**
 * TEST-SENTINELLE — le seul test du dépôt qui lit l'HORLOGE RÉELLE, et c'est délibéré.
 *
 * Tous les autres tests de la veille simulent des dates : ils prouvent que le mécanisme se
 * déclenche. Celui-ci est le mécanisme lui-même. Il est vert tant qu'aucune échéance de mention
 * légale n'est entrée dans son préavis, et il CASSE LA CI le jour où l'une d'elles y entre — sur
 * toute PR du dépôt, avec le geste à faire et les sources dans le message d'échec.
 *
 * SI VOUS LISEZ CECI PARCE QU'IL VIENT D'ÉCHOUER : ce n'est pas une régression, c'est l'alarme.
 * Lisez le message, faites le geste, et ne faites JAMAIS taire ce test en fabriquant une rédaction
 * de mention non sourcée — les mentions sont figées à l'émission, une pièce fausse le reste pour
 * toujours. La seule sortie légitime passe par ECHEANCES_MENTIONS_LEGALES : traiter l'échéance, ou
 * la repousser en documentant la vérification qui vient d'être faite (source + date).
 *
 * Pourquoi un test plutôt qu'un TODO daté : ce dépôt fait tourner sa CI à chaque PR, alors que
 * personne ne relit un commentaire le bon jour. L'alarme doit être impossible à ne pas voir.
 */
describe('SENTINELLE — veille des mentions légales (horloge réelle)', () => {
  it('aucune échéance de mention légale échue ou imminente — si ce test échoue, c’est l’alarme, pas un bug', () => {
    // Jour métier Paris : la même source de vérité que les pièces émises (jamais l'UTC brut, qui
    // décale d'un jour juste après minuit en France).
    const alertes = veilleMentionsLegales(parisDateOnly());
    expect(alertes, messageVeilleMentions(alertes)).toHaveLength(0);
  });
});
