import { type DateOnly } from '../../shared-kernel/time';
import { type LineInput } from '../billing/shared/line-item';
import { formatDateOnlyFr } from '../compliance/retractation';
import { type MaintenanceContractLine } from './maintenance-contract';
import {
  PRINTABLE_MAGNITUDES,
  PRINTABLE_SPELLED_NUMBERS,
  PRINTABLE_WORD_SEPARATORS,
  printableWordKey,
  readPrintableWord,
} from './printable-words';

/**
 * LA DÉSIGNATION IMPRIMÉE EST CONSTRUITE PAR LE DOMAINE — module PUR (zéro I/O, zéro état).
 *
 * ── LE PROBLÈME QU'ON A CESSÉ DE POURSUIVRE ────────────────────────────────────────────────
 *
 * Sept passes ont cherché l'extracteur parfait : celui qui séparerait, dans une phrase dictée,
 * le NOM d'un contrat des FAITS énoncés autour de lui. Il n'existe pas. Blanchir la FORME ferme
 * les symboles, les montants et les dates ; mais accepter un mot alphabétique inconnu exigerait
 * un dictionnaire du français — et refuserait « Dupont », « Eurotunnel », le nom de n'importe
 * quel client. Restent donc, irréductibles : les queues mutilées, les patronymes nus, les
 * participes de facturation (« payé trimestriellement »), les parties entières de taux coupées
 * sur la virgule (« majoré de 2 »).
 *
 * ── CE QU'ON SUPPRIME À LA PLACE : LA CONSÉQUENCE ──────────────────────────────────────────
 *
 * Jusqu'ici le nom du contrat était repris TEL QUEL comme libellé de la LIGNE de sa facture
 * annuelle. C'est ce COUPLAGE, et lui seul, qui transformait une imperfection d'extraction en
 * pièce légale fausse et archivée immuable. Un nom de contrat imparfait DANS L'APPLICATION se
 * corrige d'un tap sur la fiche ; une ligne de facture fausse, jamais.
 *
 * Ce tap EXISTE, et c'est ce qui rend le compromis tenable : « Renommer » sur la fiche contrat
 * (mobile) et l'outil vocal du même nom, tous deux adossés au use case
 * `UpdateMaintenanceContract`. Le nom qu'on y écrit n'est borné que par le domaine
 * (`contractLabelRefusal` : vide, longueur, caractères de contrôle) — l'artisan tape et relit,
 * il est sa propre garde. Ce module reste, lui, la seule autorité sur ce qui s'IMPRIME.
 *
 * La ligne ne porte donc plus le nom brut. Elle porte une DÉSIGNATION NORMALISÉE, composée ici
 * à partir de FAITS DÉJÀ VALIDÉS :
 *   · la NATURE de la prestation — « Contrat de maintenance », que le domaine connaît de toute
 *     facture rattachée à un contrat, sans que personne n'ait à la dire ;
 *   · la PÉRIODE couverte — déjà calculée par `deriveAnnualBillingDue` et déjà figée sur la
 *     pièce (colonnes `servicePeriod`, autorité de la garde d'émission).
 *
 * Le nom du contrat n'y apparaît QUE FILTRÉ : seuls survivent les mots que la forme sûre
 * (`printable-words.ts`) déclare SÛRS, et il est OMIS entièrement s'il n'en reste rien
 * d'exploitable. Une désignation sans nom reste une désignation complète et honnête :
 * « Contrat de maintenance — période du 12/10/2026 au 11/10/2027 » dit tout ce que la pièce
 * doit dire.
 *
 * ── POURQUOI AUCUN CHEMIN NE PEUT CONTOURNER ───────────────────────────────────────────────
 *
 * `isAnnualInvoiceDesignation` reconnaît EXACTEMENT ce que cette composition produit, et
 * `ComposeStandaloneInvoice` — porte UNIQUE de toute facture rattachée à un contrat — refuse
 * toute ligne qui n'en a pas la forme. Un chemin futur qui recopierait un nom dicté dans une
 * ligne de contrat serait refusé au domaine, pas relu par une revue.
 */

/** NATURE de la prestation — fait connu du domaine, jamais dit, jamais dicté. */
export const CONTRACT_INVOICE_DESIGNATION_NATURE = 'Contrat de maintenance';

/**
 * Séparateur des segments. Le tiret cadratin entouré d'espaces ne peut JAMAIS apparaître dans un
 * nom filtré : un jeton qui le contient n'est ni un mot alphabétique, ni un nombre court, ni un
 * connecteur — la forme sûre le jette. La désignation est donc relisible sans ambiguïté.
 */
const SEGMENT_SEPARATOR = ' — ';

