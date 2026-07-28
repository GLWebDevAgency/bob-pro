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

  it('un nom de client contenant « car » n’est jamais pris pour un motif', () => {
    expect(extractSpokenTerminationNote('Résilie le contrat Carrefour Bastille')).toBeNull();
  });

  it('les caractères de CONTRÔLE sont neutralisés (le domaine les refuse)', () => {
    expect(sanitizeSpokenNote('le client\u0000 déménage')).toBe('le client déménage');
    expect(extractSpokenTerminationNote('Résilie — motif : le client\u0000 déménage')).toBe(
      'le client déménage',
    );
    expect(extractSpokenTerminationNote('a')).toBeNull();
  });
});
