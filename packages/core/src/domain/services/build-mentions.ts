import { type Company } from '../company/company';
import { type Customer } from '../customer/customer';
import { type LineCategory } from '../billing/shared/line-item';
import { type VatRate } from '../billing/shared/vat-rate';
import { type DateOnly } from '../../shared-kernel/time';
import { formatEUR } from '../../format/money';

export type OperationNature = 'biens' | 'services' | 'mixte';

/**
 * Recodification de la TVA dans le CIBS (code des impositions sur les biens et services) —
 * DATE D'ENTRÉE EN VIGUEUR, en constante nommée et non éparpillée, parce qu'elle a DÉJÀ bougé
 * une fois : l'ordonnance n° 2025-1247 du 17 décembre 2025 (JORF du 20/12/2025), qui crée le
 * livre II du CIBS (art. L200-1 à L246-12), la fixait au 1er septembre 2026 ; l'ordonnance
 * n° 2026-671 du 27 juillet 2026 (JORF n° 0174 du 28/07/2026) la reporte au 1er janvier 2027 —
 * rapport au Président de la République : « le décalage du 1er septembre 2026 au 1er janvier
 * 2027 de l'entrée en vigueur du transfert des dispositions régissant la TVA au sein du CIBS ».
 * La recodification se fait à DROIT CONSTANT : « ces changements présentent un caractère formel
 * et n'emporte aucune modification quant aux règles de fond applicable » (rapport au Président
 * de l'ordonnance 2025-1247) — rien ne change pour l'entreprise, seule la référence bouge.
 * Vérifié le 28/07/2026 (JORF + compte rendu du conseil des ministres du 27/07/2026).
 */
export const CIBS_TVA_ENTREE_EN_VIGUEUR = '2027-01-01';

/**
 * Date jusqu'à laquelle les anciennes références au CGI restent ADMISES SUR LES FACTURES
 * (tolérance posée par l'ordonnance 2025-1247, reportée du 31/12/2027 au 30/06/2028 par
 * l'ordonnance 2026-671 : « la date jusqu'à laquelle les anciennes références au CGI peuvent
 * continuer à être utilisées est reportée du 31 décembre 2027 au 30 juin 2028 »).
 * C'est la SEULE échéance qui engage les mentions de Bob : jusque-là, citer le CGI est licite.
 */
export const CIBS_TOLERANCE_REFERENCES_CGI = '2028-06-30';

/**
 * Franchise en base — mention obligatoire, reproduite VERBATIM depuis l'art. 293 E, II du CGI :
 * la facture « doit comporter la mention correspondant à la base légale de la franchise :
 * "TVA non applicable, article 293 B du CGI" […] ». Reprise à l'identique par la doctrine
 * (BOFiP BOI-TVA-DECLA-40-10-20, I-B § 50, version du 01/07/2026).
 * Le texte exige une BASE LÉGALE : une mention de franchise sans numéro d'article n'est jamais
 * conforme, quelle que soit la date.
 *
 * POURQUOI « article » ET NON L'ABRÉVIATION « art. » COURANTE : le texte prescrit une rédaction
 * ENTRE GUILLEMETS ; Bob l'imprime alors caractère pour caractère, exactement comme pour l'option
 * pour les débits (MENTION_OPTION_DEBITS), plutôt que le raccourci de langage du métier. La forme
 * abrégée « art. 293 B du CGI » reste licite et universellement admise (elle a d'ailleurs été
 * imprimée par Bob jusqu'ici — les pièces déjà émises la portent, figée, et restent conformes) ;
 * le verbatim est simplement la seule rédaction qu'aucun contrôle ne peut discuter.
 * Vérifié le 28/07/2026.
 */
export const MENTION_FRANCHISE_BASE = 'TVA non applicable, article 293 B du CGI';

