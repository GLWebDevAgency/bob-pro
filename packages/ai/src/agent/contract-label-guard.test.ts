import { describe, expect, it } from 'vitest';
import {
  contractLabelRefusalSaid,
  inspectContractLabel,
  isContractLabelPrintable,
  type ContractLabelDoubt,
} from './contract-label-guard';

/**
 * §2.7 — GARDE FAIL-CLOSED du libellé de contrat, VERSION LISTE BLANCHE.
 *
 * CE QUE CE TEST VÉRIFIE, ET POURQUOI IL EST ÉCRIT AUTREMENT QU'AVANT : la garde d'hier
 * ÉNUMÉRAIT ce qui est interdit — donc elle avait les mêmes trous que l'extracteur qu'elle
 * devait couvrir, et une sixième lecture a prouvé bout-en-bout qu'elle laissait passer
 * « demain », « toutes les semaines », « sans reconduction tacite », « 30% à la commande »,
 * « Monsieur Dupont », « au tarif ». Un test qui n'aurait fait qu'allonger la liste des formes
 * refusées aurait reconduit la même illusion.
 *
 * On teste donc DEUX propriétés, et pas un catalogue :
 *   · la FERMETURE — hors de la forme sûre (mot, petit nombre, connecteur, lettre-désignation),
 *     TOUT refuse : les formes listées ci-dessous ne sont que des TÉMOINS de cette fermeture,
 *     pas la définition de la garde ;
 *   · le CONTREPOIDS — les noms que le métier dicte vraiment restent possibles, sinon la garde
 *     ne coûterait pas « une question », elle rendrait le geste vocal impraticable.
 *
 * L'ASYMÉTRIE EST LE SUJET : un faux positif coûte UNE question ; un faux négatif imprime un
 * montant, une date ou le nom d'un client sur la ligne d'une facture annuelle archivée immuable.
 */

/**
 * Les formes que la SIXIÈME lecture a vues passer à travers la garde-liste-noire, plus celles
 * des lectures précédentes. Aucune n'est « traitée » par une règle qui lui serait propre : elles
 * tombent toutes parce qu'un de leurs mots n'appartient à AUCUNE forme sûre.
 */
