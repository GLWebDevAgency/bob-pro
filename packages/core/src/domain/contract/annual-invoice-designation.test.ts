import { describe, expect, it } from 'vitest';
import {
  CONTRACT_INVOICE_DESIGNATION_NATURE,
  annualInvoiceLineInputs,
  composeAnnualInvoiceDesignation,
  contractMentionSaid,
  isAnnualInvoiceDesignation,
  printableContractName,
  reperiodAnnualInvoiceDesignation,
} from './annual-invoice-designation';
import { type MaintenanceContractLine } from './maintenance-contract';

const PERIODE = { start: '2026-10-12', end: '2027-10-11' } as const;
const PERIODE_DITE = 'période du 12/10/2026 au 11/10/2027';

/**
 * CE QUE CE FICHIER PROUVE — et pourquoi il remplace la poursuite d'un extracteur parfait.
 *
 * On ne cherche plus à garantir qu'aucun fait dit ne pollue le nom du contrat : c'est
 * impossible sans un dictionnaire du français, et un tel dictionnaire refuserait les noms
 * propres des clients. On garantit autre chose, de vérifiable : que ce qui S'IMPRIME est
 * COMPOSÉ à partir de faits déjà validés, et que le texte venu de la parole ne peut y entrer
 * que filtré — ou pas du tout.
 */
