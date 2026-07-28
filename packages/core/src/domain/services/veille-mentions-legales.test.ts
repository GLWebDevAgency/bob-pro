import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ECHEANCES_MENTIONS_LEGALES,
  RE_ARMEMENT_VERIFICATION_JOURS,
  estBloquante,
  evaluerEcheances,
  messageVeilleMentions,
  sonne,
  veilleMentionsLegales,
  type EcheanceMentionLegale,
} from './veille-mentions-legales';
import { parisDateOnly, isValidDateOnly } from '../../shared-kernel/time';
import {
  CIBS_TVA_ENTREE_EN_VIGUEUR,
  CIBS_TOLERANCE_REFERENCES_CGI,
  MENTION_FRANCHISE_BASE,
  REFERENCES_CGI_IMPRIMEES,
  mentionFranchiseAu,
} from './build-mentions';
import { type DateOnly, addDays } from '../../shared-kernel/time';

const DECRET = 'cibs-decret-formulation-franchise';
const TOLERANCE = 'cibs-fin-tolerance-references-cgi';

const echeance = (id: string): EcheanceMentionLegale => {
  const e = ECHEANCES_MENTIONS_LEGALES.find((x) => x.id === id);
  if (!e) throw new Error(`échéance ${id} absente du registre`);
  return e;
};
/** Date située à `jours` avant l'échéance (jours négatifs = après). */
const avant = (id: string, jours: number): DateOnly => addDays(echeance(id).echeance, -jours);

const ids = (asOf: DateOnly): string[] => veilleMentionsLegales(asOf).map((a) => a.echeance.id);
const alerte = (asOf: DateOnly, id: string) => {
  const a = veilleMentionsLegales(asOf).find((x) => x.echeance.id === id);
  if (!a) throw new Error(`aucune alerte ${id} au ${asOf}`);
  return a;
};