const FORMES_DES_REVUES: readonly { readonly label: string; readonly doubt: ContractLabelDoubt }[] =
  [
    // ── SIXIÈME LECTURE : les formes que la liste noire ne connaissait pas ────────────────
    // « demain » est la façon la plus COURANTE de dire une date.
    { label: 'Entretien vitrines demain', doubt: 'date' },
    { label: 'Entretien vitrines après-demain', doubt: 'date' },
    { label: 'Entretien vitrines lundi prochain', doubt: 'date' },
    // Le détecteur d'hier ne connaissait que le masculin « tous les » et « fois par ».
    { label: 'Entretien vitrines toutes les semaines', doubt: 'cadence' },
    { label: 'Entretien vitrines dans 3 mois', doubt: 'forme' },
    { label: 'Entretien vitrines sous huit jours', doubt: 'forme' },
    { label: 'Entretien vitrines d’ici la fin du mois', doubt: 'forme' },
    // Le SEUL fait qui était lu SANS empan — la clause restait collée au nom (cf. LIVRABLE 2).
    { label: 'Entretien vitrines sans reconduction tacite', doubt: 'clause' },
    // Taux et montants sous toutes leurs écritures.
    { label: 'Entretien vitrines 30% à la commande', doubt: 'montant' },
    { label: 'Entretien vitrines TVA 20%', doubt: 'montant' },
    { label: 'Entretien vitrines payable en 4 fois', doubt: 'montant' },
    { label: 'Entretien vitrines indexé sur l’indice BT01', doubt: 'forme' },
    // Civilité NUE — aucune préposition ne la précède, la liste noire ne la voyait pas.
    { label: 'Entretien vitrines Monsieur Dupont', doubt: 'attribution' },
    // ── LIVRABLE 3 : les libellés MUTILÉS par la découpe, hier ACCEPTÉS ───────────────────
    { label: 'Entretien vitrines au tarif', doubt: 'forme' },
    { label: 'Entretien vitrines effectif', doubt: 'date' },
    { label: 'Entretien vitrines destiné', doubt: 'attribution' },
    { label: 'Entretien vitrines à raison d’', doubt: 'coupe' },
    // ── LECTURES PRÉCÉDENTES : elles doivent rester fermées ───────────────────────────────
    { label: 'Entretien vitrines à 1.200 € par an', doubt: 'montant' },
    { label: 'Entretien vitrines à deux mille euros par an', doubt: 'montant' },
    { label: 'Entretien vitrines cinq cents euros', doubt: 'montant' },
    { label: 'Entretien vitrines 12 k€ par an', doubt: 'montant' },
    { label: 'Entretien vitrines 12 keuros', doubt: 'montant' },
    { label: 'Entretien vitrines 400 balles par machine', doubt: 'montant' },
    { label: 'Entretien vitrines 1.200 par an', doubt: 'nombre' },
    { label: 'Entretien vitrines 1200,50', doubt: 'nombre' },
    // Sommes que DEUX MOTS SÛRS forment à eux deux : séparateur de milliers par ESPACE, et
    // mot-nombre suivi d'une magnitude — sans marqueur monétaire, la somme s'imprimerait quand
    // même. « Les Mille Étangs » passe pourtant : aucun mot-nombre ne précède la magnitude.
    { label: 'Entretien vitrines 1 200', doubt: 'nombre' },
    { label: 'Entretien vitrines quinze mille', doubt: 'nombre' },
    { label: 'Entretien vitrines en janvier', doubt: 'date' },
    { label: 'Entretien vitrines à la rentrée', doubt: 'date' },
    { label: 'Entretien vitrines le 1er du mois prochain', doubt: 'date' },
    { label: 'Entretien vitrines mars 2027', doubt: 'date' },
    { label: 'Entretien vitrines à partir du 01/10/2026', doubt: 'date' },
    { label: 'Entretien vitrines pour le compte de RATP', doubt: 'attribution' },
    { label: 'Entretien vitrines au nom de Carrefour', doubt: 'attribution' },
    { label: 'Entretien vitrines de la part de Dupont', doubt: 'attribution' },
    { label: 'Entretien vitrines pour la SARL Dupont', doubt: 'forme' },
    { label: 'Entretien vitrines pour M. Dupont', doubt: 'attribution' },
    { label: 'Entretien vitrines chez Carrefour', doubt: 'client' },
    { label: 'Entretien vitrines visite bimestrielle', doubt: 'cadence' },
    { label: 'Entretien vitrines un passage par mois', doubt: 'cadence' },
    { label: 'Entretien vitrines deux interventions annuelles', doubt: 'cadence' },
    { label: 'Entretien vitrines trimestriel', doubt: 'cadence' },
    // Moignons laissés par une SUR-COUPE : jamais un nom mutilé sur une pièce.
    { label: 'Entretien vitrines pour', doubt: 'forme' },
    { label: 'Contrat de', doubt: 'coupe' },
    { label: 'de la', doubt: 'vide' },
    { label: 'X', doubt: 'vide' },
    { label: '   ', doubt: 'vide' },
    // Une PHRASE, même parfaitement formée, n'est pas un nom.
    { label: 'Entretien des vitrines et des sols du hall principal de la tour', doubt: 'longueur' },
  ];

/** Noms de contrat que le métier dicte VRAIMENT — la garde ne doit pas les rendre impossibles. */
const NOMS_LEGITIMES: readonly string[] = [
  'Entretien vitrines',
  'Entretien 12 ascenseurs',
  'Porte-à-faux quai 3',
  'Nettoyage à sec hall B',
  'Maintenance Eurotunnel Nord',
  'Dépannage fontaines Europe 2',
  'Entretien annuel',
  'Entretien 4 saisons',
  'Contrat Euro 2',
  'Fontaines RATP',
  'Visites de sécurité',
  // DÉSIGNATIONS de bâtiment : la lettre finale nomme, elle ne pend pas (voir le test dédié).
  'Fontaines quai A',
  'Entretien bloc D',
  'Contrat tour L',
  // Formes du français que la liste blanche doit laisser vivre : élision, mots composés, article
  // en tête. Une garde a le droit de poser une question de trop ; jamais celui d'interdire un nom.
  'Entretien l’Eurotunnel',
  'Contrat après-vente',
  'Entretien sous-sol',
  'Entretien Champ-de-Mars',
  'Les Mille Étangs',
  'Contrat toutes zones',
];

/**
 * Ce qu'un nom de contrat PEUT contenir — la liste blanche, réénoncée ICI comme une PROPRIÉTÉ
 * lisible : un mot alphabétique, une lettre majuscule de désignation, un petit nombre, ou l'un
 * des douze connecteurs. C'est FINI, donc vérifiable ; l'ensemble des tournures françaises
 * interdites, lui, ne l'est pas — c'est tout le sujet de cette passe.
 */
