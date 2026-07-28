import { type DateOnly, addDays, isValidDateOnly } from '../../shared-kernel/time';
import {
  CIBS_TVA_ENTREE_EN_VIGUEUR,
  CIBS_TOLERANCE_REFERENCES_CGI,
  REFERENCES_CGI_IMPRIMEES,
} from './build-mentions';

/**
 * VEILLE DES MENTIONS LÉGALES — l'alarme datée du bloc mentions.
 *
 * POURQUOI CE MODULE EXISTE. Une mention légale est FIGÉE à l'émission (Invoice.legalMentions) :
 * une pièce émise avec une rédaction devenue fausse le reste pour toujours. Deux défauts
 * SYMÉTRIQUES nous guettent donc, et ce module tient la ligne de crête entre les deux :
 *  1. la bascule automatique présumée — l'ancien code basculait en dur au 01/09/2026 vers une
 *     rédaction « CIBS » sans base légale, sur une date depuis reportée : il aurait imprimé du
 *     faux, en silence, à partir d'un jour donné. Ce défaut a été retiré ;
 *  2. le silence total — retirer la bascule sans rien mettre à la place laisse une échéance
 *     réelle (01/01/2027, puis 30/06/2028) documentée dans des commentaires que PERSONNE ne relit
 *     le jour venu. C'est le défaut que ce module traite.
 *
 * CE QUE CE MODULE FAIT, ET SURTOUT CE QU'IL NE FAIT PAS. Il n'émet AUCUNE mention et n'en change
 * aucune : il ne connaît que des DATES, un geste à faire, et des sources. C'est un réveil, jamais
 * une décision juridique — la rédaction post-bascule est INCONNUE (décret non paru) et Bob ne la
 * fabriquera pas.
 *
 * ————————————————————————————————————————————————————————————————————————————————————————————————
 * LE RÉGIME D'ALARME — DEUX ÉTAGES, PARCE QU'UNE ALARME PERMANENTE EST UNE ALARME MORTE.
 *
 * Le dispositif précédent était binaire : silencieux, puis BLOQUANT pour tout le dépôt pendant les
 * 90 jours du préavis. Une CI rouge pendant trois mois sur des PR qui n'ont rien à voir se termine
 * toujours de la même façon : quelqu'un désactive le test — et une alarme qu'on désactive ne
 * protège plus personne. D'où trois régimes, et un seul qui bloque :
 *
 *  • ÉTAGE 1 — PRÉAVIS : régime `avertissement`. L'échéance approche. Le travail continue, mais la
 *    veille est IMPOSSIBLE À RATER : annotation GitHub + résumé de run sur chaque PR et chaque push
 *    de main (`apps/api/scripts/veille-mentions-legales-ci.mjs`, étape du job `verify`), et journal
 *    d'avertissement au démarrage de l'API (`apps/api/src/main.ts`). Rien n'échoue.
 *  • ÉTAGE 2 — ÉCHÉANCE ATTEINTE (`joursRestants <= 0`) : régime `blocage`. Le droit a changé. Le
 *    test-sentinelle échoue et la CI casse pour de bon, sur toute PR du dépôt. Aucun apaisement
 *    n'est possible à cet étage — c'est le point de non-retour, il ne se négocie pas.
 *  • APAISÉ : régime `information`. Le préavis a été traité par une VÉRIFICATION DATÉE récente
 *    (voir ci-dessous). L'alarme se tait, mais reste affichée en clair dans le résumé de CI avec sa
 *    date de ré-armement : un apaisement invisible serait un interrupteur déguisé.
 *
 * APAISER LE PRÉAVIS — UN SEUL GESTE, DATÉ ET REVUABLE EN DIFF. Mettre `verifieLe` à la date du
 * jour dans l'entrée concernée, ce qui affirme : « j'ai vérifié le décret le JJ/MM/AAAA, il n'est
 * toujours pas paru ». L'alarme se tait RE_ARMEMENT_VERIFICATION_JOURS jours, puis se ré-arme
 * SEULE. Il n'existe aucun autre chemin, et c'est délibéré : pas de variable d'environnement, pas
 * de skip, pas de commentaire magique, pas de drapeau. Un contournement non tracé serait un défaut,
 * pas une fonctionnalité — la seule trace acceptable est une ligne de diff signée par un humain qui
 * a REGARDÉ le droit, c'est exactement ce qu'on cherche à acheter.
 *
 * CE QUE LE GESTE D'APAISEMENT N'AUTORISE JAMAIS :
 *  • déplacer `echeance` — cette date n'est pas à nous, elle vient d'une ordonnance et vit dans une
 *    constante sourcée de build-mentions.ts. Elle ne bouge que si un texte la bouge, avec sa source ;
 *  • fabriquer une rédaction de mention pour faire taire l'alarme. Une pièce émise sur une rédaction
 *    présumée reste fausse pour toujours : mieux vaut une CI rouge qu'une facture fausse.
 *
 * Zéro I/O, zéro horloge implicite : la date est toujours un paramètre.
 */

