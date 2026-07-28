import { describe, expect, it } from 'vitest';
import {
  extractSpokenContractFacts,
  extractSpokenContractLabel,
  extractSpokenEuroCents,
  extractSpokenStartDate,
  extractSpokenTerminationNote,
  sanitizeSpokenNote,
} from './contract-command';

/**
 * §2.7 — lecture PURE d'une consigne de contrat dictée. Le piège central est le séparateur de
 * MILLIERS : « 1 200 € par an » lu « 200 € » ferait naître un contrat au sixième de son prix,
 * silencieusement. Le reste : un fait non dit reste `null` (jamais deviné), les followUps
 * canoniques se relisent à l'identique (convergence).
 */

const TODAY = '2026-09-20';

describe('extractSpokenEuroCents — le séparateur de MILLIERS est LU', () => {
  it('« 1 200 € par an » vaut 1 200 €, jamais 200 €', () => {
    expect(extractSpokenEuroCents('1 200 € par an')).toBe(120_000);
    expect(extractSpokenEuroCents('1 200 euros par an')).toBe(120_000);
    expect(extractSpokenEuroCents('12 000 € par an')).toBe(1_200_000);
    // Espace fine insécable (dictée / clavier français).
    expect(extractSpokenEuroCents('1 200 €')).toBe(120_000);
    expect(extractSpokenEuroCents('1 200 €')).toBe(120_000);
  });

  it('décimales et formes simples ; rien de lisible ⇒ null (jamais un montant inventé)', () => {
    expect(extractSpokenEuroCents('400 €')).toBe(40_000);
    expect(extractSpokenEuroCents('1 200,50 €')).toBe(120_050);
    expect(extractSpokenEuroCents('89,9 eur')).toBe(8_990);
    expect(extractSpokenEuroCents('deux mille balles')).toBeNull();
    expect(extractSpokenEuroCents('0 €')).toBeNull();
  });
});

describe('extractSpokenStartDate — jamais une année supposée en silence', () => {
  it('formes numériques non ambiguës', () => {
    expect(extractSpokenStartDate('à partir du 01/10/2026', TODAY)).toBe('2026-10-01');
    expect(extractSpokenStartDate('à partir du 2026-10-01', TODAY)).toBe('2026-10-01');
    expect(extractSpokenStartDate('le 1er octobre 2027', TODAY)).toBe('2027-10-01');
  });

  it('sans année dite : la PROCHAINE occurrence ≥ aujourd’hui (une couverture ne rétroagit pas)', () => {
    expect(extractSpokenStartDate('ça démarre au 1er octobre', TODAY)).toBe('2026-10-01');
    // 1er juin est déjà passé le 20/09/2026 → l'échéance dite vise juin 2027.
    expect(extractSpokenStartDate('le client résilie au 1er juin', TODAY)).toBe('2027-06-01');
  });

  it('sans repère de jour métier, une date sans année reste illisible (null) plutôt qu’inventée', () => {
    expect(extractSpokenStartDate('ça démarre au 1er octobre', null)).toBeNull();
    expect(extractSpokenStartDate('un contrat sans date', TODAY)).toBeNull();
    // Date impossible : refusée, jamais « corrigée » en silence.
    expect(extractSpokenStartDate('à partir du 31/02/2026', TODAY)).toBeNull();
  });
});