const CONNECTEURS = new Set(['de', 'du', 'des', 'à', 'la', 'le', 'les', 'et', 'sur', 'en', 'l’', 'd’']);
const MOT_OU_NOMBRE = /^(?:\p{L}[\p{L}'’-]*\p{L}|\p{Lu}|\d{1,3})$/u;
const formeSure = (mot: string): boolean =>
  CONNECTEURS.has(mot.toLowerCase()) || MOT_OU_NOMBRE.test(mot);

describe('garde liste blanche — la fermeture, pas le catalogue', () => {
  it('les TÉMOINS des six lectures refusent TOUS, et le doute est NOMMÉ (échecs énumérés)', () => {
    const failures = FORMES_DES_REVUES.filter((cas) => {
      const verdict = inspectContractLabel(cas.label, { customerNames: ['RATP', 'Carrefour'] });
      return verdict.accepted || !verdict.doubts.includes(cas.doubt);
    }).map((cas) => {
      const verdict = inspectContractLabel(cas.label, { customerNames: ['RATP', 'Carrefour'] });
      return `• « ${cas.label} » attendu ${cas.doubt}, obtenu [${verdict.doubts.join(', ')}]${
        verdict.accepted ? ' — ACCEPTÉ' : ''
      }`;
    });
    expect(failures.join('\n'), `${failures.length} forme(s) passée(s) au travers`).toBe('');
  });

  /**
   * LA PROPRIÉTÉ, pas l'exemple. Elle est le cœur de l'inversion : quel que soit le libellé, s'il
   * porte UN SEUL mot hors de la forme sûre, il est refusé. Aucun ajout futur de motif ne peut
   * l'affaiblir, et aucune tournure « pas encore listée » ne peut lui échapper — c'est ce qu'une
   * liste noire ne pouvait pas promettre.
   */
  it('FERMETURE : un libellé dont UN mot sort de la forme sûre est refusé, TOUJOURS', () => {
    // (a) HORS FORME — ni mot, ni petit nombre, ni lettre de désignation : rien de tout cela ne
    //     peut nommer une prestation, et aucune règle particulière n'a eu besoin de les prévoir.
    const horsForme = ['1er', 'BT01', '24/7', '1.200', '1200,50', '2027', '30%', '€', '12k€', 'n°3'];
    expect(horsForme.filter(formeSure).join(' | '), 'témoins mal choisis (a)').toBe('');
    // (b) MOTS DE PHRASE — alphabétiques, donc conformes à la FORME, mais membres de la classe
    //     grammaticale FERMÉE du français : leur présence prouve un morceau de phrase. Plus les
    //     connecteurs laissés en DERNIÈRE position, cicatrice d'une découpe.
    const motsDePhrase = ['au', 'pour', 'sans', 'dans', 'chez', 'ici', 'qu’on', 'd', 'l', 'à'];
    const passants = [...horsForme, ...motsDePhrase].filter((mot) =>
      // Chaque intrus est glissé dans un nom PARFAITEMENT légitime : seul l'intrus peut refuser.
      inspectContractLabel(`Entretien vitrines ${mot}`, { mode: 'nomme' }).accepted,
    );
    expect(passants.join(' | '), 'intrus pourtant acceptés').toBe('');
    // …et le revers : tout mot de la forme sûre traverse, sans qu'aucune liste ne le nomme.
    const surs = ['fontaines', 'Eurotunnel', 'porte-à-faux', 'l’Eurotunnel', '3', '12', 'A', 'de'];
    expect(surs.filter((mot) => !formeSure(mot)).join(' | '), 'témoins mal choisis (c)').toBe('');
    const refuses = surs.filter(
      (mot) => !isContractLabelPrintable(`Entretien vitrines ${mot} nord`, { mode: 'nomme' }),
    );
    expect(refuses.join(' | '), 'mots de la forme sûre pourtant refusés').toBe('');
  });

  it('laisse vivre les vrais noms de contrat dès que le pro les a NOMMÉS (jamais un cul-de-sac)', () => {
    const refused = NOMS_LEGITIMES.filter(
      (label) => !isContractLabelPrintable(label, { mode: 'nomme' }),
    );
    expect(refused.join(' | '), 'noms légitimes refusés même après avoir été nommés').toBe('');
    // Et chacun de leurs mots est bien une forme sûre — la garde ne les accepte pas par accident.
    for (const label of NOMS_LEGITIMES) {
      for (const mot of label.split(/\s+/u)) {
        expect(formeSure(mot), `« ${mot} » (${label}) hors forme sûre`).toBe(true);
      }
    }
  });

  it('le REFUS explique ce qui pose problème et CITE le fragment fautif, jamais un code', () => {
    const verdict = inspectContractLabel('Entretien vitrines à 1.200 € par an');
    expect(verdict.accepted).toBe(false);
    const said = contractLabelRefusalSaid(verdict);
    expect(said).toContain('montant');
    expect(said).toContain('facture');
    expect(said).not.toMatch(/[A-Z]{3,}_[A-Z]/); // aucun code technique
    expect(verdict.fragment).not.toBeNull();
    expect('Entretien vitrines à 1.200 € par an').toContain(verdict.fragment!);
  });
});

describe('garde liste blanche — deux sévérités, une seule règle : le doute devient une question', () => {
  it('en mode « extrait », TOUT doute refuse (Bob a déduit le nom, il a pu se tromper)', () => {
    for (const label of ['Entretien annuel', 'Visites de sécurité', 'Contrat toutes zones']) {
      const verdict = inspectContractLabel(label);
      expect(verdict.accepted, `« ${label} » aurait dû être refusé en mode extrait`).toBe(false);
    }
  });

  /**
   * SUR-REFUS CORRIGÉ — « saisons » n'est pas un mot de calendrier : il ne DATE rien, il NOMME.
   * L'ancienne garde le refusait par sa liste noire de repères de calendrier, et un test l'avait
   * figé. Un contrat « 4 saisons » est pourtant l'un des noms les plus courants du métier : la
   * garde le laisse passer DANS LES DEUX MODES, y compris quand Bob l'a seulement déduit.
   */
  it('« Contrat 4 saisons » PASSE — même déduit : un nom n’est pas une date', () => {
    for (const label of ['Contrat 4 saisons', 'Entretien 4 saisons', 'Entretien saisonnier']) {
      expect(inspectContractLabel(label).accepted, `« ${label} » refusé à tort`).toBe(true);
    }
  });

  it('en mode « nommé », le libellé REPASSE PAR LA FORME — aucun montant, aucune date n’entre', () => {
    // Accepté : des mots qu'un nom de contrat porte légitimement.
    expect(isContractLabelPrintable('Entretien annuel', { mode: 'nomme' })).toBe(true);
    // Refusé quand même : une somme, une date, une attribution, un morceau de phrase.
    for (const label of [
      'Entretien vitrines à 1 200 €',
      'Entretien vitrines cinq cents euros',
      'Entretien vitrines le 1er octobre',
      'Entretien vitrines demain',
      'Entretien vitrines pour le compte de RATP',
      'Entretien vitrines Monsieur Dupont',
      'Entretien vitrines au tarif',
      'de la',
    ]) {
      expect(
        isContractLabelPrintable(label, { mode: 'nomme' }),
        `« ${label} » aurait dû être refusé même nommé`,
      ).toBe(false);
    }
  });

  it('CONVERGENCE : ce que le pro redit après le refus est accepté au tour suivant', () => {
    const dicte = 'Fontaines RATP';
    // Tour 1 — Bob a DÉDUIT ce nom : le jeton du client refuse (le fichier le dit client).
    const premier = inspectContractLabel(dicte, { customerNames: ['RATP'] });
    expect(premier.accepted).toBe(false);
    expect(premier.doubts).toContain('client');
    // Tour 2 — le pro NOMME explicitement le contrat : le même nom passe, la boucle se ferme.
    const second = inspectContractLabel(dicte, { customerNames: ['RATP'], mode: 'nomme' });
    expect(second.accepted).toBe(true);
    // …mais un montant glissé PAR INADVERTANCE dans la réponse refuse encore.
    const troisieme = inspectContractLabel('Fontaines RATP 1 200 €', {
      customerNames: ['RATP'],
      mode: 'nomme',
    });
    expect(troisieme.accepted).toBe(false);
    expect(contractLabelRefusalSaid(troisieme)).toContain('montant');
  });

  /**
   * LIVRABLE 3 — MUTILATION. Un libellé que la découpe a tronqué s'imprimerait TEL QUEL sur la
   * ligne de la facture annuelle : ni vide, ni moignon reconnaissable, juste faux. La liste
   * blanche le refuse par construction — « au » est un mot de phrase, « d’ » un connecteur en
   * dernière position, « effectif » et « destiné » appartiennent au lexique fermé.
   */
  it('MUTILATION : les quatre queues coupées refusent, dans les DEUX modes', () => {
    const mutilés = [
      'Entretien vitrines au tarif',
      'Entretien vitrines effectif',
      'Entretien vitrines destiné',
      'Entretien vitrines à raison d’',
      "Entretien vitrines à raison d'", // apostrophe droite ET typographique
    ];
    for (const label of mutilés) {
      expect(isContractLabelPrintable(label), `« ${label} » accepté en extrait`).toBe(false);
      expect(
        isContractLabelPrintable(label, { mode: 'nomme' }),
        `« ${label} » accepté une fois nommé`,
      ).toBe(false);
    }
  });

  it('une DÉSIGNATION de bâtiment finale n’est pas un moignon — sinon le geste serait impossible', () => {
    // Prendre « quai A » pour une préposition orpheline ne coûterait pas une question de plus,
    // cela ferait un CUL-DE-SAC — le pro redirait le même nom, la garde le refuserait encore,
    // et ce contrat ne naîtrait jamais à la voix.
    for (const label of ['Fontaines quai A', 'Entretien bloc D', 'Contrat tour L']) {
      const verdict = inspectContractLabel(label);
      expect(verdict.accepted, `« ${label} » refusé : ${verdict.blocking.join(', ')}`).toBe(true);
      expect(isContractLabelPrintable(label, { mode: 'nomme' })).toBe(true);
    }
    // …mais la MINUSCULE trahit bien la préposition ou l'élision orpheline laissée par une coupe.
    for (const moignon of ['Entretien vitrines à', 'Entretien vitrines d', 'Entretien vitrines l']) {
      expect(
        isContractLabelPrintable(moignon, { mode: 'nomme' }),
        `« ${moignon} » aurait dû être refusé`,
      ).toBe(false);
    }
  });

  it('le nom d’un CLIENT n’est un doute que si l’hôte a dit que c’en est un', () => {
    expect(inspectContractLabel('Fontaines RATP').accepted).toBe(true);
    expect(inspectContractLabel('Fontaines RATP', { customerNames: ['RATP'] }).accepted).toBe(false);
    // Comparaison par JETON radicalisé : « Ste » ne reconnaît pas « Stéphanie »…
    expect(
      inspectContractLabel('Entretien Stéphanie', { customerNames: ['Ste Girard'] }).accepted,
    ).toBe(true);
    // …et une forme sociale seule ne désigne aucun client (« SARL » ne nomme rien).
    expect(
      inspectContractLabel('Entretien vitrines', { customerNames: ['SARL Entreprise'] }).accepted,
    ).toBe(true);
    // Le singulier du libellé reconnaît le pluriel du fichier (radical commun).
    expect(
      inspectContractLabel('Entretien fontaine', { customerNames: ['Fontaines de Paris'] }).accepted,
    ).toBe(false);
  });
});

describe('garde liste blanche — module PUR : même entrée, même verdict, toujours', () => {
  it('deux inspections successives du même libellé rendent le MÊME verdict (aucun état retenu)', () => {
    // Le piège classique d'un détecteur : une expression régulière globale garde son `lastIndex`
    // entre deux appels et laisse passer une phrase sur deux — en silence.
    const label = 'Entretien vitrines à 1.200 € par an, à partir du 01/10/2026, 2 visites';
    const premier = inspectContractLabel(label, { customerNames: ['RATP'] });
    const second = inspectContractLabel(label, { customerNames: ['RATP'] });
    expect(second).toEqual(premier);
    for (let index = 0; index < 5; index += 1) {
      expect(inspectContractLabel(label).accepted).toBe(false);
    }
  });

  it('ne MUTE ni ne CORRIGE jamais : elle constate, l’appelant pose la question', () => {
    const verdict = inspectContractLabel('Entretien vitrines à 1 200 €');
    // Le verdict ne porte AUCUN libellé « nettoyé » : couper mutilerait un nom réellement dicté.
    expect(Object.keys(verdict).sort()).toEqual(['accepted', 'blocking', 'doubts', 'fragment']);
    expect(verdict.blocking.every((doubt) => verdict.doubts.includes(doubt))).toBe(true);
  });

  it('un libellé absent est un doute comme un autre — jamais une exception, jamais un nom vide', () => {
    for (const value of [null, undefined, '', '  ']) {
      const verdict = inspectContractLabel(value);
      expect(verdict.accepted).toBe(false);
      expect(verdict.doubts).toContain('vide');
      expect(contractLabelRefusalSaid(verdict)).toContain('trop court');
    }
  });
});