/** Une échéance de veille : une date, un geste, des sources, une date de dernière vérification. */
export interface EcheanceMentionLegale {
  /** Identifiant stable, cité dans le message d'alarme (sert d'ancre de recherche). */
  readonly id: string;
  /** Date à laquelle la règle change réellement. Vient d'une constante sourcée, jamais d'ici. */
  readonly echeance: DateOnly;
  /** Combien de jours AVANT l'échéance l'alarme entre en préavis (étage 1, non bloquant). */
  readonly preavisJours: number;
  /** Ce qui change en droit à cette date. */
  readonly objet: string;
  /** Le geste attendu — actionnable, pas une intention. */
  readonly aFaire: string;
  /** Sources primaires : c'est ce qui sera relu le jour où l'alarme sonne. */
  readonly sources: readonly string[];
  /**
   * Date à laquelle ces faits ont été vérifiés pour la dernière fois. SEUL champ que le geste
   * d'apaisement autorise à changer : le mettre à jour affirme une vérification faite ce jour-là.
   */
  readonly verifieLe: DateOnly;
}

/** Où en est une échéance : apaisée par une vérification récente, en préavis, ou atteinte. */
export type NiveauVeille = 'apaisee' | 'preavis' | 'echue';

/**
 * Ce que l'alarme EXIGE du canal qui la porte. C'est le domaine qui décide de bloquer ou non —
 * jamais la CI, jamais un appelant : sinon deux canaux finiraient par ne pas bloquer au même jour.
 */
export type RegimeAlarme = 'information' | 'avertissement' | 'blocage';

export interface AlerteVeilleMentions {
  readonly echeance: EcheanceMentionLegale;
  readonly niveau: NiveauVeille;
  readonly regime: RegimeAlarme;
  /** Jours restants avant l'échéance — NÉGATIF si elle est déjà passée. */
  readonly joursRestants: number;
  /** Jours écoulés depuis `verifieLe`. Négatif = date de vérification postérieure à `asOf`. */
  readonly joursDepuisVerification: number;
  /** Jour où le préavis se ré-arme si rien n'est fait. Null hors de l'état apaisé. */
  readonly reArmementLe: DateOnly | null;
}

/**
 * Durée de l'apaisement : au-delà, le préavis se ré-arme SEUL, sans que personne ait à y penser.
 * Court exprès — un mois est le temps qu'il faut pour qu'une non-parution redevienne une question
 * ouverte, pas le temps qu'il faut pour l'oublier.
 */
export const RE_ARMEMENT_VERIFICATION_JOURS = 30;

/** Cette alerte doit-elle faire échouer la CI ? Le domaine répond, les canaux obéissent. */
export function estBloquante(alerte: AlerteVeilleMentions): boolean {
  return alerte.regime === 'blocage';
}

/** Cette alerte doit-elle être MONTRÉE ? (préavis ou échéance atteinte — pas un apaisement.) */
export function sonne(alerte: AlerteVeilleMentions): boolean {
  return alerte.regime !== 'information';
}