describe('désignation de la facture annuelle — composée, jamais reprise', () => {
  it('sans nom exploitable : la désignation dit la NATURE et la PÉRIODE, et se suffit', () => {
    expect(composeAnnualInvoiceDesignation({ servicePeriod: PERIODE })).toBe(
      `Contrat de maintenance — ${PERIODE_DITE}`,
    );
    // Un nom entièrement pollué ne laisse RIEN : la pièce reste complète et honnête.
    expect(
      composeAnnualInvoiceDesignation({
        servicePeriod: PERIODE,
        contractName: 'à 1 200 € par an à partir du 01/10/2026',
      }),
    ).toBe(`Contrat de maintenance — ${PERIODE_DITE}`);
  });

  it('avec un nom sûr : il est CONSERVÉ intact, entre la nature et la période', () => {
    expect(
      composeAnnualInvoiceDesignation({
        servicePeriod: PERIODE,
        contractName: 'Entretien 12 ascenseurs',
      }),
    ).toBe(`Contrat de maintenance — Entretien 12 ascenseurs — ${PERIODE_DITE}`);
  });

  /**
   * LE CŒUR. Ce sont les formes exactes que six revues successives ont laissées passer : le
   * montant collé, la date, la civilité, la queue mutilée, la partie entière d'un taux coupée sur
   * la virgule. Aucun de ces FAITS ne s'imprime plus — non parce qu'on a su les reconnaître, mais
   * parce que ce qui s'imprime n'est plus ce qui a été dit.
   *
   * Ce que le tableau montre AUSSI, sans le farder : le filtre s'arrête au premier mot douteux,
   * il ne recolle pas la suite. Il en reste donc parfois un début un peu long (« … à partir »,
   * « … payé trimestriellement ») — un morceau LITTÉRAL de ce que le pro a dit, incomplet mais
   * jamais faux, et corrigeable d'un tap sur la fiche. C'est le prix assumé de ne jamais
   * fabriquer une adjacence : « pour Monsieur Dupont » ne devient pas « … Dupont ».
   */
  it('les pathologies des revues : le FAIT dit est jeté, ce qui reste est un début littéral', () => {
    const cas: readonly { dit: string; imprime: string | null }[] = [
      { dit: 'Entretien vitrines à 1 200 € par an', imprime: 'Entretien vitrines' },
      { dit: 'Entretien vitrines à partir du 01/10/2026', imprime: 'Entretien vitrines à partir' },
      { dit: 'Entretien vitrines pour Monsieur Dupont', imprime: 'Entretien vitrines' },
      { dit: 'Entretien vitrines majoré de 2,5 points', imprime: 'Entretien vitrines majoré' },
      { dit: 'Entretien vitrines toutes les semaines', imprime: 'Entretien vitrines' },
      { dit: 'Entretien vitrines à raison d’', imprime: 'Entretien vitrines à raison' },
      { dit: 'Entretien vitrines sans reconduction tacite', imprime: 'Entretien vitrines' },
      { dit: 'Entretien vitrines 30% à la commande', imprime: 'Entretien vitrines' },
      {
        dit: 'Entretien vitrines payé trimestriellement',
        imprime: 'Entretien vitrines payé trimestriellement',
      },
      // Le recollage aurait INVERSÉ le sens ; l'arrêt le laisse simplement incomplet.
      { dit: 'Entretien vitrines non compris', imprime: 'Entretien vitrines' },
    ];
    const fautes = cas
      .filter((c) => printableContractName(c.dit) !== c.imprime)
      .map(
        (c) =>
          `• « ${c.dit} » → « ${String(printableContractName(c.dit))} » (attendu « ${String(c.imprime)} »)`,
      );
    expect(fautes.join('\n'), `${fautes.length} nom(s) filtré(s) autrement qu’attendu`).toBe('');
    for (const c of cas) {
      const designation = composeAnnualInvoiceDesignation({
        servicePeriod: PERIODE,
        contractName: c.dit,
      });
      // AUCUN fait dit ne survit : ni date, ni symbole, ni somme, ni tiers, ni taux, ni clause.
      // On vérifie la désignation ENTIÈRE amputée de son segment de période — celui-là est
      // composé par le domaine, ses deux dates sont précisément ce qu'on veut y voir.
      const horsPeriode = designation.replace(` — ${PERIODE_DITE}`, '');
      expect(horsPeriode, c.dit).not.toMatch(/\d{2}\/\d{2}\/\d{4}/u);
      expect(horsPeriode, c.dit).not.toMatch(/[€%]/u);
      expect(horsPeriode, c.dit).not.toMatch(/1\s?200|Dupont|Monsieur|semaines|tacite|2,5/u);
      expect(designation.endsWith(` — ${PERIODE_DITE}`), c.dit).toBe(true);
      // …et ce qui reste est un PRÉFIXE littéral du nom dit — jamais un recollage.
      const nom = printableContractName(c.dit);
      if (nom !== null) {
        const debut = c.dit.split(/\s+/u).slice(0, nom.split(' ').length).join(' ');
        expect(nom.toLowerCase(), c.dit).toBe(debut.toLowerCase());
      }
    }
  });

  it('un nom qui n’est qu’un moignon ou une PHRASE est OMIS, jamais mutilé sur la pièce', () => {
    expect(printableContractName('de la')).toBeNull();
    expect(printableContractName('12')).toBeNull();
    expect(printableContractName('   ')).toBeNull();
    expect(printableContractName(null)).toBeNull();
    expect(
      printableContractName(
        'Entretien des vitrines et des sols du hall principal de la tour et des sous-sols',
      ),
    ).toBeNull();
  });

  it('le FILTRE est IDEMPOTENT — c’est ce qui rend la désignation relisible', () => {
    const noms = [
      'Entretien vitrines',
      'Porte-à-faux quai 3',
      'Entretien l’Eurotunnel',
      'Les Mille Étangs',
      'Nettoyage à sec hall B',
      'Entretien vitrines à 1 200 € par an demain',
    ];
    for (const nom of noms) {
      const filtre = printableContractName(nom);
      expect(printableContractName(filtre), nom).toBe(filtre);
    }
  });

  it('RECONNAISSANCE = inverse exact de la composition (la garde structurelle)', () => {
    for (const nom of [null, 'Entretien vitrines', 'Contrat 4 saisons', 'Fontaines quai A']) {
      const designation = composeAnnualInvoiceDesignation({
        servicePeriod: PERIODE,
        ...(nom !== null ? { contractName: nom } : {}),
      });
      expect(isAnnualInvoiceDesignation(designation, PERIODE), designation).toBe(true);
    }
    // Un libellé LIBRE, même plausible, n'est pas une désignation.
    expect(isAnnualInvoiceDesignation('Forfait annuel', PERIODE)).toBe(false);
    expect(isAnnualInvoiceDesignation('Entretien vitrines', PERIODE)).toBe(false);
    // La bonne forme mais une AUTRE période : refusée (la pièce dirait une couverture fausse).
    expect(
      isAnnualInvoiceDesignation(`Contrat de maintenance — ${PERIODE_DITE}`, {
        start: '2027-10-12',
        end: '2028-10-11',
      }),
    ).toBe(false);
    // Un nom NON filtré glissé dans le segment du milieu : refusé — c'est exactement la
    // tentative de contournement que la garde existe pour arrêter.
    expect(
      isAnnualInvoiceDesignation(
        `Contrat de maintenance — Entretien vitrines 1 200 € — ${PERIODE_DITE}`,
        PERIODE,
      ),
    ).toBe(false);
    expect(
      isAnnualInvoiceDesignation(
        `Contrat de maintenance — Entretien vitrines demain — ${PERIODE_DITE}`,
        PERIODE,
      ),
    ).toBe(false);
    // La nature ne se réécrit pas non plus.
    expect(isAnnualInvoiceDesignation(`Prestation — ${PERIODE_DITE}`, PERIODE)).toBe(false);
    expect(CONTRACT_INVOICE_DESIGNATION_NATURE).toBe('Contrat de maintenance');
  });

  it('REPORT de période : la désignation suit la période éditée, le nom survit', () => {
    const initiale = composeAnnualInvoiceDesignation({
      servicePeriod: PERIODE,
      contractName: 'Entretien vitrines',
    });
    const suivante = { start: '2026-11-01', end: '2027-10-31' } as const;
    const reporte = reperiodAnnualInvoiceDesignation(initiale, suivante);
    expect(reporte).toBe('Contrat de maintenance — Entretien vitrines — période du 01/11/2026 au 31/10/2027');
    expect(isAnnualInvoiceDesignation(reporte, suivante)).toBe(true);
    // Un libellé qui n'est PAS une désignation revient intact (pièces composées avant la règle).
    expect(reperiodAnnualInvoiceDesignation('Forfait annuel', suivante)).toBe('Forfait annuel');
  });

  it('projection des lignes : montants au centime, désignation recomposée par ligne', () => {
    const lines: MaintenanceContractLine[] = [
      {
        id: 'l1',
        catalogueItemId: null,
        label: 'Entretien fontaines à 1 200 € par an',
        quantity: 1,
        unitPriceHtCents: 120_000,
        vatRate: 20,
        position: 0,
      },
      {
        id: 'l2',
        catalogueItemId: null,
        label: 'demain',
        quantity: 2,
        unitPriceHtCents: 5_000,
        vatRate: 10,
        position: 1,
      },
    ];
    const projetees = annualInvoiceLineInputs(lines, {
      servicePeriod: PERIODE,
      contractLabel: 'Entretien fontaines RATP',
    });
    expect(projetees).toEqual([
      {
        label: `Contrat de maintenance — Entretien fontaines — ${PERIODE_DITE}`,
        category: 'subscription',
        qty: 1,
        unitPriceHT: 120_000,
        vatRate: 20,
      },
      {
        // La ligne ne laisse rien : on retombe sur le nom du CONTRAT, filtré lui aussi.
        label: `Contrat de maintenance — Entretien fontaines RATP — ${PERIODE_DITE}`,
        category: 'subscription',
        qty: 2,
        unitPriceHT: 5_000,
        vatRate: 10,
      },
    ]);
    for (const ligne of projetees) {
      expect(isAnnualInvoiceDesignation(ligne.label, PERIODE), ligne.label).toBe(true);
    }
  });

  /**
   * LE COÛT, CHIFFRÉ ET ASSUMÉ. Le corpus de contrôle est celui des noms que le métier dicte
   * VRAIMENT (`contract-label-guard.test.ts`, plus « Entretien hall A » du corpus combinatoire).
   * La garde n'en refuse AUCUN dès que le pro les a nommés — zéro sur-refus, avant comme après.
   * Le filtre d'IMPRESSION, lui, est plus sévère que la garde, et c'est voulu : il ne garde que
   * les mots que la forme sûre déclare SÛRS, donc il raccourcit quatre de ces vingt et un noms
   * (« annuel », « toutes », « Visites », « Euro » appartiennent au lexique fermé). Ce que la
   * pièce y perd est de la PRÉCISION ; ce qu'elle n'y risque plus, c'est le FAUX — et la fiche,
   * elle, garde le nom entier. Ce test fige le chiffre pour qu'aucune passe ne l'aggrave en
   * silence.
   */
  it('COÛT mesuré du filtre d’impression : 17 des 21 noms de contrôle passent intacts', () => {
    const CONTROLE: readonly string[] = [
      'Entretien vitrines', 'Entretien 12 ascenseurs', 'Porte-à-faux quai 3',
      'Nettoyage à sec hall B', 'Maintenance Eurotunnel Nord', 'Dépannage fontaines Europe 2',
      'Entretien annuel', 'Entretien 4 saisons', 'Contrat Euro 2', 'Fontaines RATP',
      'Visites de sécurité', 'Fontaines quai A', 'Entretien bloc D', 'Contrat tour L',
      'Entretien l’Eurotunnel', 'Contrat après-vente', 'Entretien sous-sol',
      'Entretien Champ-de-Mars', 'Les Mille Étangs', 'Contrat toutes zones', 'Entretien hall A',
    ];
    const alteres = CONTROLE.filter((nom) => printableContractName(nom) !== nom);
    expect(
      alteres.map((nom) => `• « ${nom} » → « ${String(printableContractName(nom))} »`).join('\n'),
    ).toBe(
      [
        '• « Entretien annuel » → « Entretien »',
        '• « Contrat Euro 2 » → « Contrat »',
        '• « Visites de sécurité » → « null »',
        '• « Contrat toutes zones » → « Contrat »',
      ].join('\n'),
    );
    expect(CONTROLE.length - alteres.length).toBe(17);
    // Et ce qui est raccourci reste VRAI : toujours un début littéral du nom, jamais autre chose.
    for (const nom of CONTROLE) {
      const filtre = printableContractName(nom);
      if (filtre === null) continue;
      expect(nom.toLowerCase().startsWith(filtre.toLowerCase()), nom).toBe(true);
    }
  });

  /**
   * LIVRABLE 2 — la MÊME règle pour toute mention persistée. Un rappel de renouvellement est
   * archivé en file de notification puis envoyé : c'est un texte qui SORT et qui RESTE. Le nom
   * n'y entre donc que filtré, et à défaut le contrat est identifié par son anniversaire.
   */
  it('mention persistée hors facture : nom filtré et cité, sinon l’ANNIVERSAIRE identifie', () => {
    expect(
      contractMentionSaid({ contractName: 'Entretien vitrines', anniversary: '2026-10-12' }),
    ).toBe('« Entretien vitrines »');
    expect(
      contractMentionSaid({ contractName: 'Entretien vitrines à 1 200 € par an', anniversary: '2026-10-12' }),
    ).toBe('« Entretien vitrines »');
    // Rien d'exploitable : le contrat reste identifiable par un fait DÉJÀ validé.
    expect(contractMentionSaid({ contractName: 'à 1 200 € par an', anniversary: '2026-10-12' })).toBe(
      'de maintenance du 12/10/2026',
    );
    expect(contractMentionSaid({ contractName: null, anniversary: '2026-10-12' })).toBe(
      'de maintenance du 12/10/2026',
    );
    // Les deux tournures du rappel restent lisibles dans les deux cas.
    for (const nom of ['Entretien vitrines', 'demain 1 200 €']) {
      const mention = contractMentionSaid({ contractName: nom, anniversary: '2026-10-12' });
      expect(`Contrat ${mention} — se reconduit dans 60 jours`).not.toMatch(/1\s?200|€|demain/u);
      expect(`Le contrat ${mention} se reconduit tacitement`).not.toMatch(/1\s?200|€|demain/u);
    }
  });

  /**
   * L'HONNÊTETÉ DE CE QU'ON NE SAIT PAS FAIRE. Un patronyme nu passe la forme sûre — aucune
   * règle de forme ne distingue « Dupont » de « Fontaines », et vouloir les distinguer
   * refuserait les noms de clients. Ce test ÉNONCE la limite au lieu de la taire : elle est
   * désormais sans conséquence légale, parce que la NATURE et la PÉRIODE de la pièce, elles,
   * ne viennent jamais de la parole.
   */
  it('la limite RESTE nommée : un patronyme nu survit au filtre — sans conséquence sur la pièce', () => {
    const designation = composeAnnualInvoiceDesignation({
      servicePeriod: PERIODE,
      contractName: 'Entretien vitrines Dupont',
    });
    expect(designation).toBe(`Contrat de maintenance — Entretien vitrines Dupont — ${PERIODE_DITE}`);
    // Ce qui compte : la nature et la période restent celles du domaine, exactes et vérifiables.
    expect(designation.startsWith('Contrat de maintenance — ')).toBe(true);
    expect(designation.endsWith(` — ${PERIODE_DITE}`)).toBe(true);
  });
});