describe('extractSpokenContractLabel — le libellé guillemeté des followUps se relit à l’identique', () => {
  it('lit le libellé dit et écarte les faits déjà extraits', () => {
    expect(
      extractSpokenContractLabel('Fais-moi le contrat fontaines RATP, 3 fontaines, 1 200 € par an'),
    ).toBe('Fontaines RATP');
    expect(extractSpokenContractLabel('Crée le contrat RATP CAP Bastille, 2 visites par an')).toBe(
      'RATP CAP Bastille',
    );
  });

  it('la forme CANONIQUE (guillemets) prime — convergence des followUps', () => {
    expect(
      extractSpokenContractLabel(
        'Crée le contrat « Fontaines RATP » pour le client cus-ratp à 1200 € par an, à partir du 01/10/2026',
      ),
    ).toBe('Fontaines RATP');
  });

  it('aucun libellé dit ⇒ null (Bob demandera, il n’invente pas de nom)', () => {
    expect(extractSpokenContractLabel('Crée le contrat')).toBeNull();
    expect(extractSpokenContractLabel('Active le contrat')).toBeNull();
  });

  /**
   * IMPACT LÉGAL — ce libellé est persisté comme libellé du contrat ET de sa LIGNE UNIQUE ;
   * la facture annuelle reprend cette ligne telle quelle (contractLinesToLineInputs). Un
   * libellé pollué s'IMPRIME donc sur une pièce légale. La confirmation groupée ne protège
   * pas : elle récite le libellé fautif, le pro n'entend que sa propre phrase.
   */
  it('le MONTANT dit ne pollue jamais le libellé — il finirait imprimé sur la facture annuelle', () => {
    expect(
      extractSpokenContractLabel('crée le contrat entretien 12 ascenseurs à 15 000 € par an'),
    ).toBe('Entretien 12 ascenseurs');
    // Espace fine insécable + « euros » dit en toutes lettres.
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines à 1 200 euros par an'),
    ).toBe('Entretien vitrines');
    // Décimales : la borne de ponctuation tronque le montant sur la virgule décimale — le
    // nombre nu qui reste ne doit pas davantage devenir un morceau du libellé.
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines à 1 200,50 euros par an'),
    ).toBe('Entretien vitrines');
  });

  it('la DATE dite ne pollue jamais le libellé — « ça démarre », « à partir du » sont ACCENTUÉS', () => {
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines ça démarre au 1er octobre'),
    ).toBe('Entretien vitrines');
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines à partir du 01/10/2026'),
    ).toBe('Entretien vitrines');
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines dès le 01/10/2026'),
    ).toBe('Entretien vitrines');
  });

  it('la périodicité dite ne pollue jamais le libellé, même sans virgule pour la borner', () => {
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines 2 passages par an'),
    ).toBe('Entretien vitrines');
  });

  it('le libellé NETTOYÉ converge : relu depuis la forme canonique, il ne bouge plus', () => {
    const first = extractSpokenContractLabel(
      'crée le contrat entretien 12 ascenseurs à 15 000 € par an',
    );
    expect(first).toBe('Entretien 12 ascenseurs');
    // Forme canonique que Bob REDIT à chaque followUp (restate) : elle doit se relire à
    // l'identique, sinon le libellé se reconstruirait autrement d'un tour à l'autre.
    expect(
      extractSpokenContractLabel(
        `Crée le contrat « ${first!} » pour le client cus-x à 15000 € par an, à partir du 01/10/2026`,
      ),
    ).toBe(first);
  });
});

/**
 * REFONTE STRUCTURELLE — le libellé est le SEGMENT UTILE entre l'amorce de geste et la PREMIÈRE
 * charnière factuelle, et chaque charnière est portée par le LECTEUR du fait lui-même (qui sait
 * où son fait commence). Les cas ci-dessous sont ceux que la construction rend justes SANS
 * nettoyeur dédié — et ceux où sur-couper serait aussi grave que sous-couper.
 */