/** Au-delà, ce n'est plus un nom mais une phrase : on préfère OMETTRE que mutiler. */
const MAX_NAME_WORDS = 8;

/** En dessous, ce n'est pas un nom mais un moignon (« A », « 12 ») — même plancher que la garde. */
const MIN_NAME_CHARS = 3;

/** Le segment de PÉRIODE, tel qu'il s'imprime et tel qu'on le relit (bornes INCLUSIVES). */
const PERIOD_SEGMENT = /^période du \d{2}\/\d{2}\/\d{4} au \d{2}\/\d{2}\/\d{4}$/u;

/** Bornes HUMAINES inclusives — celles que la pièce porte déjà en colonnes. */
export interface DesignationServicePeriod {
  readonly start: DateOnly;
  readonly end: DateOnly;
}

function periodSegment(period: DesignationServicePeriod): string {
  return `période du ${formatDateOnlyFr(period.start)} au ${formatDateOnlyFr(period.end)}`;
}

/**
 * Deux mots SÛRS qui, mis bout à bout, disent une SOMME : « 1 200 » (un groupe de milliers) et
 * « quinze mille » (un mot-nombre suivi d'une magnitude). Chacun est irréprochable seul ; leur
 * SUITE, elle, ne nomme rien — la lecture s'arrête AVANT le premier des deux.
 */
function ouvreUneSomme(words: readonly string[], index: number): boolean {
  const gauche = printableWordKey(words[index] ?? '');
  const droite = printableWordKey(words[index + 1] ?? '');
  if (droite.length === 0) return false;
  const millier = /^\d{1,3}$/u.test(gauche) && /^\d{3}$/u.test(droite);
  const enLettres = PRINTABLE_SPELLED_NUMBERS.has(gauche) && PRINTABLE_MAGNITUDES.has(droite);
  return millier || enLettres;
}

/**
 * FILTRE du nom : il ne garde que le DÉBUT SÛR du nom et s'ARRÊTE au premier mot douteux.
 *
 * Pourquoi s'arrêter plutôt que sauter le mot douteux et recoller la suite : un recollage
 * FABRIQUE une adjacence que personne n'a dite. « Entretien vitrines pour Monsieur Dupont »
 * deviendrait « Entretien vitrines Dupont » (le patronyme remonte au rang de nom de prestation),
 * et « Entretien non compris » deviendrait « Entretien compris » — le contraire de ce qui a été
 * dit. Un PRÉFIXE, lui, est toujours un morceau littéral de ce qui a été dit : il peut être
 * incomplet, jamais faux. Sur une pièce archivée immuable, l'incomplet se lit, le faux se paie.
 *
 * Ce qui reste est ensuite rogné de ses connecteurs de QUEUE — « … de » est la cicatrice d'une
 * découpe, pas un nom. Jamais de ceux de TÊTE : un nom a le droit de commencer par un article,
 * « Les Mille Étangs » en est un, et le rogner serait précisément la mutilation qu'on refuse
 * ailleurs. La règle du préfixe le garantit d'ailleurs : un connecteur en tête n'est jamais le
 * résidu d'un mot jeté avant lui, puisque rien n'est jeté avant lui.
 *
 * Rendu `null` s'il n'en reste rien d'exploitable : aucun mot plein, moins de trois caractères,
 * ou plus de mots qu'un nom n'en porte. Le résultat est IDEMPOTENT : le refiltrer ne le change
 * plus, ce qui est exactement ce qui permet de le RECONNAÎTRE sur une pièce composée.
 */
export function printableContractName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const words = raw.trim().split(PRINTABLE_WORD_SEPARATORS).filter((word) => word.length > 0);
  const kept: { word: string; nature: 'connecteur' | 'nombre' | 'mot' }[] = [];
  for (const [index, word] of words.entries()) {
    const reading = readPrintableWord(word, index === 0 ? null : (words[index - 1] ?? null));
    if (reading.nature === null) break;
    if (ouvreUneSomme(words, index)) break;
    kept.push({ word, nature: reading.nature });
  }
  while (kept.length > 0 && kept[kept.length - 1]?.nature === 'connecteur') kept.pop();
  // Un nom exige au moins un mot PLEIN : « 12 » ou « de la » ne nomment aucune prestation.
  if (!kept.some((entry) => entry.nature === 'mot')) return null;
  // Au-delà du plafond on OMET : tronquer à huit mots serait remutiler ce qu'on refuse de mutiler.
  if (kept.length > MAX_NAME_WORDS) return null;
  const joined = kept.map((entry) => entry.word).join(' ');
  // Une lettre ou deux ne nomment pas une prestation : mieux vaut la désignation sans nom.
  if (joined.length < MIN_NAME_CHARS) return null;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * COMPOSE la désignation imprimée d'une ligne de facture annuelle. Le nom passe par le filtre —
 * il n'existe aucun chemin pour l'écrire tel quel.
 */
