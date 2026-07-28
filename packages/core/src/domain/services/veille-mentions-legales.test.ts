import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ECHEANCES_MENTIONS_LEGALES,
  veilleMentionsLegales,
  messageVeilleMentions,
} from './veille-mentions-legales';
import { parisDateOnly } from '../../shared-kernel/time';
import {
  CIBS_TVA_ENTREE_EN_VIGUEUR,
  CIBS_TOLERANCE_REFERENCES_CGI,
  MENTION_FRANCHISE_BASE,
  mentionFranchiseAu,
} from './build-mentions';
import { type DateOnly, addDays } from '../../shared-kernel/time';

const DECRET = 'cibs-decret-formulation-franchise';
const TOLERANCE = 'cibs-fin-tolerance-references-cgi';

const echeance = (id: string) => {
  const e = ECHEANCES_MENTIONS_LEGALES.find((x) => x.id === id);
  if (!e) throw new Error(`échéance ${id} absente du registre`);
  return e;
};
/** Date située à `jours` avant l'échéance (jours négatifs = après). */
const avant = (id: string, jours: number): DateOnly => addDays(echeance(id).echeance, -jours);

const ids = (asOf: DateOnly): string[] => veilleMentionsLegales(asOf).map((a) => a.echeance.id);

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

    it('au premier jour du préavis du décret : la sentinelle ÉCHOUERAIT, avec le geste à faire', () => {
      const alertes = sentinelleA(avant(DECRET, 90));
      expect(alertes).toHaveLength(1);
      expect(alertes[0]?.echeance.id).toBe(DECRET);
      // C'est ce message-là que la CI afficherait.
      expect(messageVeilleMentions(alertes))
        .toContain('le décret de formulation CIBS doit être vérifié et la mention mise à jour');
    });

    it('au 01/01/2027 puis au 01/07/2028 : la sentinelle ÉCHOUERAIT, de plus en plus fort', () => {
      expect(sentinelleA(CIBS_TVA_ENTREE_EN_VIGUEUR).map((a) => a.niveau)).toEqual(['echue']);
      const finTolerance = sentinelleA(addDays(CIBS_TOLERANCE_REFERENCES_CGI, 1));
      expect(finTolerance).toHaveLength(2);
      expect(finTolerance.every((a) => a.niveau === 'echue')).toBe(true);
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
  });
});