describe('extractSpokenContractLabel — construit par charnières, jamais par soustraction', () => {
  const FICHIER = ['RATP', 'Carrefour', 'Vinci Immobilier'];

  it('« pour le client … » borne le libellé même SANS guillemets (forme inerte en passe 4)', () => {
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines pour le client RATP'),
    ).toBe('Entretien vitrines');
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines pour la société Vinci Immobilier'),
    ).toBe('Entretien vitrines');
  });

  /**
   * « pour RATP » (sans le mot « client ») n'est reconnaissable QUE si RATP est un client du
   * fichier : aucun motif ne peut le deviner. L'hôte passe donc ses noms réels au module pur —
   * il ne résout rien, il reconnaît juste la charnière. Sans le fichier, Bob garde la phrase
   * telle qu'entendue plutôt que de couper au hasard.
   */
  it('« pour <nom propre RÉSOLU> » borne le libellé ; sans le fichier client, rien n’est coupé', () => {
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines pour RATP', {
        customerNames: FICHIER,
      }),
    ).toBe('Entretien vitrines');
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines chez Carrefour', {
        customerNames: FICHIER,
      }),
    ).toBe('Entretien vitrines');
    expect(extractSpokenContractLabel('Crée le contrat entretien vitrines pour RATP')).toBe(
      'Entretien vitrines pour RATP',
    );
  });

  /**
   * Contre-épreuve indispensable : SUR-couper mutile le nom du contrat sur la facture annuelle
   * aussi sûrement qu'une sous-coupe y imprime un montant. Un nom propre de client DANS le
   * libellé (« Fontaines RATP ») nomme le contrat, il ne l'attribue pas — seule la préposition
   * d'attribution fait la charnière.
   */
  it('les libellés LÉGITIMES survivent — chiffres, prépositions, traits d’union, noms propres', () => {
    const cases: readonly [string, string][] = [
      ['Fais-moi le contrat porte-à-faux quai 3, 1 200 € par an', 'Porte-à-faux quai 3'],
      ['Crée le contrat entretien à 3 niveaux à 15 000 € par an', 'Entretien à 3 niveaux'],
      ['Crée le contrat Eurotunnel Nord, 2 visites par an', 'Eurotunnel Nord'],
      ['Crée le contrat Carrefour Europe 2 à 900 € par an', 'Carrefour Europe 2'],
      ['fais-moi le contrat fontaines RATP, 1 200 € par an', 'Fontaines RATP'],
      ['Crée le contrat Bastille à partir du 01/10/2026', 'Bastille'],
    ];
    for (const [said, expected] of cases) {
      expect(extractSpokenContractLabel(said, { customerNames: FICHIER })).toBe(expected);
    }
  });

  /**
   * Dictée D'UNE TRAITE (sans virgule) : c'est là que les trois revues précédentes ont trouvé
   * leurs failles, faute de ponctuation pour borner le segment. Le tarif en argot est reconnu à
   * sa STRUCTURE distributive (« tant par quelque chose »), pas à un lexique d'argot.
   */
  it('dictée d’une traite : le tarif en argot n’emporte pas le chiffre DU libellé', () => {
    expect(extractSpokenContractLabel('Crée le contrat porte-à-faux quai 3 400 balles par an')).toBe(
      'Porte-à-faux quai 3',
    );
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines 400 balles par machine'),
    ).toBe('Entretien vitrines');
  });

  it('un CADRE de parc dit borne le libellé (« ils ont … », « … à entretenir »)', () => {
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines ils ont 3 machines'),
    ).toBe('Entretien vitrines');
    expect(
      extractSpokenContractLabel('Crée le contrat entretien vitrines 12 ascenseurs à entretenir'),
    ).toBe('Entretien vitrines');
    // … mais « 12 ascenseurs » SANS cadre appartient au nom du contrat, et y reste.
    expect(
      extractSpokenContractLabel('Crée le contrat entretien 12 ascenseurs à partir du 01/10/2026'),
    ).toBe('Entretien 12 ascenseurs');
  });
});

describe('faits voisins — la découpe ne s’obtient jamais en abîmant la lecture', () => {
  /**
   * Dictée d'une traite : « … au 1er octobre 1200 euros par an » offrait « 1200 » comme ANNÉE.
   * Le contrat naissait avec une date anniversaire en l'an 1200 — donc des échéances aberrantes —
   * et la confirmation la récitait sans que personne ne la relise. Un millésime hors de portée
   * n'est pas un fait, c'est un artefact de dictée.
   */
  it('une ANNÉE implausible n’est pas un fait : la date sans année reprend la main', () => {
    const facts = extractSpokenContractFacts(
      'Crée le contrat entretien vitrines ça démarre au 1er octobre 1200 euros par an',
      TODAY,
    );
    expect(facts.startDate).toBe('2026-10-01');
    expect(facts.annualAmountCents).toBe(120_000);
    expect(facts.label).toBe('Entretien vitrines');
  });

  it('la cadence se lit aussi hors « N visites » — et reste NON LUE si le compte n’est pas exact', () => {
    const visits = (said: string): number | null =>
      extractSpokenContractFacts(`Crée le contrat « Entretien vitrines », ${said}`, TODAY)
        .visitsPerYear;
    expect(visits('tous les 6 mois')).toBe(2);
    expect(visits('une fois par trimestre')).toBe(4);
    expect(visits('tous les ans')).toBe(1);
    // 12 / 5 n'est pas un compte entier : la cadence reste non lue plutôt que fausse.
    expect(visits('tous les 5 mois')).toBeNull();
  });
});

/**
 * RÈGLE POSITIVE du nombre d'équipements. L'ancienne garde comptait par DÉFAUT tout « nombre +
 * nom d'au moins 4 lettres », sauf liste noire d'unités et d'argot : tout autre nom commun
 * passait. Ici un nombre ne compte des équipements que s'il QUALIFIE UN OBJET DU PARC — cadre de
 * parc dit, vocabulaire réel du parc, ou reprise du libellé. Au moindre doute : aucun fait.
 */
