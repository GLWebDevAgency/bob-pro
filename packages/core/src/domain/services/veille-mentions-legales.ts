import { type DateOnly } from '../../shared-kernel/time';
import { CIBS_TVA_ENTREE_EN_VIGUEUR, CIBS_TOLERANCE_REFERENCES_CGI } from './build-mentions';

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
 * COMMENT L'ALARME SONNE VRAIMENT (deux canaux, aucun ne dépend d'un humain qui pense à regarder) :
 *  • un TEST-SENTINELLE (`veille-mentions-legales.sentinelle.test.ts`) évalue cette veille contre
 *    l'horloge RÉELLE et ÉCHOUE dès qu'une échéance entre dans son préavis. Il casse la CI de
 *    toute PR du dépôt, avec le geste à faire et les sources dans le message d'échec ;
 *  • un signal au DÉMARRAGE de l'API (`apps/api/src/main.ts`), qui journalise le même message —
 *    filet pour un déploiement de longue durée qui ne repasserait pas par la CI.
 *
 * COMMENT ÉTEINDRE L'ALARME (il n'y a pas d'autre chemin, c'est voulu) : traiter l'échéance, puis
 * mettre à jour son entrée ci-dessous. Soit le décret est paru et sa rédaction entre dans
 * `REDACTIONS_FRANCHISE` (build-mentions.ts) avec sa date d'effet, soit il ne l'est pas et on
 * repousse `echeance`/`verifieLe` en documentant la vérification qui vient d'être faite. Dans les
 * deux cas un humain a REGARDÉ le droit — c'est exactement ce qu'on veut acheter.
 * Zéro I/O, zéro horloge implicite : la date est toujours un paramètre.
 */

/** Une échéance de veille : une date, un geste, des sources, une date de dernière vérification. */
export interface EcheanceMentionLegale {
  /** Identifiant stable, cité dans le message d'alarme (sert d'ancre de recherche). */
  readonly id: string;
  /** Date à laquelle la règle change réellement. */
  readonly echeance: DateOnly;
  /** Combien de jours AVANT l'échéance l'alarme commence à sonner. */
  readonly preavisJours: number;
  /** Ce qui change en droit à cette date. */
  readonly objet: string;
  /** Le geste attendu — actionnable, pas une intention. */
  readonly aFaire: string;
  /** Sources primaires : c'est ce qui sera relu le jour où l'alarme sonne. */
  readonly sources: readonly string[];
  /** Date à laquelle ces faits ont été vérifiés pour la dernière fois. */
  readonly verifieLe: DateOnly;
}

export type NiveauVeille = 'preavis' | 'echue';

export interface AlerteVeilleMentions {
  readonly echeance: EcheanceMentionLegale;
  readonly niveau: NiveauVeille;
  /** Jours restants avant l'échéance — NÉGATIF si elle est déjà passée. */
  readonly joursRestants: number;
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
    // relire, la livrer et la déployer AVANT qu'une seule facture ne la fige.
    preavisJours: 90,
    objet:
      'Entrée en vigueur du transfert de la TVA dans le CIBS. L\'article de fond est connu (CGI '
      + 'art. 293 B, I, al. 1 → CIBS art. L. 223-3, table de concordance officielle), mais '
      + 'l\'OBLIGATION DE MENTION elle-même (art. 293 E, II du CGI) est déclassée au rang '
      + 'réglementaire : la rédaction à imprimer relèvera d\'un DÉCRET qui n\'était pas paru au '
      + '28/07/2026. Tant qu\'il ne l\'est pas, aucune rédaction CIBS ne doit être imprimée.',
    aFaire:
      'Vérifier la parution du décret portant la partie réglementaire TVA du CIBS. S\'il est paru : '
      + 'ajouter SA rédaction verbatim à REDACTIONS_FRANCHISE (build-mentions.ts) avec sa date '
      + 'd\'effet — jamais une rédaction déduite, même de impots.gouv.fr. S\'il n\'est pas paru : '
      + 'repousser `echeance` et `verifieLe` de cette entrée en documentant la vérification faite.',
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
      + '« article 293 B du CGI » n\'est plus admis : la mention de franchise DOIT porter la '
      + 'référence CIBS. C\'est la seule échéance après laquelle la mention imprimée aujourd\'hui '
      + 'devient réellement non conforme.',
    aFaire:
      'La rédaction CIBS doit être EN TABLE (REDACTIONS_FRANCHISE) et applicable avant cette date. '
      + 'Si le décret n\'est toujours pas paru à ce stade, ce n\'est plus une veille mais un point '
      + 'bloquant produit : escalader, ne jamais contourner en présumant une rédaction.',
    sources: [
      'Ordonnance n° 2025-1247 du 17/12/2025 — tolérance des anciennes références au CGI',
      'Ordonnance n° 2026-671 du 27/07/2026 (JORF n° 0174 du 28/07/2026) — report de la tolérance du 31/12/2027 au 30/06/2028',
      'Principe de correspondance automatique des références posé par l\'ordonnance 2025-1247 (rescrit BOI-RES-TVA-000253)',
    ],
    verifieLe: '2026-07-28',
  },
];