/**
 * Énumération des mentions qui citent un article du CGI, composée depuis l'inventaire vérifié
 * (REFERENCES_CGI_IMPRIMEES) plutôt que recopiée : une liste recopiée finit toujours par ne plus
 * décrire le code. Chaque ligne porte sa correspondance CIBS, ou dit qu'elle est INCONNUE.
 */
function inventaireDesReferencesCgi(): string {
  return REFERENCES_CGI_IMPRIMEES
    .map((r) => {
      const suite = r.concordance.statut === 'certaine'
        ? `→ ${r.concordance.article} (CERTAIN : ${r.concordance.source})`
        : `→ correspondance CIBS INCONNUE au ${r.concordance.constatLe} (${r.concordance.constat})`;
      return `art. ${r.article} du CGI [${r.mention}] ${suite}`;
    })
    .join(' ⏐ ');
}

/**
 * Le registre. Les dates ne sont JAMAIS réécrites ici en dur : elles viennent des constantes
 * sourcées de `build-mentions.ts`, seul endroit où le report du 01/09/2026 au 01/01/2027 (et du
 * 31/12/2027 au 30/06/2028) est documenté avec son ordonnance. Une date en double finirait par
 * diverger de l'autre.
 */
export const ECHEANCES_MENTIONS_LEGALES: readonly EcheanceMentionLegale[] = [
  {
    id: 'cibs-decret-formulation-franchise',
    echeance: CIBS_TVA_ENTREE_EN_VIGUEUR,
    // Un trimestre : le délai réaliste pour lire un décret, décider une rédaction, la faire
    // relire, la livrer et la déployer AVANT qu'une seule facture ne la fige. Non bloquant
    // (étage 1) : trois mois de CI rouge feraient désactiver l'alarme avant qu'elle ne serve.
    preavisJours: 90,
    objet:
      'Entrée en vigueur du transfert de la TVA dans le CIBS. L\'article de fond est connu (CGI '
      + 'art. 293 B, I, al. 1 → CIBS art. L. 223-3, table de concordance officielle), mais '
      + 'l\'OBLIGATION DE MENTION elle-même (art. 293 E, II du CGI) est déclassée au rang '
      + 'réglementaire : la rédaction à imprimer relèvera d\'un DÉCRET qui n\'était pas paru au '
      + '28/07/2026. Tant qu\'il ne l\'est pas, aucune rédaction CIBS ne doit être imprimée.',
    aFaire:
      'Vérifier la parution du décret portant la partie réglementaire TVA du CIBS. S\'IL EST PARU : '
      + 'ajouter SA rédaction verbatim à REDACTIONS_FRANCHISE (build-mentions.ts) avec sa date '
      + 'd\'effet — jamais une rédaction déduite, même de impots.gouv.fr. S\'IL N\'EST PAS PARU : '
      + 'mettre `verifieLe` de cette entrée à la date du jour, et RIEN D\'AUTRE — le préavis se tait '
      + '30 jours puis se ré-arme seul. Ne jamais déplacer `echeance` : cette date vient d\'une '
      + 'ordonnance (constante CIBS_TVA_ENTREE_EN_VIGUEUR), elle ne bouge que si un texte la bouge.',
    sources: [
      'Ordonnance n° 2025-1247 du 17/12/2025 (JORF du 20/12/2025) — crée le livre II du CIBS (art. L200-1 à L246-12), recodification à droit constant',
      'Ordonnance n° 2026-671 du 27/07/2026 (JORF n° 0174 du 28/07/2026) — reporte le transfert du 01/09/2026 au 01/01/2027',
      'Table de concordance officielle publiée avec le JO n° 0298 du 20/12/2025 — « CGI art. 293 B, I, al. 1 → L. 223-3 » ; art. 293 E, II porté « déclassé »',
      'Art. 293 E, II du CGI — rédaction actuellement prescrite : « TVA non applicable, article 293 B du CGI »',
    ],
    verifieLe: '2026-07-28',
  },
  {
    id: 'cibs-fin-tolerance-references-cgi',
    echeance: CIBS_TOLERANCE_REFERENCES_CGI,
    // Six mois : passée cette date, la référence CGI n'est plus admise sur une facture et Bob
    // n'aurait AUCUNE rédaction licite à imprimer. C'est la seule échéance qui peut rendre une
    // pièce non conforme — elle mérite le préavis le plus long.
    preavisJours: 180,
    objet:
      'Fin de la tolérance des anciennes références au CGI sur les factures. Au-delà de cette date, '
      + 'AUCUNE référence « … du CGI » n\'est plus admise sur une pièce : toutes les mentions qui en '
      + 'citent une doivent porter leur référence CIBS. C\'est la seule échéance après laquelle les '
      + 'mentions imprimées aujourd\'hui deviennent réellement non conformes — et elle ne concerne '
      + 'pas que la franchise en base.',
    aFaire:
      'Basculer TOUTES les mentions qui citent le CGI, pas seulement la franchise. Inventaire '
      + 'exhaustif vérifié par la sonde du corpus (REFERENCES_CGI_IMPRIMEES, build-mentions.ts) — '
      + inventaireDesReferencesCgi()
      + '. Pour chacune : relever la référence CIBS dans la table de concordance OFFICIELLE puis '
      + 'mettre à jour la mention avec sa source ; une correspondance marquée INCONNUE se relève, '
      + 'elle ne se déduit jamais de celle d\'un autre article. Cas particulier de la franchise : '
      + 'l\'article de fond est connu (L. 223-3) mais la RÉDACTION relève d\'un décret — elle entre '
      + 'par REDACTIONS_FRANCHISE, verbatim, ou pas du tout. Hors périmètre, et c\'est vérifié : '
      + 'l\'option pour les débits (MENTION_OPTION_DEBITS) n\'imprime aucune référence d\'article. '
      + 'Si un décret manque encore à ce stade, ce n\'est plus une veille mais un point bloquant '
      + 'produit : escalader, ne jamais contourner en présumant une rédaction.',
    sources: [
      'Ordonnance n° 2025-1247 du 17/12/2025 — tolérance des anciennes références au CGI',
      'Ordonnance n° 2026-671 du 27/07/2026 (JORF n° 0174 du 28/07/2026) — report de la tolérance du 31/12/2027 au 30/06/2028',
      'Principe de correspondance automatique des références posé par l\'ordonnance 2025-1247 (rescrit BOI-RES-TVA-000253)',
      'Table de concordance officielle publiée avec le JO n° 0298 du 20/12/2025 — une seule ligne en est citée dans ce dépôt (293 B) : les autres correspondances restent à relever',
    ],
    verifieLe: '2026-07-28',
  },
];