describe('extractSpokenEquipmentCount — corroboré, sinon null (jamais un nombre faux)', () => {
  it('un nom commun quelconque ne compte RIEN sans corroboration', () => {
    expect(
      extractSpokenContractFacts('Crée le contrat « Entretien vitrines », 3 tabourets', TODAY)
        .equipmentCount,
    ).toBeNull();
    expect(
      extractSpokenContractFacts('Crée le contrat « Entretien vitrines », 6 étages', TODAY)
        .equipmentCount,
    ).toBeNull();
  });

  it('un CADRE de parc dit corrobore (« ils ont », « il y a », « à entretenir », « parc de »)', () => {
    const count = (said: string): number | null =>
      extractSpokenContractFacts(`Crée le contrat « Entretien vitrines », ${said}`, TODAY)
        .equipmentCount;
    expect(count('ils ont 3 tabourets')).toBe(3);
    expect(count('il y a 8 tabourets')).toBe(8);
    expect(count('un parc de 12 tabourets')).toBe(12);
    expect(count('4 tabourets à entretenir')).toBe(4);
    expect(count('5 tabourets en service')).toBe(5);
  });

  it('le VOCABULAIRE RÉEL du parc corrobore ce que la seule phrase ne qualifiait pas', () => {
    expect(
      extractSpokenContractFacts('Crée le contrat « Entretien vitrines », 3 tabourets', TODAY, {
        parkVocabulary: ['Tabouret hall A', 'Tabouret quai 3'],
      }).equipmentCount,
    ).toBe(3);
  });

  it('le LIBELLÉ dit corrobore la reprise (« contrat fontaines RATP, 3 fontaines »)', () => {
    expect(
      extractSpokenContractFacts('Fais-moi le contrat fontaines RATP, 3 fontaines', TODAY)
        .equipmentCount,
    ).toBe(3);
  });

  it('un CADRE dit prime sur une simple reprise du libellé — c’est la preuve la plus forte', () => {
    expect(
      extractSpokenContractFacts(
        'Crée le contrat entretien 12 ascenseurs, ils ont 3 machines, 900 € par an',
        TODAY,
      ).equipmentCount,
    ).toBe(3);
  });

  it('un nombre qui appartient à un AUTRE fait lu n’est jamais un comptage d’équipements', () => {
    const facts = extractSpokenContractFacts(
      'Crée le contrat « Entretien vitrines » à 1 200 € par an, 2 visites par an, à partir du 01/10/2026',
      TODAY,
    );
    expect(facts.equipmentCount).toBeNull();
    expect(facts.annualAmountCents).toBe(120_000);
    expect(facts.visitsPerYear).toBe(2);
  });
});

describe('extractSpokenContractFacts — lecture en UNE passe de la consigne composite', () => {
  it('« fais-moi le contrat fontaines RATP, 3 fontaines, 1 200 € par an, ça démarre au 1er octobre, 2 passages »', () => {
    const facts = extractSpokenContractFacts(
      'Fais-moi le contrat « Fontaines RATP », 3 fontaines, 1 200 € par an, ça démarre au 1er octobre, 2 passages',
      TODAY,
    );
    expect(facts).toEqual({
      label: 'Fontaines RATP',
      annualAmountCents: 120_000,
      visitsPerYear: 2,
      tacitRenewal: null,
      startDate: '2026-10-01',
      equipmentCount: 3,
    });
  });

  it('la reconduction tacite n’est REFUSÉE que si elle est dite (sinon : non dit, jamais supposé)', () => {
    expect(
      extractSpokenContractFacts('Crée le contrat « X » sans reconduction tacite', TODAY).tacitRenewal,
    ).toBe(false);
    expect(extractSpokenContractFacts('Crée le contrat « X »', TODAY).tacitRenewal).toBeNull();
  });

  /**
   * Phrase CANONIQUE de la spec §2.7, dictée telle quelle. « 400 balles PAR MACHINE » est un
   * PRIX unitaire en argot ; le nombre de machines est « ils ont 3 machines ». Bob ÉNONCE ce
   * nombre au point de décision d'une mutation (« Tu as parlé de N machine(s) ») — la doctrine
   * interdit d'y énoncer un fait faux.
   */
  it('« 400 balles par machine, ils ont 3 machines » : 3 machines, jamais 400 (§2.7)', () => {
    const facts = extractSpokenContractFacts(
      'fais-moi le contrat fontaines RATP, 400 balles par machine, ils ont 3 machines à Bastille, ça démarre au 1er octobre, 2 passages',
      TODAY,
    );
    expect(facts.equipmentCount).toBe(3);
    expect(facts.label).toBe('Fontaines RATP');
    expect(facts.visitsPerYear).toBe(2);
    expect(facts.startDate).toBe('2026-10-01');
    // « balles » n'est pas une unité monétaire lisible : aucun montant inventé, Bob demandera.
    expect(facts.annualAmountCents).toBeNull();
  });

  it('l’argot monétaire ne compte jamais des machines, même seul dans la phrase', () => {
    expect(
      extractSpokenContractFacts('Crée le contrat « X », 400 balles par machine', TODAY)
        .equipmentCount,
    ).toBeNull();
    expect(
      extractSpokenContractFacts('Crée le contrat « X », 2000 boules par an', TODAY).equipmentCount,
    ).toBeNull();
  });

  it('les unités de la consigne ne comptent JAMAIS des équipements', () => {
    const facts = extractSpokenContractFacts(
      'Crée le contrat « Entretien vitrines » à 900 € par an, 2 visites par an, à partir du 01/10/2026',
      TODAY,
    );
    expect(facts.equipmentCount).toBeNull();
    expect(facts.visitsPerYear).toBe(2);
    expect(facts.annualAmountCents).toBe(90_000);
  });
});