/**
 * Option pour les débits — mention LITTÉRALE de l'art. 242 nonies A, I-11° bis de l'annexe II
 * au CGI : « Lorsque le prestataire a opté pour le paiement de la taxe d'après les débits, la
 * mention : "Option pour le paiement de la taxe d'après les débits" ». Aucun numéro d'article à
 * accoler (le texte n'en impose pas, contrairement à la franchise), et surtout PAS le raccourci
 * de langage « TVA sur les débits », qui n'est pas la mention légale.
 * Cette mention ne changera PAS de référence au 01/01/2027 : elle vit dans l'annexe II au CGI,
 * de rang réglementaire, hors du champ de l'ordonnance de recodification (qui est purement
 * législative) — vérifié le 28/07/2026, aucune version future sur la fiche de l'art. 242 nonies A.
 */
export const MENTION_OPTION_DEBITS = "Option pour le paiement de la taxe d'après les débits";

const NATURE_LABEL: Record<OperationNature, string> = {
  biens: 'Livraison de biens',
  services: 'Prestation de services',
  mixte: 'Opérations mixtes (livraison de biens et prestation de services)',
};

/** Nature des opérations à partir des catégories de lignes (mention obligatoire réforme 2026/2027). */
export function operationNatureOf(lines: readonly { category: LineCategory }[]): OperationNature {
  // Les débours (remboursement de frais avancés, hors base TVA) ne pilotent ni « biens » ni « services ».
  const taxable = lines.filter((l) => l.category !== 'disbursement');
  const hasBiens = taxable.some((l) => l.category === 'supply');
  const hasServices = taxable.some((l) => l.category !== 'supply');
  return hasBiens && hasServices ? 'mixte' : hasBiens ? 'biens' : 'services';
}

/**
 * Éligibilité aux taux réduits travaux (P11) — les MÊMES booléens que suggestVatRate
 * (context.housingOlderThan2y / context.energyRenovation), déjà saisis à la création de la pièce.
 */
export interface ReducedVatEligibility {
  /** Immeuble achevé depuis plus de deux ans, affecté à l'habitation (justifie le 10 %, art. 279-0 bis CGI). */
  housingOlderThan2y: boolean;
  /** Travaux de rénovation énergétique (justifie le 5,5 %, art. 278-0 bis A CGI). */
  energyRenovation: boolean;
}