const MS_PER_DAY = 86_400_000;

/**
 * FAIL-CLOSED. Une DateOnly illisible faisait autrefois renvoyer NaN à `daysBetween` : le filtre
 * `joursRestants <= preavisJours` est FAUX pour NaN, donc l'échéance disparaissait du résultat sans
 * erreur ni trace — une veille légale qui se tait sur une entrée douteuse est exactement le
 * contraire de sa raison d'être. On rejette bruyamment, plutôt que d'éteindre l'alarme en silence.
 */
function jourCertain(role: string, valeur: DateOnly): DateOnly {
  if (!isValidDateOnly(valeur)) {
    throw new TypeError(
      `Veille mentions légales : ${role} n'est pas une date valide (reçu « ${valeur} »). `
      + 'Attendu « AAAA-MM-JJ » calendairement possible. Ce rejet est VOLONTAIRE : une date '
      + 'illisible ferait disparaître l\'échéance du résultat sans erreur, et l\'alarme se tairait '
      + 'précisément le jour où elle devrait sonner.',
    );
  }
  return valeur;
}

/** Écart en jours entre deux DateOnly DÉJÀ validées par `jourCertain`. */
function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

function qualifier(
  echeance: EcheanceMentionLegale,
  joursRestants: number,
  joursDepuisVerification: number,
): { niveau: NiveauVeille; regime: RegimeAlarme; reArmementLe: DateOnly | null } {
  // Étage 2 d'abord, et sans condition : passé l'échéance, aucune vérification récente ne rattrape
  // le droit. L'apaisement ne s'applique QU'AU préavis — sinon il deviendrait l'interrupteur qu'on
  // s'interdit précisément de construire.
  if (joursRestants <= 0) return { niveau: 'echue', regime: 'blocage', reArmementLe: null };
  // Une vérification postérieure à la date d'évaluation (post-datée) n'apaise rien : fail-closed
  // là aussi, sinon on pourrait s'offrir un silence de plusieurs mois en une seule ligne.
  const apaisee = joursDepuisVerification >= 0
    && joursDepuisVerification < RE_ARMEMENT_VERIFICATION_JOURS;
  if (apaisee) {
    return {
      niveau: 'apaisee',
      regime: 'information',
      reArmementLe: addDays(echeance.verifieLe, RE_ARMEMENT_VERIFICATION_JOURS),
    };
  }
  return { niveau: 'preavis', regime: 'avertissement', reArmementLe: null };
}