/**
 * TRACE LÉGALE — le motif motive une décision qui ROMPT un engagement contractuel. Il n'est
 * donc retenu que s'il est RÉELLEMENT ÉNONCÉ : une phrase de COMMANDE n'est pas une
 * motivation, et Bob ne la maquille jamais en trace. Sans motif dit, `null` — l'agent pose la
 * question ciblée (branche « Pourquoi cette résiliation ? »), il n'invente rien.
 */
describe('extractSpokenTerminationNote — seul un motif ÉNONCÉ fait la trace', () => {
  it('un motif énoncé derrière son marqueur est lu tel quel', () => {
    expect(extractSpokenTerminationNote('Résilie le contrat — motif : le client déménage')).toBe(
      'le client déménage',
    );
    expect(extractSpokenTerminationNote('Résilie le contrat parce que le site ferme')).toBe(
      'le site ferme',
    );
    expect(extractSpokenTerminationNote('Résilie le contrat car le client ne paie plus')).toBe(
      'le client ne paie plus',
    );
    expect(extractSpokenTerminationNote('Résilie le contrat — raison : marché perdu')).toBe(
      'marché perdu',
    );
    // Marqueur ACCENTUÉ : il ne se dicte jamais sans son accent.
    expect(extractSpokenTerminationNote('Résilie le contrat à cause du chantier arrêté')).toBe(
      'chantier arrêté',
    );
  });

  it('AUCUN motif dit ⇒ null : la phrase de COMMANDE ne devient jamais la trace légale', () => {
    // Contre-preuve du finding : « Résilie le contrat Bastille » s'inscrivait tel quel en
    // terminationNote — l'ordre donné tenait lieu de motivation de la rupture.
    expect(extractSpokenTerminationNote('Résilie le contrat Bastille')).toBeNull();
    // Phrase CANONIQUE §2.7 — elle dit la date d'effet, pas le pourquoi : Bob demandera.
    expect(extractSpokenTerminationNote('Le client résilie au 1er juin')).toBeNull();
    // Le followUp que Bob REDIT sans motif ne doit pas non plus s'auto-tracer.
    expect(
      extractSpokenTerminationNote('Résilie le contrat contract-bastille au 01/06/2027'),
    ).toBeNull();
  });

  it('« car » NOM commun n’est jamais pris pour la conjonction (un motif inventé serait la trace)', () => {
    expect(extractSpokenTerminationNote('Résilie le contrat Carrefour Bastille')).toBeNull();
    // « le contrat car scolaire » : le geste nomme un contrat de transport, il ne motive rien.
    expect(extractSpokenTerminationNote('Résilie le contrat car scolaire')).toBeNull();
    expect(extractSpokenTerminationNote('Résilie le contrat car scolaire Bastille')).toBeNull();
    // La conjonction reste lue dès qu'une PROPOSITION la suit.
    expect(extractSpokenTerminationNote('Résilie le contrat car ils ont fermé le site')).toBe(
      'ils ont fermé le site',
    );
  });

  it('les caractères de CONTRÔLE sont neutralisés (le domaine les refuse)', () => {
    expect(sanitizeSpokenNote('le client\u0000 déménage')).toBe('le client déménage');
    expect(extractSpokenTerminationNote('Résilie — motif : le client\u0000 déménage')).toBe(
      'le client déménage',
    );
    expect(extractSpokenTerminationNote('a')).toBeNull();
  });
});