export interface BuildMentionsInput {
  company: Company;
  customer: Customer;
  kind: 'quote' | 'invoice';
  /**
   * Date de référence de la pièce (jour ouvré courant au point d'appel). Conservée comme point
   * d'accroche des règles DATÉES : aucune mention n'en dépend aujourd'hui — la bascule CIBS est
   * délibérément non automatique, cf. le bloc franchise et CIBS_TVA_ENTREE_EN_VIGUEUR.
   */
  asOf: string;
  validUntilDays?: number;
  /**
   * Option pour le paiement de la TVA d'après les DÉBITS, réellement exercée par l'entreprise
   * (fondement de l'option : art. 269, 2-c du CGI ; modalités : art. 77 de l'annexe III au CGI —
   * option adressée au service des impôts, révocable). Exercée = la facture porte la mention
   * littérale de l'art. 242 nonies A, I-11° bis de l'annexe II au CGI (MENTION_OPTION_DEBITS).
   *
   * POURQUOI CE CHAMP EST OPTIONNEL ET AUCUN APPELANT NE LE RENSEIGNE ENCORE : l'option n'est
   * représentée NULLE PART dans le domaine (ni Company, ni le profil fiscal) — Bob ne peut donc
   * pas savoir si l'entreprise l'a exercée. Absent/false = mention OMISE : jamais une mention
   * fiscale déduite d'une information que l'entreprise n'a pas donnée. Le jour où le réglage
   * existe (case « J'ai opté pour le paiement de la TVA d'après les débits »), il suffit de le
   * passer ici, aux deux points d'appel (émission de facture et rendu de devis).
   *
   * ÉCHÉANCE RÉELLE — la mention n'est PAS encore obligatoire pour les entreprises servies :
   * l'art. 242 nonies A, I-11° bis (créé par l'art. 1er du décret n° 2022-1299 du 7 octobre 2022)
   * ne s'applique aux microentreprises et PME qu'aux factures émises à compter du 1er septembre
   * 2027 (art. 3 du décret 2022-1299, dans sa rédaction issue de l'art. 2 du décret n° 2024-266
   * du 25 mars 2024). D'ici là elle est FACULTATIVE mais conseillée, le droit à déduction du
   * client étant lié à l'exigibilité chez le fournisseur (BOFiP BOI-TVA-DECLA-30-20-20-30 § 310,
   * version du 08/01/2025 : « Les redevables qui ont exercé cette option ne sont pas obligés
   * d'indiquer sur leurs factures le fait qu'ils acquittent la TVA d'après les débits »).
   * Vérifié le 28/07/2026.
   */
  vatOnDebitsOption?: boolean;
  /** Nature des opérations (obligatoire sur facture dès la réforme). */
  operationNature?: OperationNature;
  /**
   * B3 — la pièce porte des réductions de prix (remise de ligne et/ou remise globale) :
   * déclenche la mention « rabais, remises, ristournes » (art. L441-9 du code de commerce ;
   * art. 242 nonies A, I-8° de l'annexe II au CGI — réductions acquises et chiffrables lors de
   * l'opération, directement liées à elle). Absent/false = aucune réduction, mention omise.
   */
  hasPriceReductions?: boolean;
  /**
   * Taux de TVA portés par les lignes de la pièce — déclenchent la mention certifiée taux réduits
   * (P11, art. 41 LF 2025 : remplace l'attestation Cerfa depuis le 16/2/2025).
   */
  lineVatRates?: readonly VatRate[];
  /**
   * Booléens d'éligibilité quand ils sont CONNUS au point d'appel : ils gatent la mention.
   * Omis (ex. émission de facture — le contexte de création n'est pas persisté) : une ligne à taux
   * réduit vaut éligibilité actée, car suggestVatRate est le seul chemin d'attribution d'un taux
   * réduit (10 % via housingOlderThan2y, 5,5 % via energyRenovation, ou choix explicite équivalent)
   * — et NE PAS imprimer la mention ferait perdre le taux réduit en contrôle (l'objet même de P11).
   */
  reducedVatEligibility?: ReducedVatEligibility;
  /**
   * A1 — date d'établissement du devis (Quote.issuedAt), mention « Devis établi le … »
   * (arrêté du 24 janvier 2017 relatif à la publicité des prix des prestations de dépannage,
   * réparation et entretien dans le secteur du bâtiment : le devis porte sa date d'établissement).
   * Null/absent = brouillon ou devis legacy envoyé avant l'ajout du champ : mention OMISE,
   * jamais rétro-datée.
   */
  establishedOn?: DateOnly | null;
  /**
   * A1 — date limite de validité (Quote.validUntil) pour le rendu d'un devis EXISTANT, quand la
   * durée en jours n'est pas connue au point d'appel. `validUntilDays` (création) reste prioritaire.
   */
  validUntil?: DateOnly | null;
}

/** SIREN lisible pour le bloc émetteur : 732829320 → « 732 829 320 » (groupes de 3 chiffres). */
function sirenLisible(siren: string): string {
  const v = siren.replace(/\s/g, '');
  return `${v.slice(0, 3)} ${v.slice(3, 6)} ${v.slice(6, 9)}`;
}