const MS_PER_DAY = 86_400_000;

function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

/**
 * Échéances qui SONNENT à la date donnée : celles entrées dans leur préavis (`preavis`) et celles
 * déjà passées (`echue`, jours restants ≤ 0). Vide = rien à faire, et c'est le cas nominal.
 * Fonction pure : la date est un paramètre, jamais l'horloge.
 */
export function veilleMentionsLegales(asOf: DateOnly): readonly AlerteVeilleMentions[] {
  return ECHEANCES_MENTIONS_LEGALES
    .map((echeance) => ({ echeance, joursRestants: daysBetween(asOf, echeance.echeance) }))
    .filter(({ echeance, joursRestants }) => joursRestants <= echeance.preavisJours)
    .map(({ echeance, joursRestants }): AlerteVeilleMentions => ({
      echeance,
      joursRestants,
      niveau: joursRestants <= 0 ? 'echue' : 'preavis',
    }))
    .sort((a, b) => a.echeance.echeance.localeCompare(b.echeance.echeance));
}

/**
 * Message d'alarme — écrit pour être lu par quelqu'un qui découvre le sujet dans un échec de CI
 * ou un log de démarrage : ce qui se passe, ce qu'il faut faire, où sont les textes, et l'interdit
 * qui prime sur tout le reste (ne rien fabriquer).
 */
export function messageVeilleMentions(alertes: readonly AlerteVeilleMentions[]): string {
  if (alertes.length === 0) return 'Veille mentions légales : aucune échéance en préavis ni échue.';
  const lignes = alertes.map((a) => {
    const etat = a.niveau === 'echue'
      ? a.joursRestants === 0
        ? 'ÉCHUE AUJOURD’HUI'
        : `ÉCHUE depuis ${-a.joursRestants} jour(s)`
      : `dans ${a.joursRestants} jour(s)`;
    return [
      `• [${etat}] ${a.echeance.id} — échéance ${a.echeance.echeance}`,
      `    Objet     : ${a.echeance.objet}`,
      `    À FAIRE   : ${a.echeance.aFaire}`,
      `    Sources   : ${a.echeance.sources.join(' | ')}`,
      `    Vérifié le: ${a.echeance.verifieLe}`,
    ].join('\n');
  });
  return [
    'VEILLE MENTIONS LÉGALES — le décret de formulation CIBS doit être vérifié et la mention mise à jour (voir sources).',
    'Ce n’est PAS un bug : c’est l’alarme datée du bloc mentions qui sonne. Les mentions sont figées',
    'à l’émission — une pièce émise sur une rédaction fausse le reste pour toujours. Ne fabriquez',
    'AUCUNE rédaction non sourcée pour faire taire ce message : traitez l’échéance, ou repoussez-la',
    'dans ECHEANCES_MENTIONS_LEGALES (veille-mentions-legales.ts) en documentant la vérification.',
    '',
    ...lignes,
  ].join('\n');
}
