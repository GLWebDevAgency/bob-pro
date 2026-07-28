import { describe, it, expect } from 'vitest';
import { parisDateOnly } from '../../shared-kernel/time';
import {
  estBloquante,
  messageVeilleMentions,
  sonne,
  veilleMentionsLegales,
} from './veille-mentions-legales';

/**
 * TEST-SENTINELLE — le seul test du dépôt qui lit l'HORLOGE RÉELLE, et c'est délibéré.
 *
 * IL PORTE L'ÉTAGE 2, ET LUI SEUL. Il échoue le jour où une échéance de mention légale est
 * ATTEINTE (`regime === 'blocage'`), et il casse alors la CI de toute PR du dépôt, avec le geste à
 * faire et les sources dans le message d'échec.
 *
 * IL NE PORTE PAS L'ÉTAGE 1, et c'est le cœur du régime d'alarme. Le préavis du décret CIBS s'ouvre
 * 90 jours avant le 01/01/2027 : faire échouer ce test dès le préavis rendrait le dépôt rouge
 * pendant trois mois, sur des PR qui n'ont rien à voir — et une alarme permanente finit toujours
 * par être désactivée par le premier qui en a besoin. Le préavis passe donc par des canaux VISIBLES
 * et NON BLOQUANTS : annotation GitHub + résumé de run à chaque PR et chaque push de main
 * (apps/api/scripts/veille-mentions-legales-ci.mjs), et journal au démarrage de l'API.
 *
 * SI VOUS LISEZ CECI PARCE QU'IL VIENT D'ÉCHOUER : ce n'est pas une régression, c'est l'alarme, et
 * elle est au dernier étage — l'échéance est passée, le préavis a été ignoré. Lisez le message,
 * faites le geste. Ne faites JAMAIS taire ce test en fabriquant une rédaction de mention non
 * sourcée : les mentions sont figées à l'émission, une pièce fausse le reste pour toujours. Et
 * aucune vérification datée n'apaise cet étage-ci : l'apaisement ne vaut que pendant le préavis.
 */
describe('SENTINELLE — veille des mentions légales (horloge réelle)', () => {
  // Jour métier Paris : la même source de vérité que les pièces émises (jamais l'UTC brut, qui
  // décale d'un jour juste après minuit en France).
  const alertes = () => veilleMentionsLegales(parisDateOnly());

  it('ÉTAGE 2 — aucune échéance de mention légale ATTEINTE ; si ce test échoue, c’est l’alarme, pas un bug', () => {
    const bloquantes = alertes().filter(estBloquante);
    expect(bloquantes, messageVeilleMentions(bloquantes)).toHaveLength(0);
  });

  it('ÉTAGE 1 — un préavis en cours ne fait PAS échouer la CI : il s’annonce, il n’empêche pas de livrer', () => {
    // Ce test ne peut pas devenir rouge : il fige une PROPRIÉTÉ du régime (« aucune alerte non
    // échue n'est bloquante »), pas l'état du calendrier. Sans lui, quelqu'un pourrait recâbler le
    // préavis en blocage sans qu'aucun test ne s'y oppose — et on aurait reconstruit exactement
    // l'alarme permanente qu'on vient de démonter.
    const nonEchues = alertes().filter((a) => a.niveau !== 'echue');
    expect(nonEchues.filter(estBloquante)).toEqual([]);
    // Le préavis reste VISIBLE : ce qui sonne sans bloquer part vers les canaux d'avertissement.
    for (const alerte of nonEchues.filter(sonne)) {
      expect(alerte.regime).toBe('avertissement');
      expect(messageVeilleMentions([alerte])).toContain(alerte.echeance.id);
    }
  });
});