export function buildMentions(input: BuildMentionsInput): string[] {
  const { company, customer, kind } = input;
  const m: string[] = [];
  // A6 — dénomination + forme juridique du bloc émetteur :
  // • sociétés commerciales : dénomination précédée ou suivie de la forme ET énonciation du
  //   capital social sur tout document destiné aux tiers (art. R123-238 du code de commerce).
  //   Capital jamais inventé : forme seule tant qu'il n'a pas été saisi (données honnêtes) ;
  // • entrepreneur individuel (EI comme micro) : dénomination suivie immédiatement des initiales
  //   « EI » sur tous les documents professionnels (art. R526-27 du code de commerce, décret
  //   n° 2022-725 du 28 avril 2022).
  const forme = company.isSociete()
    ? company.capitalSocialCents !== undefined
      ? `${company.legalForm} au capital de ${formatEUR(company.capitalSocialCents)}`
      : company.legalForm
    : 'EI';
  m.push(`${company.name}, ${forme} — ${company.address.line1}, ${company.address.zip} ${company.address.city}`);
  // A6 — numéro unique d'identification (SIREN) de l'émetteur sur ses documents commerciaux
  // (art. R123-237 du code de commerce), en complément du RCS/RM ci-dessous.
  m.push(`SIREN ${sirenLisible(company.siren)}`);
  if (company.rcsOrRm) m.push(company.rcsOrRm);
  // A6 — n° de TVA intracommunautaire du vendeur dès lors que la TVA est facturée (art. 242
  // nonies A, I-3° de l'annexe II au CGI). Franchise en base : TVA non applicable, numéro omis —
  // cohérent avec le XML Factur-X qui omet BT-31 en franchise. Le numéro doit avoir été
  // réellement fourni/validé dans Company : un SIREN permet de calculer une clé mais ne prouve
  // ni l'attribution ni l'activité du numéro, donc il n'est JAMAIS converti en mention fiscale.
  if (!company.isVatFranchise() && company.tvaIntracom) {
    m.push(`TVA intracommunautaire : ${company.tvaIntracom}`);
  }

  // Réforme 2026/2027 : le SIREN du client (assujetti) devient une mention obligatoire en B2B/B2G.
  if (customer.type !== 'b2c' && customer.siren) m.push(`Client — SIREN ${customer.siren}`);
  // A2 — médiateur de la consommation : mention obligatoire envers les CONSOMMATEURS sur devis
  // et factures (art. L616-1 c. conso : communication du nom et des coordonnées du ou des
  // médiateurs dont relève le professionnel ; adhésion obligatoire, art. L612-1 c. conso).
  // Non renseigné = mention ABSENTE (le nudge « as-tu un médiateur ? » relève des réglages/UI) —
  // jamais un médiateur inventé.
  if (customer.type === 'b2c' && company.mediateurConso) {
    m.push(
      `Médiateur de la consommation : ${company.mediateurConso.nom} — ${company.mediateurConso.coordonnees} (art. L612-1 et L616-1 du code de la consommation).`,
    );
  }
  // Nature des opérations (livraison de biens / prestation de services) — obligatoire sur facture.
  if (kind === 'invoice' && input.operationNature) m.push(`Nature de l'opération : ${NATURE_LABEL[input.operationNature]}`);
  // B3 — rabais, remises et ristournes ACQUIS à la date de l'opération et directement liés à
  // elle : mention obligatoire de la facture (art. L441-9 du code de commerce ; art. 242
  // nonies A, I-8° de l'annexe II au CGI). Les montants exacts sont détaillés sur les lignes
  // et le total de la pièce (grossHt/discountCents figés) — jamais une mention sans support.
  if (kind === 'invoice' && input.hasPriceReductions === true) {
    m.push(
      'Rabais, remises et ristournes acquis à la date de la vente ou de la prestation et directement liés à cette opération : détaillés sur les lignes et le total de la présente facture (art. L441-9 du code de commerce).',
    );
  }

  if (company.isVatFranchise()) {
    // Mention de franchise : UNE SEULE formulation, à toute date, et AUCUNE bascule automatique
    // vers le CIBS. Trois faits, tous vérifiés le 28/07/2026 :
    //  1. la recodification de la TVA dans le CIBS n'entre en vigueur qu'au
    //     CIBS_TVA_ENTREE_EN_VIGUEUR — reportée du 01/09/2026 au 01/01/2027 par l'ordonnance
    //     n° 2026-671 du 27/07/2026. Une bascule datée au 1er septembre 2026 aurait fait citer
    //     un code non encore applicable : le risque de mention fausse venait de la bascule
    //     elle-même, pas de l'inaction ;
    //  2. « art. 293 B du CGI » reste ADMIS sur les factures jusqu'au
    //     CIBS_TOLERANCE_REFERENCES_CGI : il n'existe, avant cette date, AUCUN moment où cette
    //     mention devient fausse. S'ajoute le principe de correspondance automatique des
    //     références posé par l'ordonnance 2025-1247 (rescrit BOI-RES-TVA-000253) ;
    //  3. l'article CIBS correspondant est CONNU — la table de concordance officielle publiée
    //     avec le JO n° 0298 du 20/12/2025 porte « CGI art. 293 B, I, al. 1 → L. 223-3 » — mais
    //     l'OBLIGATION DE MENTION elle-même (art. 293 E, II du CGI) y est portée « déclassée »
    //     au rang réglementaire : la rédaction exacte à imprimer après bascule relèvera d'un
    //     DÉCRET QUI N'EST PAS PARU. impots.gouv.fr (MAJ 21/05/2026) écrit « TVA non applicable,
    //     article L. 223-3 du code des impositions des biens et des services », mais aucune
    //     norme ne l'impose à ce jour — et cette page est antérieure au report.
    // Les mentions sont FIGÉES à l'émission (Invoice.legalMentions) : une pièce émise avec une
    // rédaction présumée resterait fausse pour toujours. Tant que le décret n'est pas publié,
    // Bob n'imprime que la rédaction dont la base légale est certaine.
    // POINT DE VEILLE DATÉ : à la parution du décret portant la partie réglementaire TVA du CIBS
    // — et au plus tard avant CIBS_TOLERANCE_REFERENCES_CGI — remplacer MENTION_FRANCHISE_BASE
    // par la rédaction que ce décret impose. Pas avant, et jamais les deux mentions à la fois.
    m.push(MENTION_FRANCHISE_BASE);
  }
  // A4 — la FRANCHISE EN BASE PRIME sur l'autoliquidation : le sous-traitant en franchise
  // facture sous l'art. 293 B CGI (mention ci-dessus), il n'est pas concerné par le dispositif
  // d'autoliquidation (BOI-TVA-DECLA-10-10-20) — même préséance que facturXDataFromInvoice
  // (catégorie E, jamais AE) et IssueInvoice : le PDF ne porte JAMAIS les deux mentions
  // fiscales contradictoires (« TVA non applicable » + « Autoliquidation ») sur la même pièce.
  if (
    !company.isVatFranchise()
    && company.requiresAutoliquidation({ type: customer.type, isSubcontractingBtp: customer.isSubcontractingBtp })
  ) {
    m.push('Autoliquidation de la TVA (sous-traitance BTP, art. 283-2 nonies du CGI)');
  }
  // Option pour le paiement de la TVA d'après les DÉBITS : mention de FACTURE (art. 242 nonies A,
  // I-11° bis de l'annexe II au CGI), donc omise du devis — même traitement que les autres
  // mentions de ce même article portées ici (nature de l'opération, rabais/remises/ristournes).
  // Imprimée UNIQUEMENT si l'entreprise a déclaré avoir exercé l'option (cf. vatOnDebitsOption :
  // aucun champ ne la porte encore, donc rien ne s'imprime aujourd'hui). La franchise en base
  // prime, comme au-dessus : elle ne collecte pas la TVA, l'exigibilité — et donc l'option —
  // est sans objet ; jamais deux mentions fiscales concurrentes sur la même pièce.
  if (kind === 'invoice' && input.vatOnDebitsOption === true && !company.isVatFranchise()) {
    m.push(MENTION_OPTION_DEBITS);
  }

  // P11 — mention certifiée taux réduits travaux (art. 41, loi 2025-127 : remplace l'attestation
  // Cerfa depuis le 16/2/2025 ; BOI-TVA-LIQ-30-20-90-40). La signature « Bon pour accord » du devis
  // vaut certification PAR LE PRENEUR (c'est lui qu'elle engage) ; reprise sur la facture.
  // 10 % = art. 279-0 bis CGI ; 5,5 % rénovation énergétique = art. 278-0 bis A CGI.
  const rates = new Set<VatRate>(input.lineVatRates ?? []);
  const eligibility = input.reducedVatEligibility;
  if (rates.has(10) && (eligibility?.housingOlderThan2y ?? true)) {
    m.push(
      "Taux réduit de TVA 10 % — le client atteste que les travaux portent sur des locaux d'habitation achevés depuis plus de deux ans et qu'ils ne conduisent pas, sur une période de deux ans, à une surélévation du bâtiment ni à la production d'un immeuble neuf (art. 279-0 bis du CGI).",
    );
  }
  if (rates.has(5.5) && (eligibility?.energyRenovation ?? true)) {
    m.push(
      "Taux réduit de TVA 5,5 % — le client atteste que les travaux de rénovation énergétique portent sur des locaux d'habitation achevés depuis plus de deux ans et qu'ils ne conduisent pas, sur une période de deux ans, à une surélévation du bâtiment ni à la production d'un immeuble neuf (art. 278-0 bis A du CGI).",
    );
  }

  // P14 — mentions L441-9/L441-10 : ventes entre PROFESSIONNELS uniquement (le régime consommateur
  // est différent : rien de tout cela ne s'imprime pour un particulier). Escompte : mention
  // OBLIGATOIRE (L441-9) — aucun champ taux d'escompte au modèle, défaut légal « néant ».
  // Pénalités : la stipulation « taux légal » était IRRÉGULIÈRE (plancher L441-10 II = 3× le taux
  // légal) → on stipule le défaut légal BCE + 10 points, JAMAIS de taux chiffré en dur (il change
  // chaque semestre). B2G : régime propre du code de la commande publique (BCE + 8 points).
  if (customer.isProfessional()) {
    m.push('Escompte pour paiement anticipé : néant.');
    m.push(
      customer.type === 'b2g'
        ? 'Intérêts moratoires : taux BCE + 8 points. Indemnité forfaitaire de recouvrement : 40 € (art. L2192-12 et L2192-13 du code de la commande publique).'
        : 'Pénalités de retard : taux BCE + 10 points (art. L441-10 du code de commerce). Indemnité forfaitaire de recouvrement : 40 € (art. D441-5 du code de commerce).',
    );
  }

  if (company.isBtp() && company.decennale) {
    const d = company.decennale;
    m.push(`Assurance decennale : ${d.insurer}, police n°${d.policyNo}, couverture ${d.coverage}.`);
  } else if (company.isBtp() && kind === 'quote') {
    // A1 — métier BTP SANS décennale renseignée : rappel HONNÊTE sur le devis. L'art. L243-2
    // du code des assurances impose aux assujettis à l'obligation d'assurance (art. L241-1 s.)
    // de mentionner sur leurs devis et factures l'assurance souscrite, les coordonnées de
    // l'assureur et la couverture géographique — on n'invente JAMAIS une police absente : on
    // imprime l'état réel et le renvoi au texte, à charge pour l'entreprise de compléter son profil.
    m.push(
      "Assurance professionnelle obligatoire : non renseignée par l'entreprise à ce jour. La mention de l'assurance de responsabilité décennale, des coordonnées de l'assureur et de la couverture géographique est requise sur les devis et factures (art. L243-2 du code des assurances).",
    );
  }

  // A7 — l'adresse de livraison/chantier et la date de prestation sont désormais portées par la
  // pièce elle-même (Invoice.servicePeriod/deliveryAddress, figées à l'émission) : imprimées dans
  // la zone références du PDF (pdf-renderer) et injectées au XML Factur-X (BT-72/BG-14/BG-13) —
  // pas une mention de ce bloc. L'option « débits » de l'art. 242 nonies A, I-11° bis est, elle,
  // traitée plus haut (MENTION_OPTION_DEBITS) et attend le seul champ qui lui manque.
  // Conservation légale des factures émises/reçues = 10 ans (règle d'archivage, hors mention
  // imprimée).

  if (kind === 'quote') {
    // A1 — arrêté du 24 janvier 2017 (art. 2) : le devis des prestations de dépannage,
    // réparation et entretien (bâtiment) porte sa DATE D'ÉTABLISSEMENT et le CARACTÈRE
    // GRATUIT OU PAYANT du devis. La date est celle dérivée à l'envoi (Quote.issuedAt) —
    // omise pour un brouillon ou un devis legacy (jamais rétro-datée).
    if (input.establishedOn) m.push(`Devis établi le ${input.establishedOn}.`);
    m.push('Devis gratuit.');
    if (input.validUntilDays) m.push(`Devis valable ${input.validUntilDays} jours.`);
    else if (input.validUntil) m.push(`Devis valable jusqu'au ${input.validUntil}.`);
    m.push('Bon pour accord (date + signature) :');
  }
  return m;
}
