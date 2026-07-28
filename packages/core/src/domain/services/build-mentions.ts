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
 * Correspondance d'une référence CGI vers le CIBS. Deux états, et deux seulement — il n'existe pas
 * de « probable » ici : une mention est figée à l'émission, une correspondance devinée resterait
 * fausse pour toujours sur les pièces déjà émises.
 */
export type ConcordanceCibs =
  /** Relevée dans un texte officiel, qui est cité. */
  | { readonly statut: 'certaine'; readonly article: string; readonly source: string }
  /** Non établie à ce jour DANS CE DÉPÔT : à relever le jour venu, jamais à déduire. */
  | { readonly statut: 'inconnue'; readonly constatLe: DateOnly; readonly constat: string };

/** Une référence au CGI réellement IMPRIMÉE par buildMentions, et son sort au 30/06/2028. */
export interface ReferenceCgiImprimee {
  /** La référence telle qu'elle apparaît sur la pièce (« 293 B », « 283-2 nonies », …). */
  readonly article: string;
  /** Quelle mention la porte, et quand elle s'imprime — pour retrouver le code le jour venu. */
  readonly mention: string;
  readonly concordance: ConcordanceCibs;
}

/**
 * INVENTAIRE DES RÉFÉRENCES CGI IMPRIMÉES — la liste EXHAUSTIVE des mentions de ce fichier qui
 * citent un article du CGI, donc des mentions qui devront changer de référence au plus tard à
 * CIBS_TOLERANCE_REFERENCES_CGI (au-delà, l'ancienne référence n'est plus admise sur une facture).
 *
 * POURQUOI CETTE TABLE EXISTE. L'échéance de fin de tolérance (`veille-mentions-legales.ts`) posait
 * la règle générale mais ne prescrivait qu'un geste sur la seule mention de franchise : quatre
 * mentions au moins sont concernées, et une veille qui n'en nomme qu'une laisse les trois autres
 * expirer en silence. Le geste de l'alarme est désormais COMPOSÉ à partir d'ici : les deux ne
 * peuvent plus diverger.
 *
 * ELLE EST VÉRIFIÉE, PAS SEULEMENT ÉCRITE : la sonde du corpus (build-mentions.test.ts) déroule
 * toutes les configurations de pièces, extrait chaque « … du CGI » réellement imprimé, et exige
 * l'ÉGALITÉ avec cette table. Ajouter demain une mention citant le CGI sans l'inscrire ici fait
 * échouer la sonde — c'est le seul moyen de garantir que la liste reste exhaustive dans le temps.
 *
 * RÈGLE D'OR : `concordance` n'est « certaine » que si un texte officiel la porte et est cité.
 * Sinon « inconnue », avec la date du constat. Aucune correspondance n'est déduite d'une autre,
 * d'une page d'administration ou d'un raisonnement : elles ne sont pas toutes recodifiées au même
 * endroit ni au même rang, et une mention fausse ne se rattrape pas.
 */
export const REFERENCES_CGI_IMPRIMEES: readonly ReferenceCgiImprimee[] = [
  {
    article: '293 B',
    mention: 'franchise en base — « TVA non applicable, article 293 B du CGI » (REDACTIONS_FRANCHISE)',
    concordance: {
      statut: 'certaine',
      article: 'CIBS art. L. 223-3',
      source:
        'Table de concordance officielle publiée avec le JO n° 0298 du 20/12/2025 — '
        + '« CGI art. 293 B, I, al. 1 → L. 223-3 ». ATTENTION : l\'article de fond est connu, la '
        + 'RÉDACTION à imprimer ne l\'est pas — l\'obligation de mention (art. 293 E, II) y est '
        + 'portée « déclassée » au rang réglementaire et relève d\'un décret non paru au 28/07/2026.',
    },
  },
  {
    article: '283-2 nonies',
    mention: 'autoliquidation de la TVA — sous-traitance BTP, facture d\'un assujetti non franchisé',
    concordance: {
      statut: 'inconnue',
      constatLe: '2026-07-28',
      constat:
        'Aucune correspondance CIBS relevée dans les sources citées par ce dépôt : seule la ligne '
        + '« 293 B, I, al. 1 → L. 223-3 » de la table de concordance du JO n° 0298 du 20/12/2025 y '
        + 'est reproduite. À relever dans la table officielle le jour venu — jamais à déduire de la '
        + 'correspondance d\'un autre article.',
    },
  },
  {
    article: '279-0 bis',
    mention: 'taux réduit 10 % travaux (locaux d\'habitation achevés depuis plus de deux ans)',
    concordance: {
      statut: 'inconnue',
      constatLe: '2026-07-28',
      constat:
        'Aucune correspondance CIBS relevée dans les sources citées par ce dépôt. À relever dans la '
        + 'table de concordance officielle — jamais à déduire.',
    },
  },
  {
    article: '278-0 bis A',
    mention: 'taux réduit 5,5 % — travaux de rénovation énergétique',
    concordance: {
      statut: 'inconnue',
      constatLe: '2026-07-28',
      constat:
        'Aucune correspondance CIBS relevée dans les sources citées par ce dépôt. À relever dans la '
        + 'table de concordance officielle — jamais à déduire.',
    },
  },
];

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
 *
 * SON SORT AU 01/01/2027 — UN FAIT, PUIS UN RAISONNEMENT ; ce fichier ne doit jamais présenter le
 * second comme le premier :
 *  • LE FAIT, vérifiable en trois secondes juste au-dessus : la chaîne imprimée ne contient AUCUNE
 *    référence d'article. Elle ne peut donc pas devenir fausse par un changement de référence, et
 *    c'est à ce titre qu'elle est absente de REFERENCES_CGI_IMPRIMEES — la sonde du corpus le
 *    vérifie sur toutes les configurations. C'est ce fait, et lui seul, qui met Bob à l'abri ici ;
 *  • LE RAISONNEMENT, À VÉRIFIER, non sourcé (constat du 28/07/2026) : le 11° bis vit dans
 *    l'annexe II au CGI, de rang RÉGLEMENTAIRE, alors que l'ordonnance 2025-1247 recodifie des
 *    dispositions LÉGISLATIVES — le texte semble donc hors de son champ. Deux réserves qui
 *    interdisent d'en faire une certitude : aucune table de concordance consultée ne porte sur
 *    l'annexe II, et rien n'empêche un décret de recodification parallèle de la modifier. Le
 *    constat de l'époque (« aucune version future sur la fiche Légifrance de l'art. 242 nonies A »)
 *    est daté, donc périssable : il ne vaut pas preuve pour l'avenir.
 * À revérifier avec l'échéance `cibs-fin-tolerance-references-cgi` (veille-mentions-legales.ts).
 */