describe('veille des mentions légales — l’alarme datée du bloc mentions', () => {
  // Le cœur du finding : une bascule automatique fausse a été retirée, et RIEN ne pouvait plus
  // se déclencher au 01/01/2027 ni au 30/06/2028. Ces tests prouvent que ça se déclenche.
  describe('déclenchement (dates simulées)', () => {
    it('loin de toute échéance : silence total — c’est le cas nominal', () => {
      expect(veilleMentionsLegales('2026-07-28')).toEqual([]);
      expect(ids(avant(DECRET, 91))).toEqual([]);
    });

    it('DÉCRET CIBS — l’alarme s’arme au premier jour du préavis (90 j) et pas la veille', () => {
      expect(ids(avant(DECRET, 91))).toEqual([]);
      const alertes = veilleMentionsLegales(avant(DECRET, 90));
      expect(alertes).toHaveLength(1);
      expect(alertes[0]?.echeance.id).toBe(DECRET);
      expect(alertes[0]?.niveau).toBe('preavis');
      expect(alertes[0]?.joursRestants).toBe(90);
    });

    it('DÉCRET CIBS — la veille de l’échéance : préavis à 1 jour', () => {
      const alertes = veilleMentionsLegales(avant(DECRET, 1));
      expect(alertes[0]?.niveau).toBe('preavis');
      expect(alertes[0]?.joursRestants).toBe(1);
    });

    it('DÉCRET CIBS — le jour J (01/01/2027) puis après : échue, jours restants ≤ 0', () => {
      const jourJ = veilleMentionsLegales(CIBS_TVA_ENTREE_EN_VIGUEUR);
      expect(jourJ[0]?.niveau).toBe('echue');
      expect(jourJ[0]?.joursRestants).toBe(0);
      const apres = veilleMentionsLegales(addDays(CIBS_TVA_ENTREE_EN_VIGUEUR, 60));
      expect(apres[0]?.niveau).toBe('echue');
      expect(apres[0]?.joursRestants).toBe(-60);
    });

    it('FIN DE TOLÉRANCE — préavis plus long (180 j), et les deux échéances sonnent ensemble', () => {
      expect(ids(avant(TOLERANCE, 181))).toEqual([DECRET]);
      const alertes = veilleMentionsLegales(avant(TOLERANCE, 180));
      expect(alertes.map((a) => a.echeance.id)).toEqual([DECRET, TOLERANCE]);
      expect(alertes[0]?.niveau).toBe('echue'); // le décret est échu depuis longtemps
      expect(alertes[1]?.niveau).toBe('preavis');
      expect(alertes[1]?.joursRestants).toBe(180);
    });

    it('après la fin de tolérance (30/06/2028) : les deux échues — la mention imprimée n’est plus admise', () => {
      const alertes = veilleMentionsLegales(addDays(CIBS_TOLERANCE_REFERENCES_CGI, 1));
      expect(alertes.map((a) => a.echeance.id)).toEqual([DECRET, TOLERANCE]);
      expect(alertes.every((a) => a.niveau === 'echue')).toBe(true);
    });

    it('les alertes sortent triées par échéance, la plus proche d’abord', () => {
      const dates = veilleMentionsLegales(CIBS_TOLERANCE_REFERENCES_CGI).map((a) => a.echeance.echeance);
      expect(dates).toEqual([...dates].sort());
    });
  });

  // ————————————————————————————————————————————————————————————————————————————————————————————
  // LE RÉGIME D'ALARME. Le dispositif précédent était binaire : silencieux, puis bloquant pour tout
  // le dépôt pendant 90 jours. Une CI rouge trois mois durant se termine toujours par une
  // désactivation — et une alarme qu'on désactive ne protège plus personne. Ces tests figent les
  // deux étages, et surtout la FRONTIÈRE entre les deux.
  // ————————————————————————————————————————————————————————————————————————————————————————————
  describe('régime d’alarme — deux étages, un seul bloque', () => {
    it('ÉTAGE 1 — tout le préavis est `avertissement` : VISIBLE, jamais bloquant, du premier au dernier jour', () => {
      for (const jours of [90, 89, 45, 2, 1]) {
        const a = alerte(avant(DECRET, jours), DECRET);
        expect(a.niveau).toBe('preavis');
        expect(a.regime).toBe('avertissement');
        expect(estBloquante(a)).toBe(false);
        expect(sonne(a)).toBe(true);
      }
    });

    it('ÉTAGE 2 — l’échéance atteinte bascule en `blocage`, le jour J et pas la veille', () => {
      const veille = alerte(avant(DECRET, 1), DECRET);
      expect(estBloquante(veille)).toBe(false);
      for (const asOf of [CIBS_TVA_ENTREE_EN_VIGUEUR, addDays(CIBS_TVA_ENTREE_EN_VIGUEUR, 1), '2028-01-01']) {
        const a = alerte(asOf, DECRET);
        expect(a.niveau).toBe('echue');
        expect(a.regime).toBe('blocage');
        expect(estBloquante(a)).toBe(true);
      }
    });

    it('les deux échéances ont leur propre étage 2 : la fin de tolérance bloque à sa date à elle', () => {
      const avantFin = alerte(avant(TOLERANCE, 1), TOLERANCE);
      expect(estBloquante(avantFin)).toBe(false);
      expect(estBloquante(alerte(CIBS_TOLERANCE_REFERENCES_CGI, TOLERANCE))).toBe(true);
    });
  });

  // ————————————————————————————————————————————————————————————————————————————————————————————
  // L'APAISEMENT. Seul moyen de faire taire un préavis : mettre à jour la date de vérification.
  // Un geste daté, revuable en diff, qui se ré-arme tout seul. Ces tests interdisent qu'il devienne
  // un interrupteur.
  // ————————————————————————————————————————————————————————————————————————————————————————————
  describe('apaisement du préavis — une vérification datée, jamais un interrupteur', () => {
    // Le registre de production est une constante, et c'est voulu : le geste d'apaisement doit se
    // relire en diff. On éprouve donc le MÉCANISME sur des registres simulés (`evaluerEcheances`),
    // sans jamais muter le registre réel : `auJour(n)` évalue au 15/11/2026 — une date située dans
    // la fenêtre de préavis du décret — un registre dont la vérification date de n jours plus tôt.
    const AU_JOUR = '2026-11-15'; // dans le préavis du décret (90 j avant le 01/01/2027)
    const registreVerifieIlYA = (jours: number): readonly EcheanceMentionLegale[] => [
      { ...echeance(DECRET), verifieLe: addDays(AU_JOUR, -jours) },
    ];
    const auJour = (jours: number) => {
      const alertes = evaluerEcheances(registreVerifieIlYA(jours), AU_JOUR);
      expect(alertes).toHaveLength(1);
      return alertes[0]!;
    };

    it('vérification du JOUR MÊME : l’alarme se tait — régime `information`, et la date de ré-armement est affichée', () => {
      const a = auJour(0);
      expect(a.niveau).toBe('apaisee');
      expect(a.regime).toBe('information');
      expect(estBloquante(a)).toBe(false);
      expect(sonne(a)).toBe(false);
      expect(a.reArmementLe).toBe(addDays(AU_JOUR, RE_ARMEMENT_VERIFICATION_JOURS));
    });

    it('LA BORNE est nette : 29 jours après la vérification c’est encore apaisé, 30 jours après l’alarme revient SEULE', () => {
      expect(auJour(RE_ARMEMENT_VERIFICATION_JOURS - 1).niveau).toBe('apaisee');
      const reArmee = auJour(RE_ARMEMENT_VERIFICATION_JOURS);
      expect(reArmee.niveau).toBe('preavis');
      expect(reArmee.regime).toBe('avertissement');
      expect(reArmee.reArmementLe).toBeNull();
      // Personne n'a rien à faire pour que l'alarme revienne : c'est la propriété qui distingue un
      // apaisement d'un interrupteur.
      expect(auJour(RE_ARMEMENT_VERIFICATION_JOURS + 200).niveau).toBe('preavis');
    });

    it('la date de ré-armement se déduit de `verifieLe`, donc chaque apaisement est traçable à sa vérification', () => {
      for (const age of [0, 5, 29]) {
        const a = auJour(age);
        expect(a.joursDepuisVerification).toBe(age);
        expect(a.reArmementLe).toBe(addDays(a.echeance.verifieLe, RE_ARMEMENT_VERIFICATION_JOURS));
      }
    });

    it('une vérification POST-DATÉE n’apaise rien : fail-closed, sinon on s’offrirait des mois de silence en une ligne', () => {
      const futur = evaluerEcheances(
        [{ ...echeance(DECRET), verifieLe: addDays(AU_JOUR, 40) }],
        AU_JOUR,
      );
      expect(futur[0]?.niveau).toBe('preavis');
      expect(futur[0]?.joursDepuisVerification).toBe(-40);
      expect(sonne(futur[0]!)).toBe(true);
    });

    it('l’apaisement ne franchit JAMAIS l’étage 2 : vérifiée le matin même, une échéance atteinte reste BLOQUANTE', () => {
      for (const asOf of [CIBS_TVA_ENTREE_EN_VIGUEUR, addDays(CIBS_TVA_ENTREE_EN_VIGUEUR, 5)]) {
        const alertes = evaluerEcheances([{ ...echeance(DECRET), verifieLe: asOf }], asOf);
        expect(alertes[0]?.niveau).toBe('echue');
        expect(alertes[0]?.regime).toBe('blocage');
        expect(alertes[0]?.reArmementLe).toBeNull();
        expect(estBloquante(alertes[0]!)).toBe(true);
      }
    });

    it('l’apaisement ne touche QUE l’entrée vérifiée : les autres échéances continuent de sonner', () => {
      const asOf = avant(TOLERANCE, 100); // les deux échéances sont en fenêtre
      const alertes = evaluerEcheances(
        [{ ...echeance(DECRET) }, { ...echeance(TOLERANCE), verifieLe: asOf }],
        asOf,
      );
      expect(alertes.map((a) => [a.echeance.id, a.regime])).toEqual([
        [DECRET, 'blocage'],
        [TOLERANCE, 'information'],
      ]);
    });

    it('le geste d’apaisement est ÉCRIT dans le message, avec sa durée, son ré-armement et ses interdits', () => {
      const message = messageVeilleMentions(veilleMentionsLegales(avant(DECRET, 90)));
      expect(message).toContain('mettre `verifieLe`');
      expect(message).toContain('30 jours');
      expect(message).toContain('se ré-arme SEULE');
      expect(message).toContain('Aucune variable d’environnement');
      expect(message).toContain('aucun skip, aucun commentaire magique');
      expect(message).toContain('déplacez jamais `echeance`');
    });

    it('un message d’échéance APAISÉE reste explicite : la trace du snooze se lit, elle ne se devine pas', () => {
      const message = messageVeilleMentions(evaluerEcheances(registreVerifieIlYA(3), AU_JOUR));
      expect(message).toContain('APAISÉE');
      expect(message).toContain('se ré-arme SEULE le');
      expect(message).toContain('un apaisement');
      expect(message).toContain('interrupteur déguisé');
    });
  });

  // ————————————————————————————————————————————————————————————————————————————————————————————
  // FAIL-CLOSED. Une DateOnly malformée rendait NaN, le filtre `joursRestants <= preavisJours` est
  // faux pour NaN, et l'échéance DISPARAISSAIT du résultat sans erreur ni trace : une veille légale
  // qui se tait sur une entrée douteuse est le contraire exact de sa raison d'être.
  // ————————————————————————————————————————————————————————————————————————————————————————————
  describe('dates douteuses — rejet explicite, jamais un silence', () => {
    it.each(['', 'invalide', '2027-13-45', '2026-2-3', '2026-02-30', '20260728', 'null'])(
      'rejette la date d’évaluation « %s » au lieu de renvoyer une veille vide',
      (asOf) => {
        expect(() => veilleMentionsLegales(asOf)).toThrow(/n'est pas une date valide/u);
        expect(() => veilleMentionsLegales(asOf)).toThrow(TypeError);
      },
    );

    it('le message d’erreur dit POURQUOI on rejette — sinon quelqu’un « corrigera » en repassant fail-open', () => {
      expect(() => veilleMentionsLegales('2027-13-45')).toThrow(/alarme se tairait/u);
      expect(() => veilleMentionsLegales('2027-13-45')).toThrow(/rejet est VOLONTAIRE/u);
      expect(() => veilleMentionsLegales('2027-13-45')).toThrow(/2027-13-45/u);
    });

    it('une date valide mais inhabituelle reste acceptée (bissextile, fin d’année)', () => {
      expect(() => veilleMentionsLegales('2028-02-29')).not.toThrow();
      expect(() => veilleMentionsLegales('2026-12-31')).not.toThrow();
    });

    it('AUCUNE échéance ne peut disparaître silencieusement : toutes les dates du registre sont valides', () => {
      for (const e of ECHEANCES_MENTIONS_LEGALES) {
        expect(isValidDateOnly(e.echeance)).toBe(true);
        expect(isValidDateOnly(e.verifieLe)).toBe(true);
      }
      // La preuve par le résultat : à une date postérieure à tout, les DEUX échéances sonnent.
      expect(veilleMentionsLegales('2030-01-01')).toHaveLength(ECHEANCES_MENTIONS_LEGALES.length);
    });
  });

  describe('message d’alarme — ce que lira quelqu’un qui découvre le sujet à 3 h du matin', () => {
    it('nomme le geste exact, cite les sources et interdit la rédaction fabriquée', () => {
      const message = messageVeilleMentions(veilleMentionsLegales(CIBS_TVA_ENTREE_EN_VIGUEUR));
      expect(message).toContain('le décret de formulation CIBS doit être vérifié et la mention mise à jour');
      expect(message).toContain('Ordonnance n° 2026-671 du 27/07/2026');
      expect(message).toContain('REDACTIONS_FRANCHISE');
      expect(message).toContain('Ce n’est PAS un bug');
      expect(message.toUpperCase()).toContain('AUCUNE rédaction non sourcée'.toUpperCase());
      expect(message).toContain(DECRET);
    });

    it('distingue « échue » de « dans N jours » et compte les jours de retard', () => {
      expect(messageVeilleMentions(veilleMentionsLegales(avant(DECRET, 90)))).toContain('dans 90 jour(s)');
      expect(messageVeilleMentions(veilleMentionsLegales(CIBS_TVA_ENTREE_EN_VIGUEUR)))
        .toContain('ÉCHUE AUJOURD’HUI');
      expect(messageVeilleMentions(veilleMentionsLegales(addDays(CIBS_TVA_ENTREE_EN_VIGUEUR, 12))))
        .toContain('ÉCHUE depuis 12 jour(s)');
    });

    it('l’en-tête annonce l’ÉTAGE : non bloquant en préavis, BLOQUANT une fois l’échéance atteinte', () => {
      const preavis = messageVeilleMentions(veilleMentionsLegales(avant(DECRET, 90)));
      expect(preavis).toContain('ÉTAGE 1, PRÉAVIS (non bloquant)');
      expect(preavis).toContain('rien ne vous empêche de livrer');
      const bloquant = messageVeilleMentions(veilleMentionsLegales(CIBS_TVA_ENTREE_EN_VIGUEUR));
      expect(bloquant).toContain('ÉTAGE 2, BLOQUANT');
      expect(bloquant).toContain('aucun apaisement à cet étage');
    });

    it('silence : un message explicite, jamais une chaîne vide qui passerait inaperçue', () => {
      expect(messageVeilleMentions([])).toContain('aucune échéance');
    });
  });

  describe('intégrité du registre — une veille sans source ne vaut rien', () => {
    it('chaque échéance porte un geste actionnable, au moins une source et une date de vérification', () => {
      expect(ECHEANCES_MENTIONS_LEGALES.length).toBeGreaterThan(0);
      for (const e of ECHEANCES_MENTIONS_LEGALES) {
        expect(e.id).toMatch(/^[a-z0-9-]+$/u);
        expect(e.echeance).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(e.verifieLe).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(e.preavisJours).toBeGreaterThan(0);
        expect(e.objet.length).toBeGreaterThan(40);
        expect(e.aFaire.length).toBeGreaterThan(40);
        expect(e.sources.length).toBeGreaterThan(0);
        expect(e.sources.every((s) => s.trim().length > 0)).toBe(true);
      }
      expect(new Set(ECHEANCES_MENTIONS_LEGALES.map((e) => e.id)).size)
        .toBe(ECHEANCES_MENTIONS_LEGALES.length);
    });

    it('les dates viennent des constantes sourcées, jamais réécrites en dur (elles ont déjà bougé une fois)', () => {
      expect(echeance(DECRET).echeance).toBe(CIBS_TVA_ENTREE_EN_VIGUEUR);
      expect(echeance(TOLERANCE).echeance).toBe(CIBS_TOLERANCE_REFERENCES_CGI);
    });

    it('le préavis est plus court que le délai réel : une échéance ne peut pas naître déjà bloquante', () => {
      for (const e of ECHEANCES_MENTIONS_LEGALES) {
        expect(e.preavisJours).toBeGreaterThan(RE_ARMEMENT_VERIFICATION_JOURS);
      }
    });
  });

  // Les tests ci-dessus prouvent la FONCTION. Ceux-ci prouvent la SENTINELLE : l'expression exacte
  // qu'exécute veille-mentions-legales.sentinelle.test.ts (`veilleMentionsLegales(parisDateOnly())`),
  // horloge simulée. Sans ça, on saurait que la veille sait calculer, sans jamais savoir qu'elle
  // sonne — c'est précisément l'écart entre une échéance documentée et une alarme réelle.
  describe('la sentinelle SONNE vraiment (horloge simulée sur une date postérieure)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const sentinelleA = (instantParis: string) => {
      vi.useFakeTimers();
      // Midi heure de Paris : à l'abri du décalage UTC de part et d'autre de minuit.
      vi.setSystemTime(new Date(`${instantParis}T12:00:00.000Z`));
      return veilleMentionsLegales(parisDateOnly());
    };

    it('aujourd’hui (hors préavis) : la sentinelle est verte — elle ne crie pas pour rien', () => {
      expect(sentinelleA('2026-07-28')).toHaveLength(0);
    });

    it('au premier jour du préavis du décret : la sentinelle reste VERTE, mais l’avertissement part', () => {
      const alertes = sentinelleA(avant(DECRET, 90));
      expect(alertes).toHaveLength(1);
      expect(alertes[0]?.echeance.id).toBe(DECRET);
      // Étage 1 : rien à bloquer — c'est tout l'objet du régime à deux étages.
      expect(alertes.filter(estBloquante)).toEqual([]);
      expect(alertes.every(sonne)).toBe(true);
      // C'est ce message-là que la CI afficherait, en avertissement.
      expect(messageVeilleMentions(alertes))
        .toContain('le décret de formulation CIBS doit être vérifié et la mention mise à jour');
    });

    it('au 01/01/2027 puis au 01/07/2028 : la sentinelle ÉCHOUERAIT, de plus en plus fort', () => {
      const jourJ = sentinelleA(CIBS_TVA_ENTREE_EN_VIGUEUR);
      expect(jourJ.map((a) => a.niveau)).toEqual(['echue']);
      expect(jourJ.filter(estBloquante)).toHaveLength(1);
      const finTolerance = sentinelleA(addDays(CIBS_TOLERANCE_REFERENCES_CGI, 1));
      expect(finTolerance).toHaveLength(2);
      expect(finTolerance.every((a) => a.niveau === 'echue')).toBe(true);
      expect(finTolerance.filter(estBloquante)).toHaveLength(2);
    });

    it('le 2026-10-03, jour où l’ancien dispositif serait passé au rouge pour 90 jours : préavis, CI verte', () => {
      // La date exacte qui a motivé ce régime. Avec l'ancien code, `pnpm test` échouait sur TOUTE
      // PR du dépôt à partir de ce jour et jusqu'au 01/01/2027.
      const alertes = sentinelleA('2026-10-03');
      expect(alertes).toHaveLength(1);
      expect(alertes[0]?.regime).toBe('avertissement');
      expect(alertes.filter(estBloquante)).toEqual([]);
    });
  });

  describe('boucle fermée avec les rédactions imprimées', () => {
    it('tant que le décret n’est pas en table, la mention imprimée reste la seule rédaction sourcée', () => {
      for (const asOf of ['2026-07-28', '2026-09-01', CIBS_TVA_ENTREE_EN_VIGUEUR, CIBS_TOLERANCE_REFERENCES_CGI]) {
        expect(mentionFranchiseAu(asOf)).toBe(MENTION_FRANCHISE_BASE);
        expect(mentionFranchiseAu(asOf)).not.toContain('CIBS');
        expect(mentionFranchiseAu(asOf)).not.toContain('L. 223-3');
      }
    });

    it('l’alarme réclame très exactement le geste qui la fera taire : ajouter la rédaction en table', () => {
      const aFaire = echeance(DECRET).aFaire;
      expect(aFaire).toContain('REDACTIONS_FRANCHISE');
      expect(aFaire).toContain('verbatim');
    });

    // Le finding : l'objet posait la règle GÉNÉRALE (au 30/06/2028 aucune référence CGI n'est plus
    // admise) mais le geste ne parlait que de la franchise. Quatre mentions au moins sont
    // concernées : une veille qui n'en nomme qu'une laisse les autres expirer en silence.
    it('FIN DE TOLÉRANCE — le geste énumère TOUTES les mentions qui citent le CGI, pas seulement la franchise', () => {
      const aFaire = echeance(TOLERANCE).aFaire;
      expect(REFERENCES_CGI_IMPRIMEES.length).toBeGreaterThanOrEqual(4);
      for (const reference of REFERENCES_CGI_IMPRIMEES) {
        expect(aFaire).toContain(`art. ${reference.article} du CGI`);
      }
      // Et il dit, pour chacune, si la correspondance CIBS est certaine ou inconnue.
      expect(aFaire).toContain('CERTAIN : ');
      expect(aFaire).toContain('correspondance CIBS INCONNUE');
    });

    it('FIN DE TOLÉRANCE — aucune correspondance inventée : « INCONNUE » est dit, pas comblé', () => {
      const aFaire = echeance(TOLERANCE).aFaire;
      const inconnues = REFERENCES_CGI_IMPRIMEES.filter((r) => r.concordance.statut === 'inconnue');
      expect(inconnues.length).toBeGreaterThan(0);
      for (const reference of inconnues) {
        // Un article CIBS collé à une référence non relevée serait exactement la fabrication qu'on
        // s'interdit : le geste doit dire « à relever », jamais proposer une cible.
        expect(aFaire).toContain(`art. ${reference.article} du CGI`);
      }
      expect(aFaire).toContain('jamais à déduire');
      expect(aFaire).toContain('ne se déduit jamais');
      // Le hors-périmètre est nommé lui aussi : sinon on croit à un oubli et on l'« ajoute ».
      expect(aFaire).toContain('MENTION_OPTION_DEBITS');
    });
  });
});
