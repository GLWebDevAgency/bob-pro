import { describe, it, expect } from 'vitest';
import {
  buildMentions,
  operationNatureOf,
  CIBS_TVA_ENTREE_EN_VIGUEUR,
  CIBS_TOLERANCE_REFERENCES_CGI,
  MENTION_FRANCHISE_BASE,
  MENTION_OPTION_DEBITS,
  REDACTIONS_FRANCHISE,
  type BuildMentionsInput,
} from './build-mentions';
import { Company, type CompanyProps } from '../company/company';
import { Customer, type CustomerProps } from '../customer/customer';
import { formatEUR } from '../../format/money';

const baseCompany: CompanyProps = {
  id: 'c1',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  address: { line1: '1 rue X', zip: '92000', city: 'Nanterre' },
  rcsOrRm: 'RM 92',
  tvaIntracom: 'FR44732829320',
  decennale: { insurer: 'AXA', policyNo: 'P123', coverage: 'France', expiresAt: '2027-12-31' },
};
const baseCustomer: CustomerProps = {
  id: 'k1',
  companyId: 'c1',
  type: 'b2c',
  name: 'Martin',
  address: { line1: 'x', zip: '75001', city: 'Paris' },
};

const company = (over: Partial<CompanyProps> = {}): Company => {
  const r = Company.of({ ...baseCompany, ...over });
  if (!r.ok) throw new Error('company de test invalide');
  return r.value;
};
const customer = (over: Partial<CustomerProps> = {}): Customer => {
  const r = Customer.of({ ...baseCustomer, ...over });
  if (!r.ok) throw new Error('customer de test invalide');
  return r.value;
};
const b2b = () => customer({ type: 'b2b', siren: '552081317' });
const b2g = () => customer({ type: 'b2g', siren: '130025265' });

const mentions = (over: Partial<BuildMentionsInput> = {}): string[] =>
  buildMentions({ company: company(), customer: customer(), kind: 'invoice', asOf: '2026-06-01', ...over });