export const MENTION_OPTION_DEBITS = "Option pour le paiement de la taxe d'après les débits";

/** Une rédaction de la mention de franchise, avec sa date d'effet et le texte qui la fonde. */
export interface RedactionFranchise {
  /** Date à partir de laquelle cette rédaction s'applique (comparaison lexicographique DateOnly). */
  readonly aPartirDu: DateOnly;
  readonly mention: string;
  /** Le texte qui la prescrit. Une rédaction sans source n'entre PAS dans cette table. */
  readonly source: string;
}

/**
 * Rédactions SOURCÉES de la mention de franchise, par date d'effet croissante. Une seule
 * aujourd'hui, et c'est le fait juridique lui-même : la rédaction post-bascule CIBS relèvera d'un
 * DÉCRET NON PARU au 28/07/2026 (l'obligation de l'art. 293 E, II est déclassée au rang
 * réglementaire par la table de concordance du JO n° 0298 du 20/12/2025) — donc INCONNUE, donc
 * absente de cette table. Bob n'imprime que ce qui y figure : c'est structurellement impossible
 * d'émettre une rédaction présumée.
 *
 * LE JOUR OÙ LE DÉCRET PARAÎT, le geste tient en une ligne de DONNÉE, pas en une modification de
 * logique : ajouter { aPartirDu: <date d'effet du décret>, mention: <verbatim du décret>,
 * source: <référence du décret> }. C'est très exactement le geste que réclame l'alarme de veille
 * (`veille-mentions-legales.ts`), et l'ajouter est ce qui la fait taire légitimement.
 *
 * Exportée pour que ses invariants soient VÉRIFIÉS et non seulement écrits : le corpus fige la
 * présence d'une source sur chaque rédaction, l'ordre croissant des dates d'effet, et un garde-fou
 * anti-fabrication (aucune rédaction CIBS tant que le décret n'est pas paru). C'est au moment où
 * un développeur ajoutera la deuxième ligne — le moment le plus dangereux de toute cette histoire —
 * que ces tests parleront.
 */
export const REDACTIONS_FRANCHISE: readonly RedactionFranchise[] = [
  {
    // Rédaction en vigueur depuis toujours du point de vue de Bob : aucune pièce du dépôt n'est
    // antérieure, et l'art. 293 E, II est le droit applicable à toute date servie aujourd'hui.
    aPartirDu: '0001-01-01',
    mention: MENTION_FRANCHISE_BASE,
    source: 'art. 293 E, II du CGI ; BOFiP BOI-TVA-DECLA-40-10-20, I-B § 50',
  },
];

/**
 * Rédaction de la mention de franchise applicable à la date de la pièce — la plus récente dont la
 * date d'effet est atteinte. Le paramètre `asOf` de buildMentions est LU ICI, et nulle part
 * ailleurs : c'est le seul point du bloc mentions où une date peut changer une chaîne, et il ne
 * peut choisir qu'entre des rédactions SOURCÉES, jamais en inventer une.
 *
 * Passé CIBS_TOLERANCE_REFERENCES_CGI, la dernière rédaction connue serait tout de même renvoyée :
 * la mention de franchise est OBLIGATOIRE, et n'en imprimer aucune serait pire qu'en imprimer une
 * périmée. Ce trou-là n'est délibérément pas comblé par du code — aucun code ne peut inventer la
 * rédaction manquante — mais par l'alarme, qui sonne 180 jours avant cette date (échéance
 * `cibs-fin-tolerance-references-cgi`) pour qu'il ne soit jamais atteint.
 */