/**
 * Évaluation d'un registre QUELCONQUE à une date donnée — le calcul, séparé de la donnée.
 *
 * Exportée pour une raison précise : le registre de production est une constante (c'est voulu, le
 * geste d'apaisement doit se relire en diff), et sans ce point d'entrée on ne pourrait pas prouver
 * le comportement de l'apaisement autrement qu'en muant le registre réel. On teste donc le
 * MÉCANISME sur des registres simulés, et le registre réel garde son immuabilité.
 * En production il n'existe qu'un seul appelant : `veilleMentionsLegales`.
 */
export function evaluerEcheances(
  echeances: readonly EcheanceMentionLegale[],
  asOf: DateOnly,
): readonly AlerteVeilleMentions[] {
  const jour = jourCertain('la date d’évaluation (asOf)', asOf);
  return echeances
    .map((echeance) => ({
      echeance,
      joursRestants: daysBetween(
        jour,
        jourCertain(`l’échéance « ${echeance.id} »`, echeance.echeance),
      ),
      joursDepuisVerification: daysBetween(
        jourCertain(`la date de vérification de « ${echeance.id} »`, echeance.verifieLe),
        jour,
      ),
    }))
    .filter(({ echeance, joursRestants }) => joursRestants <= echeance.preavisJours)
    .map(({ echeance, joursRestants, joursDepuisVerification }): AlerteVeilleMentions => ({
      echeance,
      joursRestants,
      joursDepuisVerification,
      ...qualifier(echeance, joursRestants, joursDepuisVerification),
    }))
    .sort((a, b) => a.echeance.echeance.localeCompare(b.echeance.echeance));
}

/**
 * Échéances dont la fenêtre est OUVERTE à la date donnée, chacune avec son régime : `information`
 * (apaisée par une vérification récente), `avertissement` (préavis, étage 1) ou `blocage`
 * (échéance atteinte, étage 2). Vide = rien à faire, et c'est le cas nominal.
 *
 * Les apaisées sont RENVOYÉES, pas filtrées : c'est au canal de décider ce qu'il en fait. Le
 * rapport de CI les affiche avec leur date de ré-armement (un apaisement invisible serait un
 * interrupteur déguisé) ; le démarrage de l'API n'en parle pas (`sonne`). Fonction pure : la date
 * est un paramètre, jamais l'horloge.
 */
export function veilleMentionsLegales(asOf: DateOnly): readonly AlerteVeilleMentions[] {
  return evaluerEcheances(ECHEANCES_MENTIONS_LEGALES, asOf);
}

/** L'état en tête de ligne : le régime d'abord, parce que c'est la seule question du lecteur. */
function etatLisible(alerte: AlerteVeilleMentions): string {
  if (alerte.niveau === 'echue') {
    return alerte.joursRestants === 0
      ? 'ÉCHUE AUJOURD’HUI — BLOQUANT'
      : `ÉCHUE depuis ${-alerte.joursRestants} jour(s) — BLOQUANT`;
  }
  if (alerte.niveau === 'apaisee') {
    return `APAISÉE jusqu’au ${alerte.reArmementLe} — échéance dans ${alerte.joursRestants} jour(s)`;
  }
  return `PRÉAVIS — dans ${alerte.joursRestants} jour(s), non bloquant`;
}