describe('buildMentions', () => {
  it('inclut le RM et l’en-tête société', () => {
    const m = mentions();
    expect(m.some((s) => s.includes('RM 92'))).toBe(true);
    expect(m.some((s) => s.includes('Mercier Plomberie'))).toBe(true);
  });
  it('franchise => mention 293 B', () => {
    const m = mentions({ company: company({ vatRegime: 'franchise' }) });
    expect(m.some((s) => s.includes('293 B'))).toBe(true);
  });
  it('BTP => assurance decennale presente', () => {
    expect(mentions().some((s) => s.includes('Assurance'))).toBe(true);
  });
  it('devis => Bon pour accord', () => {
    const m = mentions({ kind: 'quote', validUntilDays: 30 });
    expect(m.some((s) => s.toLowerCase().includes('bon pour accord'))).toBe(true);
  });

  // —— A4 : mention « Autoliquidation » (art. 242 nonies A, I-13° annexe II CGI ; fondement
  // art. 283, 2 nonies CGI) — le pendant PDF de la catégorie AE du XML Factur-X. ——
  it('A4 — sous-traitance BTP b2b : mention « Autoliquidation » avec l’art. 283-2 nonies', () => {
    const m = mentions({ customer: customer({ type: 'b2b', siren: '552081317', isSubcontractingBtp: true }) });
    const mention = m.find((s) => s.includes('Autoliquidation'));
    expect(mention).toBe('Autoliquidation de la TVA (sous-traitance BTP, art. 283-2 nonies du CGI)');
  });
  it('A4 — client b2b NON sous-traitant ou b2c : jamais de mention d’autoliquidation', () => {
    expect(mentions({ customer: b2b() }).some((s) => s.includes('Autoliquidation'))).toBe(false);
    expect(mentions().some((s) => s.includes('Autoliquidation'))).toBe(false);
  });
  it('A4 — FRANCHISE EN BASE + sous-traitance BTP : la franchise PRIME (BOI-TVA-DECLA-10-10-20) — mention 293 B seule, JAMAIS les deux mentions contradictoires', () => {
    const m = mentions({
      company: company({ vatRegime: 'franchise' }),
      customer: customer({ type: 'b2b', siren: '552081317', isSubcontractingBtp: true }),
    });
    expect(m.some((s) => s.includes('293 B'))).toBe(true);
    expect(m.some((s) => s.includes('Autoliquidation'))).toBe(false);
  });

  // —— P14 (C-EXP1) : mentions L441-9/L441-10 réservées aux ventes entre PROFESSIONNELS ——
  it('B2B : escompte néant (L441-9) + pénalités BCE + 10 points (L441-10, jamais de taux chiffré) + 40 € (D441-5)', () => {
    const m = mentions({ customer: b2b() });
    expect(m.some((s) => s === 'Escompte pour paiement anticipé : néant.')).toBe(true);
    const penalites = m.find((s) => s.includes('Pénalités de retard'));
    expect(penalites).toBe(
      'Pénalités de retard : taux BCE + 10 points (art. L441-10 du code de commerce). Indemnité forfaitaire de recouvrement : 40 € (art. D441-5 du code de commerce).',
    );
    // Plancher L441-10 II : la stipulation « taux légal en vigueur » (irrégulière) a disparu,
    // et aucun taux chiffré n'est écrit en dur (il change chaque semestre).
    expect(m.some((s) => s.includes('taux legal en vigueur') || s.includes('taux légal en vigueur'))).toBe(false);
    expect(penalites).not.toMatch(/\d+\s*,?\d*\s*%/);
  });

  it('B2G : intérêts moratoires BCE + 8 points + 40 € (L2192-12/13 CCP) — pas de L441-10', () => {
    const m = mentions({ customer: b2g() });
    expect(m.some((s) => s === 'Escompte pour paiement anticipé : néant.')).toBe(true);
    expect(
      m.some(
        (s) =>
          s ===
          'Intérêts moratoires : taux BCE + 8 points. Indemnité forfaitaire de recouvrement : 40 € (art. L2192-12 et L2192-13 du code de la commande publique).',
      ),
    ).toBe(true);
    expect(m.some((s) => s.includes('L441-10'))).toBe(false);
  });

  it('B2C (particulier) : ni escompte, ni pénalités, ni 40 €, ni L441-10 — le régime consommateur est différent', () => {
    const m = mentions();
    expect(m.some((s) => s.includes('Escompte'))).toBe(false);
    expect(m.some((s) => s.includes('Pénalités'))).toBe(false);
    expect(m.some((s) => s.includes('40 €'))).toBe(false);
    expect(m.some((s) => s.includes('L441-10'))).toBe(false);
    expect(m.some((s) => s.includes('Intérêts moratoires'))).toBe(false);
  });

  // —— P11 (C-EXP1) : mention certifiée taux réduits travaux (remplace l'attestation Cerfa) ——
  it('ligne à 10 % => mention certifiée art. 279-0 bis (habitation achevée depuis plus de deux ans)', () => {
    const m = mentions({ lineVatRates: [10, 20] });
    const certifiee = m.find((s) => s.includes('279-0 bis'));
    expect(certifiee).toContain('Taux réduit de TVA 10 %');
    expect(certifiee).toContain('achevés depuis plus de deux ans');
    expect(certifiee).toContain('le client atteste');
    expect(m.some((s) => s.includes('278-0 bis A'))).toBe(false);
  });

  it('ligne à 5,5 % => mention certifiée art. 278-0 bis A (rénovation énergétique)', () => {
    const m = mentions({ lineVatRates: [5.5] });
    const certifiee = m.find((s) => s.includes('278-0 bis A'));
    expect(certifiee).toContain('Taux réduit de TVA 5,5 %');
    expect(certifiee).toContain('rénovation énergétique');
    expect(m.some((s) => s.includes('279-0 bis du CGI'))).toBe(false);
  });

  it('les deux taux réduits présents => les deux mentions ; aucun taux réduit => aucune mention', () => {
    const both = mentions({ lineVatRates: [10, 5.5] });
    expect(both.some((s) => s.includes('279-0 bis du CGI'))).toBe(true);
    expect(both.some((s) => s.includes('278-0 bis A du CGI'))).toBe(true);
    const none = mentions({ lineVatRates: [20, 0] });
    expect(none.some((s) => s.includes('Taux réduit'))).toBe(false);
    expect(mentions().some((s) => s.includes('Taux réduit'))).toBe(false);
  });

  it('les booléens d’éligibilité, quand ils sont fournis, GATENT la mention (suggestVatRate context)', () => {
    const veto = mentions({
      lineVatRates: [10, 5.5],
      reducedVatEligibility: { housingOlderThan2y: false, energyRenovation: false },
    });
    expect(veto.some((s) => s.includes('Taux réduit'))).toBe(false);
    const partiel = mentions({
      lineVatRates: [10, 5.5],
      reducedVatEligibility: { housingOlderThan2y: true, energyRenovation: false },
    });
    expect(partiel.some((s) => s.includes('279-0 bis du CGI'))).toBe(true);
    expect(partiel.some((s) => s.includes('278-0 bis A du CGI'))).toBe(false);
  });

  it('la mention certifiée s’imprime aussi sur le devis (la signature « Bon pour accord » vaut certification)', () => {
    const m = mentions({ kind: 'quote', lineVatRates: [10] });
    expect(m.some((s) => s.includes('279-0 bis du CGI'))).toBe(true);
    expect(m.some((s) => s.toLowerCase().includes('bon pour accord'))).toBe(true);
  });

  // —— Réforme 2026/2027 ——
  it('B2B => SIREN du client mentionné', () => {
    const m = mentions({ customer: b2b() });
    expect(m.some((s) => s.includes('SIREN 552081317'))).toBe(true);
  });
  it('B2C => pas de SIREN client (le SIREN émetteur A6 reste, lui, toujours présent)', () => {
    const m = mentions();
    expect(m.some((s) => s.includes('Client — SIREN'))).toBe(false);
    expect(m.some((s) => s === 'SIREN 732 829 320')).toBe(true);
  });
  it('nature des opérations sur facture', () => {
    const m = mentions({ operationNature: 'services' });
    expect(m.some((s) => s.includes('Prestation de services'))).toBe(true);
  });

  // —— Franchise en base : recodification CIBS, AUCUNE bascule automatique ————————
  // L'ancienne bascule datée au 2026-09-01 émettait « TVA non applicable — franchise en base
  // (CIBS) » : mention SANS base légale (l'art. 293 E, II du CGI exige « la mention correspondant
  // à la base légale de la franchise »), et sur une date d'entrée en vigueur désormais reportée
  // au 01/01/2027 (ord. n° 2026-671 du 27/07/2026). Ces tests gèlent l'état sourcé et certain.
  describe('franchise en base — pas de bascule CIBS présumée', () => {
    const franchise = (asOf: string): string[] =>
      mentions({ company: company({ vatRegime: 'franchise' }), asOf });

    it('la mention est LITTÉRALEMENT celle de l’art. 293 E, II du CGI — verbatim, sans abréviation', () => {
      // Le texte prescrit une rédaction ENTRE GUILLEMETS : elle est reproduite caractère pour
      // caractère. « art. » est le raccourci du métier (licite, mais pas le verbatim) — même
      // exigence que pour l'option débits, où « TVA sur les débits » a été écarté.
      expect(franchise('2026-06-01')).toContain('TVA non applicable, article 293 B du CGI');
      expect(MENTION_FRANCHISE_BASE).toBe('TVA non applicable, article 293 B du CGI');
      expect(MENTION_FRANCHISE_BASE).not.toMatch(/\bart\./u);
    });

    it('même mention à TOUTE date — y compris au 2026-09-01, date de l’ancienne bascule (reportée)', () => {
      for (const asOf of ['2026-06-01', '2026-08-31', '2026-09-01', '2026-12-31', CIBS_TVA_ENTREE_EN_VIGUEUR, '2027-06-30', CIBS_TOLERANCE_REFERENCES_CGI]) {
        const m = franchise(asOf);
        expect(m).toContain(MENTION_FRANCHISE_BASE);
        // La rédaction CIBS relèvera d'un décret NON PARU (art. 293 E, II « déclassé ») : tant
        // qu'il n'existe pas, aucune pièce ne doit porter une formulation présumée.
        expect(m.some((s) => s.includes('CIBS'))).toBe(false);
        expect(m.some((s) => s.includes('L. 223-3'))).toBe(false);
      }
    });

    it('aucune mention de franchise SANS numéro d’article (exigence de base légale, 293 E, II)', () => {
      for (const asOf of ['2026-08-31', '2026-09-01', CIBS_TVA_ENTREE_EN_VIGUEUR]) {
        const franchiseMention = franchise(asOf).find((s) => s.startsWith('TVA non applicable'));
        expect(franchiseMention).toBeDefined();
        expect(franchiseMention).toMatch(/\bart(?:icle)?\.?\s+(?:293 B|L\.\s?223-3)\b/u);
      }
    });

    it('les dates de la réforme sont des CONSTANTES sourcées, jamais des dates en dur', () => {
      // Entrée en vigueur du transfert de la TVA au CIBS : reportée du 01/09/2026 au 01/01/2027
      // (ord. n° 2026-671 du 27/07/2026, JORF n° 0174 du 28/07/2026).
      expect(CIBS_TVA_ENTREE_EN_VIGUEUR).toBe('2027-01-01');
      // Tolérance des anciennes références CGI sur les factures : portée du 31/12/2027 au
      // 30/06/2028 par la même ordonnance — seule échéance qui engage les mentions de Bob.
      expect(CIBS_TOLERANCE_REFERENCES_CGI).toBe('2028-06-30');
      expect(CIBS_TVA_ENTREE_EN_VIGUEUR < CIBS_TOLERANCE_REFERENCES_CGI).toBe(true);
    });

    // Le moment le plus dangereux de toute cette histoire n'est pas aujourd'hui : c'est le jour où
    // quelqu'un ajoutera la DEUXIÈME rédaction à la table. Ces invariants sont là pour ce jour-là.
    describe('table des rédactions — garde-fous pour le jour où le décret paraîtra', () => {
      it('non vide, ordonnée par date d’effet croissante (le resolver prend la dernière atteinte)', () => {
        expect(REDACTIONS_FRANCHISE.length).toBeGreaterThan(0);
        const dates = REDACTIONS_FRANCHISE.map((r) => r.aPartirDu);
        expect(dates).toEqual([...dates].sort());
        expect(new Set(dates).size).toBe(dates.length);
      });

      it('aucune rédaction sans texte qui la prescrit — la source n’est pas décorative', () => {
        for (const r of REDACTIONS_FRANCHISE) {
          expect(r.mention.trim().length).toBeGreaterThan(0);
          expect(r.source.trim().length).toBeGreaterThan(0);
          expect(r.aPartirDu).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        }
      });

      it('GARDE ANTI-FABRICATION : aucune rédaction CIBS en table tant que le décret n’est pas paru', () => {
        // Si ce test échoue, deux cas et deux seuls. Le décret est paru : rouvrez ce test
        // SCIEMMENT, en citant le décret dans `source`. Il ne l'est pas : la rédaction ajoutée est
        // déduite (impots.gouv.fr, un article de presse, un raisonnement) — retirez-la. Une mention
        // est figée à l'émission : une pièce émise sur une rédaction présumée reste fausse à jamais.
        for (const r of REDACTIONS_FRANCHISE) {
          expect(r.mention).not.toContain('CIBS');
          expect(r.mention).not.toContain('L. 223-3');
          expect(r.mention).not.toContain('impositions sur les biens et services');
        }
      });
    });

    it('régime réel : jamais de mention de franchise, quelle que soit la date', () => {
      for (const asOf of ['2026-08-31', '2026-09-01', CIBS_TVA_ENTREE_EN_VIGUEUR]) {
        expect(mentions({ asOf }).some((s) => s.includes('TVA non applicable'))).toBe(false);
      }
    });
  });

  // —— Option pour le paiement de la TVA d'après les DÉBITS (242 nonies A, I-11° bis) ————
  describe('option pour les débits', () => {
    it('non renseignée : mention OMISE — jamais un régime fiscal déduit d’une information absente', () => {
      expect(mentions().some((s) => s.includes('débits'))).toBe(false);
      expect(mentions({ vatOnDebitsOption: false }).some((s) => s.includes('débits'))).toBe(false);
    });

    it('option exercée : mention LITTÉRALE du 11° bis — jamais le raccourci « TVA sur les débits »', () => {
      const m = mentions({ vatOnDebitsOption: true });
      expect(m).toContain("Option pour le paiement de la taxe d'après les débits");
      expect(MENTION_OPTION_DEBITS).toBe("Option pour le paiement de la taxe d'après les débits");
      expect(m.some((s) => s === 'TVA sur les débits')).toBe(false);
      // Le texte n'impose aucun numéro d'article, contrairement à la franchise : on n'en ajoute pas.
      expect(m.find((s) => s.includes('débits'))).not.toMatch(/CGI|annexe/u);
    });

    it('devis : le champ est INERTE — mention de FACTURE (art. 242 nonies A, annexe II CGI), l’exigibilité ne naît d’aucun devis', () => {
      // DÉCISION FIGÉE ICI : l'option ne se branche qu'au point d'appel FACTURE (issue-invoice).
      // Passer `true` au rendu d'un devis n'imprime rien — ce n'est pas un oubli de câblage.
      const m = mentions({ kind: 'quote', vatOnDebitsOption: true });
      expect(m.some((s) => s.includes('débits'))).toBe(false);
    });

    it('franchise en base : l’option est sans objet — la franchise PRIME, jamais les deux mentions', () => {
      const m = mentions({ company: company({ vatRegime: 'franchise' }), vatOnDebitsOption: true });
      expect(m).toContain(MENTION_FRANCHISE_BASE);
      expect(m.some((s) => s.includes('débits'))).toBe(false);
    });

    // CHOIX DE PRODUIT DOCUMENTÉ — PAS UNE RÈGLE SOURCÉE. Tout le reste de ce fichier fige des
    // règles adossées à un texte cité ; ce test-ci fige une décision, et le dit.
    //
    // Ce que les textes disent SÉPARÉMENT (chacun vérifié, aucun ne parle de l'autre) :
    //  • art. 283, 2 nonies du CGI + art. 242 nonies A, I-13° de l'annexe II : la mention
    //    « Autoliquidation » est due parce que la taxe est acquittée par le PRENEUR ;
    //  • art. 242 nonies A, I-11° bis de l'annexe II : la mention d'option est due « lorsque le
    //    prestataire a opté pour le paiement de la taxe d'après les débits » — la condition porte
    //    sur le seul fait que l'entreprise A OPTÉ, sans exclure aucune opération.
    // Ce qu'AUCUN texte ni aucune doctrine trouvés ne dit (recherche du 28/07/2026, Légifrance +
    // BOFiP) : si les deux mentions peuvent, doivent ou ne peuvent pas coexister sur une même
    // pièce. La question n'est pas tranchée en droit publié.
    //
    // Décision de Bob, faute de texte : imprimer ce que chaque texte impose séparément, sans
    // INVENTER une préséance que personne n'a posée. Sens de la prudence : omettre une mention
    // obligatoire est sanctionné (art. 1737, II du CGI), tandis qu'imprimer une mention exacte
    // sur l'émetteur ne l'est pas.
    //
    // À NE PAS CONFONDRE avec la préséance de la franchise, testée juste au-dessus : celle-là est
    // juridiquement certaine et non un choix — le franchisé n'est pas redevable de la taxe
    // (art. 293 B ; BOI-TVA-DECLA-10-10-20), il ne peut donc pas avoir opté pour le paiement de
    // CETTE taxe d'après les débits. Ici, l'entreprise est bien redevable : elle collecte la TVA
    // sur ses autres clients, l'option existe réellement chez elle.
    //
    // Si une doctrine paraît sur ce point, c'est CE test qu'il faut rouvrir en premier.
    it('autoliquidation BTP + option débits : CHOIX DE PRODUIT (aucun texte publié ne tranche la coexistence) — Bob s’en tient à la lettre de chaque texte', () => {
      const m = mentions({
        customer: customer({ type: 'b2b', siren: '552081317', isSubcontractingBtp: true }),
        vatOnDebitsOption: true,
      });
      expect(m.some((s) => s.includes('Autoliquidation'))).toBe(true);
      expect(m).toContain(MENTION_OPTION_DEBITS);
    });
  });

  // —— A6 : bloc émetteur complet (SIREN, TVA intracom, forme + capital, suffixe « EI ») ——
  describe('A6 — bloc émetteur', () => {
    it('entrepreneur individuel (EI comme micro) : dénomination suivie de « EI » (décret 2022-725)', () => {
      const ei = mentions();
      expect(ei[0]).toBe('Mercier Plomberie, EI — 1 rue X, 92000 Nanterre');
      const micro = mentions({ company: company({ legalForm: 'micro' }) });
      expect(micro[0]).toBe('Mercier Plomberie, EI — 1 rue X, 92000 Nanterre');
    });

    it('société avec capital saisi : forme + capital en euros (art. R123-238 c. com., centimes convertis)', () => {
      const m = mentions({ company: company({ legalForm: 'SARL', capitalSocialCents: 1_000_000 }) });
      // formatEUR : séparateurs U+202F (espace fine insécable) — 1 000 000 centimes = 10 000,00 €.
      expect(m[0]).toBe(
        `Mercier Plomberie, SARL au capital de ${formatEUR(1_000_000)} — 1 rue X, 92000 Nanterre`,
      );
      expect(formatEUR(1_000_000).normalize('NFKC')).toBe('10 000,00 €');
      expect(m[0]).not.toContain(' EI ');
    });

    it('société SANS capital saisi : forme seule, capital jamais inventé', () => {
      const m = mentions({ company: company({ legalForm: 'SASU' }) });
      expect(m[0]).toBe('Mercier Plomberie, SASU — 1 rue X, 92000 Nanterre');
      expect(m.some((s) => s.includes('capital'))).toBe(false);
    });

    it('SIREN émetteur lisible en groupes de 3 (art. R123-237 c. com.)', () => {
      expect(mentions().some((s) => s === 'SIREN 732 829 320')).toBe(true);
    });

    it('TVA intracom : utilise uniquement la valeur réelle du profil, jamais une dérivation SIREN', () => {
      const fromProfile = mentions();
      expect(fromProfile.some((s) => s === 'TVA intracommunautaire : FR44732829320')).toBe(true);
      const { tvaIntracom: _vat, ...withoutVat } = baseCompany;
      const missingCompany = Company.of(withoutVat);
      if (!missingCompany.ok) throw new Error('company sans TVA de test invalide');
      const missing = mentions({ company: missingCompany.value });
      expect(missing.some((s) => s.startsWith('TVA intracommunautaire :'))).toBe(false);
    });

    it('franchise en base : AUCUN n° TVA intracom (TVA non applicable — cohérent avec le XML)', () => {
      const m = mentions({ company: company({ vatRegime: 'franchise' }) });
      expect(m.some((s) => s.includes('TVA intracommunautaire'))).toBe(false);
    });
  });

  // —— A2 : médiateur de la consommation (L612-1/L616-1 c. conso), B2C uniquement ——
  describe('A2 — médiateur de la consommation', () => {
    const mediateur = { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris — cm2c.net' };

    it('B2C + médiateur renseigné : mention nom + coordonnées, sur facture ET devis', () => {
      for (const kind of ['invoice', 'quote'] as const) {
        const m = mentions({ company: company({ mediateurConso: mediateur }), kind });
        expect(
          m.some(
            (s) =>
              s ===
              'Médiateur de la consommation : CM2C — 14 rue Saint-Jean, 75017 Paris — cm2c.net (art. L612-1 et L616-1 du code de la consommation).',
          ),
        ).toBe(true);
      }
    });

    it('B2C sans médiateur renseigné : mention ABSENTE (jamais inventée — le nudge relève des réglages)', () => {
      expect(mentions().some((s) => s.includes('Médiateur'))).toBe(false);
    });

    it('client professionnel (B2B/B2G) : pas de mention médiateur même si renseigné', () => {
      const m = mentions({ company: company({ mediateurConso: mediateur }), customer: b2b() });
      expect(m.some((s) => s.includes('Médiateur'))).toBe(false);
    });
  });

  // —— A1 : mentions du devis (arrêté du 24/01/2017, L243-2) ——
  describe('A1 — mentions du devis', () => {
    it('date d’établissement imprimée quand connue (Quote.issuedAt), jamais rétro-datée quand null', () => {
      const dated = mentions({ kind: 'quote', establishedOn: '2026-06-01' });
      expect(dated.some((s) => s === 'Devis établi le 2026-06-01.')).toBe(true);
      const legacy = mentions({ kind: 'quote', establishedOn: null });
      expect(legacy.some((s) => s.includes('établi'))).toBe(false);
    });

    it('caractère gratuit + validité : jours à la création, date limite au rendu (validUntilDays prioritaire)', () => {
      const days = mentions({ kind: 'quote', validUntilDays: 30, validUntil: '2026-06-30' });
      expect(days.some((s) => s === 'Devis gratuit.')).toBe(true);
      expect(days.some((s) => s === 'Devis valable 30 jours.')).toBe(true);
      expect(days.some((s) => s.includes("jusqu'au"))).toBe(false);
      const byDate = mentions({ kind: 'quote', validUntil: '2026-06-30' });
      expect(byDate.some((s) => s === "Devis valable jusqu'au 2026-06-30.")).toBe(true);
    });

    it('la date d’établissement ne s’imprime jamais sur une facture', () => {
      expect(mentions({ establishedOn: '2026-06-01' }).some((s) => s.includes('établi'))).toBe(false);
    });

    // exactOptionalPropertyTypes : l'absence de décennale se modélise en OMETTANT la clé.
    const companySansDecennale = (over: Partial<CompanyProps> = {}): Company => {
      const { decennale: _decennale, ...props } = { ...baseCompany, ...over };
      const r = Company.of(props);
      if (!r.ok) throw new Error('company de test invalide');
      return r.value;
    };

    it('BTP sans décennale : rappel honnête L243-2 sur le DEVIS uniquement, jamais une police inventée', () => {
      const sansDecennale = companySansDecennale();
      const quote = mentions({ company: sansDecennale, kind: 'quote' });
      const rappel = quote.find((s) => s.includes('L243-2'));
      expect(rappel).toContain('non renseignée');
      expect(quote.some((s) => s.startsWith('Assurance decennale :'))).toBe(false);
      const invoice = mentions({ company: sansDecennale, kind: 'invoice' });
      expect(invoice.some((s) => s.includes('L243-2'))).toBe(false);
    });

    it('métier hors BTP sans décennale : aucun rappel L243-2', () => {
      const consultant = companySansDecennale({ trade: 'consultant' });
      const m = mentions({ company: consultant, kind: 'quote' });
      expect(m.some((s) => s.includes('L243-2'))).toBe(false);
    });
  });
});

describe('operationNatureOf', () => {
  it('supply => biens, labor => services, mixte', () => {
    expect(operationNatureOf([{ category: 'supply' }])).toBe('biens');
    expect(operationNatureOf([{ category: 'labor' }])).toBe('services');
    expect(operationNatureOf([{ category: 'supply' }, { category: 'labor' }])).toBe('mixte');
  });
  it('les débours ne pilotent pas la nature : supply + disbursement => biens', () => {
    expect(operationNatureOf([{ category: 'supply' }, { category: 'disbursement' }])).toBe('biens');
    expect(operationNatureOf([{ category: 'labor' }, { category: 'disbursement' }])).toBe('services');
  });
});

describe('buildMentions — remises B3 (L441-9)', () => {
  it('facture AVEC réductions : mention « rabais, remises, ristournes » présente', () => {
    const m = mentions({ hasPriceReductions: true });
    const mention = m.find((x) => x.includes('Rabais, remises et ristournes'));
    expect(mention).toBeDefined();
    expect(mention).toContain('L441-9');
  });
  it('facture SANS réduction : mention omise (jamais une mention sans support)', () => {
    expect(mentions().some((x) => x.includes('Rabais'))).toBe(false);
    expect(mentions({ hasPriceReductions: false }).some((x) => x.includes('Rabais'))).toBe(false);
  });
  it('devis : la mention est propre à la FACTURE (L441-9), omise sur devis', () => {
    const m = mentions({ kind: 'quote', hasPriceReductions: true });
    expect(m.some((x) => x.includes('Rabais'))).toBe(false);
  });
});