export function mentionFranchiseAu(asOf: DateOnly): string {
  const applicables = REDACTIONS_FRANCHISE.filter((r) => r.aPartirDu <= asOf);
  const retenue = applicables[applicables.length - 1] ?? REDACTIONS_FRANCHISE[0];
  // La table est non vide et ordonnée — deux invariants figés par le corpus. Le repli sur la
  // constante ne sert qu'à garantir qu'aucune régression ne puisse produire une facture SANS
  // mention de franchise, ce qui serait un manquement (art. 293 E, II du CGI).
  return retenue?.mention ?? MENTION_FRANCHISE_BASE;
}

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
   * Date de référence de la pièce (jour métier Paris au point d'appel). LUE, et à un seul endroit :
   * `mentionFranchiseAu` y choisit la rédaction de la mention de franchise parmi les rédactions
   * SOURCÉES en table. Aujourd'hui il n'y en a qu'une, donc la mention est la même à toute date —
   * c'est un fait de droit (la rédaction post-CIBS relève d'un décret non paru), pas un paramètre
   * mort : le jour où une deuxième rédaction entre en table, cette date décide laquelle s'imprime.
   * Aucune autre mention ne dépend d'une date, et aucune bascule n'est présumée.
   */
  asOf: DateOnly;
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
   * fiscale déduite d'une information que l'entreprise n'a pas donnée.
   *
   * OÙ LE BRANCHER LE JOUR OÙ LE RÉGLAGE EXISTE (case « J'ai opté pour le paiement de la TVA
   * d'après les débits ») : à UN SEUL point d'appel, l'émission de facture
   * (`application/billing/issue-invoice.ts`, là où les mentions sont figées). PAS au rendu du
   * devis (`backend.service.quoteMentions`) : l'art. 242 nonies A de l'annexe II au CGI énumère
   * les mentions des FACTURES, et l'exigibilité de la taxe — l'objet même de l'option — ne naît
   * d'aucun devis, qui n'est qu'une offre. Même traitement que les autres mentions du même
   * article portées ici (nature de l'opération, rabais/remises/ristournes).
   * Le champ est donc volontairement INERTE sur un devis : `kind === 'quote'` l'ignore même s'il
   * est passé, et un test gèle cette omission — passer `true` sur un devis n'imprime rien, ce
   * n'est ni un oubli ni un bug à « corriger ».
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
    // Bob n'imprime que la rédaction dont la base légale est certaine — ce que garantit
    // mentionFranchiseAu, qui ne sait choisir qu'entre des rédactions SOURCÉES (une seule à ce
    // jour, quelle que soit la date : d'où la stabilité de la mention, ci-dessous).
    // LA VEILLE N'EST PAS QU'UN COMMENTAIRE : l'échéance est ARMÉE dans veille-mentions-legales.ts
    // (test-sentinelle sur l'horloge réelle + signal au démarrage de l'API). Elle sonnera 90 jours
    // avant CIBS_TVA_ENTREE_EN_VIGUEUR et 180 jours avant CIBS_TOLERANCE_REFERENCES_CGI, avec le
    // geste à faire : ajouter la rédaction du décret à REDACTIONS_FRANCHISE. Pas avant, et jamais
    // les deux rédactions à la fois.
    m.push(mentionFranchiseAu(input.asOf));
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
  // aucun champ ne la porte encore, donc rien ne s'imprime aujourd'hui).
  // DEUX ARBITRAGES DE NATURE DIFFÉRENTE, à ne pas confondre :
  //  • franchise en base : préséance JURIDIQUEMENT CERTAINE, d'où le gate ci-dessous — le
  //    franchisé n'est pas redevable de la taxe (art. 293 B ; BOI-TVA-DECLA-10-10-20), il ne peut
  //    donc pas avoir opté pour le paiement de CETTE taxe d'après les débits. L'option est sans
  //    objet, la mention serait fausse ;
  //  • autoliquidation BTP : AUCUNE préséance n'est appliquée, et c'est un CHOIX DE PRODUIT
  //    documenté, pas une règle citée — aucun texte publié ne tranche la coexistence des deux
  //    mentions (vérifié le 28/07/2026). Là, l'entreprise EST redevable (elle collecte la TVA sur
  //    ses autres clients) et le 11° bis conditionne la mention au seul fait d'avoir opté. Bob
  //    imprime donc ce que chaque texte impose séparément plutôt que d'inventer une préséance.
  //    Le raisonnement complet et la source de l'arbitrage vivent dans le test qui le fige.
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