/**
 * Message d'alarme — écrit pour être lu par quelqu'un qui découvre le sujet dans un résumé de CI ou
 * un log de démarrage : ce qui se passe, à quel étage, ce qu'il faut faire, où sont les textes, et
 * l'interdit qui prime sur tout le reste (ne rien fabriquer).
 */
export function messageVeilleMentions(alertes: readonly AlerteVeilleMentions[]): string {
  if (alertes.length === 0) return 'Veille mentions légales : aucune échéance en préavis ni échue.';
  const bloquantes = alertes.filter(estBloquante);
  const lignes = alertes.map((a) => {
    const detail = [
      `• [${etatLisible(a)}] ${a.echeance.id} — échéance ${a.echeance.echeance}`,
      `    Objet     : ${a.echeance.objet}`,
      `    À FAIRE   : ${a.echeance.aFaire}`,
      `    Sources   : ${a.echeance.sources.join(' | ')}`,
      `    Vérifié le: ${a.echeance.verifieLe} (il y a ${a.joursDepuisVerification} jour(s))`,
    ];
    if (a.niveau === 'apaisee') {
      detail.push(
        `    Apaisée   : vérification du ${a.echeance.verifieLe} — l’alarme se ré-arme SEULE le ${a.reArmementLe}.`,
      );
    }
    return detail.join('\n');
  });
  const entete = bloquantes.length > 0
    ? 'VEILLE MENTIONS LÉGALES — ÉTAGE 2, BLOQUANT : une échéance est ATTEINTE, '
      + 'le décret de formulation CIBS doit être vérifié et la mention mise à jour (voir sources). '
      + 'Il n’existe aucun apaisement à cet étage : seul le traitement de l’échéance rend la CI verte.'
    : alertes.some(sonne)
      ? 'VEILLE MENTIONS LÉGALES — ÉTAGE 1, PRÉAVIS (non bloquant) : le décret de formulation CIBS '
        + 'doit être vérifié et la mention mise à jour (voir sources). Rien n’est cassé, rien ne '
        + 'vous empêche de livrer — mais l’échéance approche, et elle, elle bloquera.'
      : 'VEILLE MENTIONS LÉGALES — APAISÉE : une échéance est dans sa fenêtre de préavis, mais elle '
        + 'a été vérifiée récemment (voir la date ci-dessous). Rien à faire aujourd’hui ; l’alarme '
        + 'se ré-arme SEULE à la date indiquée. Cette ligne est affichée exprès : un apaisement '
        + 'qu’on ne voit pas est un interrupteur déguisé.';
  return [
    entete,
    'Ce n’est PAS un bug : c’est l’alarme datée du bloc mentions qui sonne. Les mentions sont figées',
    'à l’émission — une pièce émise sur une rédaction fausse le reste pour toujours. Ne fabriquez',
    'AUCUNE rédaction non sourcée pour faire taire ce message : mieux vaut une CI rouge qu’une',
    'facture fausse.',
    '',
    'APAISER LE PRÉAVIS — un seul geste, et il est daté : mettre `verifieLe` de l’entrée concernée',
    `à la date du jour dans ECHEANCES_MENTIONS_LEGALES (veille-mentions-legales.ts), ce qui affirme`,
    '« j’ai vérifié, le décret n’est toujours pas paru ». L’alarme se tait alors',
    `${RE_ARMEMENT_VERIFICATION_JOURS} jours, puis se ré-arme SEULE. Aucune variable d’environnement,`,
    'aucun skip, aucun commentaire magique : un contournement non tracé serait un défaut. Et ne',
    'déplacez jamais `echeance` — cette date vient d’une ordonnance, pas de nous.',
    '',
    ...lignes,
  ].join('\n');
}