export function composeAnnualInvoiceDesignation(input: {
  servicePeriod: DesignationServicePeriod;
  contractName?: string | null;
}): string {
  const name = printableContractName(input.contractName ?? null);
  return [
    CONTRACT_INVOICE_DESIGNATION_NATURE,
    ...(name !== null ? [name] : []),
    periodSegment(input.servicePeriod),
  ].join(SEGMENT_SEPARATOR);
}

/**
 * RECONNAÎT une désignation composée pour CETTE période. C'est la garde structurelle : un
 * libellé qui contiendrait un seul mot hors de la forme sûre ne se relit pas à l'identique,
 * donc ne passe pas. Aucune liste noire, aucune heuristique — la reconnaissance est l'inverse
 * exact de la composition.
 */
export function isAnnualInvoiceDesignation(
  label: string,
  servicePeriod: DesignationServicePeriod,
): boolean {
  const segments = label.split(SEGMENT_SEPARATOR);
  if (segments.length < 2 || segments.length > 3) return false;
  if (segments[0] !== CONTRACT_INVOICE_DESIGNATION_NATURE) return false;
  if (segments[segments.length - 1] !== periodSegment(servicePeriod)) return false;
  if (segments.length === 3) {
    const name = segments[1] ?? '';
    if (printableContractName(name) !== name) return false;
  }
  return true;
}

/**
 * REPORTE une désignation sur une AUTRE période — le geste « éditer la période de service du
 * brouillon » (§6.5). Sans lui, la ligne continuerait d'annoncer l'ancienne période pendant que
 * les colonnes de la pièce en portent une nouvelle : exactement le fait faux qu'on supprime.
 * Un libellé qui n'est pas une désignation (pièce composée avant cette règle) revient intact.
 */
export function reperiodAnnualInvoiceDesignation(
  label: string,
  servicePeriod: DesignationServicePeriod,
): string {
  const segments = label.split(SEGMENT_SEPARATOR);
  if (segments.length < 2 || segments.length > 3) return label;
  if (segments[0] !== CONTRACT_INVOICE_DESIGNATION_NATURE) return label;
  if (!PERIOD_SEGMENT.test(segments[segments.length - 1] ?? '')) return label;
  const name = segments.length === 3 ? (segments[1] ?? null) : null;
  return composeAnnualInvoiceDesignation({ servicePeriod, contractName: name });
}

/**
 * DÉSIGNATION d'un contrat dans une mention PERSISTÉE hors facture — objet et corps des rappels
 * de renouvellement, archivés en file de notification puis envoyés. Même principe que la ligne de
 * facture : ce qui part est composé par le domaine, ce qui vient de la parole n'entre que filtré.
 *
 * Le nom filtré est CITÉ entre guillemets ; quand il n'en reste rien, le contrat est identifié par
 * un fait déjà validé — la date d'ANNIVERSAIRE, celle-là même dont le rappel parle — plutôt que
 * par un fragment de phrase. Le résultat se substitue au nom dans les deux tournures employées :
 * « Contrat <mention> — … » et « Le contrat <mention> se reconduit… ».
 */
export function contractMentionSaid(input: {
  contractName?: string | null;
  anniversary: DateOnly;
}): string {
  const name = printableContractName(input.contractName ?? null);
  return name !== null
    ? `« ${name} »`
    : `de maintenance du ${formatDateOnlyFr(input.anniversary)}`;
}

/**
 * PROJECTION des lignes du contrat vers les lignes de la facture annuelle : les MONTANTS sont
 * repris au centime près (aucune conversion monétaire), la DÉSIGNATION est recomposée. Le nom de
 * la ligne du contrat sert de qualificatif quand il survit au filtre — c'est lui qui décrit ce
 * qui est facturé ; à défaut, le nom du contrat, filtré lui aussi ; à défaut, rien.
 */
export function annualInvoiceLineInputs(
  lines: readonly MaintenanceContractLine[],
  context: { servicePeriod: DesignationServicePeriod; contractLabel: string },
): LineInput[] {
  return lines.map((line) => ({
    label: composeAnnualInvoiceDesignation({
      servicePeriod: context.servicePeriod,
      contractName: printableContractName(line.label) ?? context.contractLabel,
    }),
    category: 'subscription' as const,
    qty: line.quantity,
    unitPriceHT: line.unitPriceHtCents,
    vatRate: line.vatRate,
  }));
}
