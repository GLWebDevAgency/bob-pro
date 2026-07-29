import {
  PRINTABLE_MAGNITUDES,
  PRINTABLE_SPELLED_NUMBERS,
  PRINTABLE_WORD_SEPARATORS,
  type PrintableWordDoubt,
  type PrintableWordReading,
  printableDiscriminantTokens,
  printableStem,
  printableWordKey,
  readPrintableWord,
} from '@bob/core';

/**
 * §2.7 — GARDE du LIBELLÉ de contrat. Module PUR (zéro I/O, zéro état), placé en SORTIE
 * d'extraction et AVANT toute proposition de mutation.
 *
 * ── CE QUE CETTE GARDE PROTÈGE, ET CE QU'ELLE NE PROTÈGE PLUS ──────────────────────────────
 *
 * Elle ne protège PLUS la pièce légale. C'est désormais le domaine qui s'en charge : la ligne
 * d'une facture annuelle ne porte plus le nom du contrat mais une DÉSIGNATION COMPOSÉE (nature
 * de la prestation + période couverte, nom seulement filtré) — @bob/core,
 * `annual-invoice-designation.ts` —, et `ComposeStandaloneInvoice` refuse structurellement toute
 * ligne de contrat qui n'en aurait pas la forme. Aucun texte dicté n'atteint plus une pièce.
 *
 * Elle sert maintenant la QUALITÉ DU NOM AFFICHÉ DANS L'APPLICATION : le nom qu'on lit sur la
 * fiche, dans la liste, dans les alertes de renouvellement. Un nom pollué s'y corrige d'un tap
 * (« Renommer » sur la fiche) ; c'est pourquoi la garde peut se permettre d'être une QUESTION
 * plutôt qu'un mur. Elle reste néanmoins fail-closed sur les doutes FATAUX — montant, date,
 * attribution — parce qu'un nom qui ANNONCE un fait faux trompe le pro lui-même, et qu'aucune
 * relecture ne rattrape ce qu'on ne remarque pas.
 *
 * ── OÙ CETTE GARDE NE S'APPLIQUE PAS, ET POURQUOI C'EST LA MÊME RÈGLE ──────────────────────
 *
 * Le tap qu'elle invoque existe : « Renommer » sur la fiche contrat (mobile), adossé au use case
 * `UpdateMaintenanceContract`. Ce champ-là ne repasse PAS par cette garde — il n'est borné que
 * par le domaine (`contractLabelRefusal` : vide, longueur, caractères de contrôle). Ce n'est pas
 * une exception, c'est la conclusion de la règle des deux sévérités poussée d'un cran : ici, ce
 * n'est ni une extraction ni un modèle qui écrit le nom, c'est l'artisan, et il le RELIT. Lui
 * appliquer le refus fermerait le seul remède que cette garde promet — le nom qu'elle vient de
 * refuser serait précisément celui que le pro ne pourrait plus écrire, et l'aiguillage
 * « extrait/nommé » deviendrait un cul-de-sac de plus.
 *
 * L'outil vocal `renommer_contrat`, lui, passe par la sévérité `'nomme'` : le nom y arrive par
 * une transcription ou par un modèle, et personne ne l'a relu.
 *
 * ── LA RÈGLE : LA CHARGE DE LA PREUVE EST RENVERSÉE ────────────────────────────────────────
 *
 * Tant qu'on ÉNUMÈRE ce qui est INTERDIT dans un nom de contrat, on énumère les tournures du
 * français — un ensemble INFINI. Ce qu'un nom PEUT contenir est, lui, FINI et vérifiable : des
 * mots, de petits nombres, une poignée de connecteurs. Cette FORME SÛRE vit dans le DOMAINE
 * (`printable-words.ts`, @bob/core) parce que c'est le domaine qui imprime : une garde et une
 * composition qui divergeraient sur la définition d'un mot sûr laisseraient un trou entre elles.
 * La garde y ajoute ce qui ne se lit qu'au niveau du LIBELLÉ ENTIER : le moignon, la découpe, la
 * longueur, la somme que deux mots sûrs forment à eux deux, et le nom d'un client RÉEL du
 * fichier — indevinable sans l'hôte.
 *
 * ── DEUX SÉVÉRITÉS, UNE SEULE RÈGLE ────────────────────────────────────────────────────────
 *
 *  · `'extrait'` — Bob a DÉDUIT le nom d'un segment parlé : TOUS les doutes refusent.
 *  · `'nomme'`  — le pro a NOMMÉ le contrat (forme guillemetée), ou un modèle a rempli
 *    l'argument : le libellé REPASSE PAR LA FORME (aucun montant, aucune date, aucun morceau
 *    de phrase ne peut entrer par cette porte) mais les mots que le métier emploie
 *    légitimement — « annuel », « visites », le nom d'un client — cessent de refuser. Sans
 *    cette nuance, un nom légitime deviendrait un CUL-DE-SAC : le pro le redirait, la garde le
 *    refuserait encore, et ce contrat ne naîtrait plus jamais à la voix.
 *
 * ── INDÉPENDANCE ASSUMÉE ───────────────────────────────────────────────────────────────────
 *
 * La garde ne partage AUCUN lexique, AUCUNE expression régulière et AUCUN utilitaire avec
 * l'extracteur (`contract-command.ts`) : une garde qui hériterait des angles morts de ce
 * qu'elle surveille ne garderait rien.
 */

/** Ce qui rend un libellé douteux. Un seul doute bloquant suffit à refuser (fail-closed).
 *  Les doutes de MOT viennent du domaine ; ceux qui suivent ne se lisent qu'au niveau du
 *  libellé ENTIER, ou exigent le fichier client de l'hôte. */
export type ContractLabelDoubt =
  | PrintableWordDoubt
  /** Rien, trop court, ou pas un seul mot plein : ce n'est pas un nom. */
  | 'vide'
  /** Le libellé s'ARRÊTE sur un connecteur — cicatrice d'une découpe (« … à raison d' »). */
  | 'coupe'
  /** Plus de mots qu'un nom de contrat n'en porte — c'est une phrase, pas un nom. */
  | 'longueur'
  /** Jeton significatif d'un nom de client CONNU de l'hôte. */
  | 'client';

/**
 * Provenance du libellé — elle décide de la sévérité, jamais l'appelant au petit bonheur :
 *  · `'extrait'` : Bob a DÉDUIT le nom d'un segment de phrase (il peut s'être trompé) ;
 *  · `'nomme'`   : le pro a NOMMÉ le contrat (forme guillemetée), ou un modèle a rempli
 *    l'argument `label` — dans les deux cas quelqu'un a délibérément écrit ce nom.
 */
export type ContractLabelGuardMode = 'extrait' | 'nomme';

export interface ContractLabelVerdict {
  /** Vrai si le libellé est assez propre pour NOMMER le contrat dans l'app. Faux ⇒ Bob POSE
   *  LA QUESTION (jamais un blocage définitif : le nom reste modifiable sur la fiche). */
  readonly accepted: boolean;
  /** TOUS les doutes relevés, du plus grave au moins grave — jamais un seul motif caché. */
  readonly doubts: readonly ContractLabelDoubt[];
  /** Les seuls doutes qui REFUSENT dans le mode demandé (sous-ensemble de `doubts`). */
  readonly blocking: readonly ContractLabelDoubt[];
  /** Fragment EXACT du libellé qui a déclenché le doute le plus grave — Bob le CITE au pro. */
  readonly fragment: string | null;
}

export interface ContractLabelGuardOptions {
  /** Noms des clients RÉELS du tenant : sans eux, « Carrefour » reste un mot comme un autre. */
  readonly customerNames?: readonly string[];
  /** Défaut `'extrait'` : le mode le plus strict — le doute par défaut est l'objet de la garde. */
  readonly mode?: ContractLabelGuardMode;
}

/**
 * LONGUEUR — un nom de contrat tient en quelques mots. Les libellés métier réellement dictés du
 * corpus (`contract-label-invariants.test.ts`) tiennent en 2 à 5 mots (« Nettoyage à sec hall B »
 * est le plus long) ; les formes déterminées les plus longues qu'on rencontre en clientèle
 * (« Contrat d'entretien des espaces verts ») en font 6. Le seuil est posé à HUIT : trois mots de
 * marge sur le corpus, et une phrase — même correctement formée — n'y entre pas.
 */
const MAX_MOTS = 8;

/** En dessous, ce n'est pas un nom : c'est un moignon (« X », « de », « à »). */
const MIN_CARACTERES = 3;

// ────────────────────────────────────────────────────────────────────────────────────────────
// VERDICT
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Ordre de GRAVITÉ : le fragment cité et l'explication viennent du doute le plus grave. */
const GRAVITE: readonly ContractLabelDoubt[] = [
  'vide',
  'coupe',
  'montant',
  'nombre',
  'date',
  'attribution',
  'client',
  'clause',
  'forme',
  'cadence',
  'longueur',
];

interface Trouvaille {
  readonly fragment: string;
  readonly fatal: boolean;
}

/**
 * INSPECTE un libellé candidat. Ne mute rien, ne corrige rien : elle CONSTATE le doute et le
 * NOMME, pour que l'appelant puisse poser une question qui explique ce qui pose problème.
 *
 * Le libellé n'est jamais « nettoyé » ici : couper un fragment douteux mutilerait un nom
 * réellement dicté sans que personne ne s'en aperçoive. Le seul endroit où un nom est FILTRÉ est
 * la composition d'une désignation imprimée, dans le domaine — et là, ce qui est jeté ne l'est
 * jamais au détriment du nom conservé sur la fiche.
 */
export function inspectContractLabel(
  label: string | null | undefined,
  options: ContractLabelGuardOptions = {},
): ContractLabelVerdict {
  const mode = options.mode ?? 'extrait';
  const raw = typeof label === 'string' ? label.trim() : '';
  const found = new Map<ContractLabelDoubt, Trouvaille>();
  const noter = (doubt: ContractLabelDoubt, fragment: string, fatal: boolean): void => {
    if (!found.has(doubt)) found.set(doubt, { fragment, fatal });
  };

  const mots =
    raw.length === 0 ? [] : raw.split(PRINTABLE_WORD_SEPARATORS).filter((mot) => mot.length > 0);
  if (raw.length < MIN_CARACTERES || mots.length === 0) noter('vide', raw, true);
  if (mots.length > MAX_MOTS) noter('longueur', '', true);

  const lectures: PrintableWordReading[] = mots.map((mot, index) =>
    readPrintableWord(mot, index === 0 ? null : (mots[index - 1] ?? null)),
  );
  lectures.forEach((lecture, index) => {
    if (lecture.doubt !== undefined) noter(lecture.doubt, mots[index] ?? '', lecture.fatal === true);
  });

  // MOIGNON — un nom qui ne porte AUCUN mot plein n'est pas un nom (« de la »), et un nom qui
  // s'ARRÊTE sur un connecteur est la cicatrice d'une découpe (« … au tarif de », « … à raison
  // d' ») : ce fragment nommerait TEL QUEL le contrat dans toute l'application. Il peut en
  // revanche COMMENCER par un article — « Les Mille Étangs » est un nom.
  if (lectures.length > 0 && lectures.every((lecture) => lecture.nature === 'connecteur')) {
    noter('vide', raw, true);
  }
  const derniere = lectures[lectures.length - 1];
  if (derniere?.nature === 'connecteur') noter('coupe', mots[mots.length - 1] ?? '', true);

  // SOMMES QUE DEUX MOTS SÛRS FORMENT À EUX DEUX. Chaque mot est ici irréprochable ; c'est leur
  // SUITE qui dit un nombre, et un nombre pareil ne nomme rien :
  //  · « 1 200 » — deux nombres courts, dont le second fait EXACTEMENT trois chiffres (un groupe
  //    de milliers). « Maintenance 24 7 » n'y tombe pas : « 7 » n'est pas un groupe de milliers ;
  //  · « quinze mille » — un mot-nombre suivi d'une MAGNITUDE. La quantité qui précède est ce
  //    qui distingue la somme du nom : « Les Mille Étangs » et « Résidence Cent Marches »
  //    passent, aucun mot-nombre ne les précède.
  for (let index = 1; index < mots.length; index += 1) {
    const gauche = printableWordKey(mots[index - 1] ?? '');
    const droite = printableWordKey(mots[index] ?? '');
    const millier = /^\d{1,3}$/u.test(gauche) && /^\d{3}$/u.test(droite);
    const enLettres = PRINTABLE_SPELLED_NUMBERS.has(gauche) && PRINTABLE_MAGNITUDES.has(droite);
    if (millier || enLettres) {
      noter('nombre', `${mots[index - 1] ?? ''} ${mots[index] ?? ''}`, true);
    }
  }

  // CLIENT — « RATP » n'est un jeton de client que parce que l'hôte le dit. Comparaison par
  // JETON radicalisé (jamais par sous-chaîne : « Ste » ne doit pas reconnaître « Stéphanie »).
  // Le fragment CITÉ garde la casse et les accents du libellé — le pro doit reconnaître SON mot.
  const parRadical = new Map<string, string>();
  for (const mot of mots) {
    for (const piece of mot.split(/[^\p{L}\p{N}]+/u)) {
      const clef = printableStem(printableWordKey(piece));
      if (clef.length >= 3 && !parRadical.has(clef)) parRadical.set(clef, piece);
    }
  }
  for (const name of options.customerNames ?? []) {
    const hit = printableDiscriminantTokens(name).find((jeton) =>
      parRadical.has(printableStem(jeton)),
    );
    if (hit === undefined) continue;
    noter('client', parRadical.get(printableStem(hit)) ?? hit, false);
    break;
  }

  const doubts = GRAVITE.filter((doubt) => found.has(doubt));
  const blocking = doubts.filter(
    (doubt) => mode === 'extrait' || found.get(doubt)?.fatal === true,
  );
  const worst = blocking[0] ?? doubts[0];
  const fragment = worst === undefined ? null : (found.get(worst)?.fragment ?? null);
  return {
    accepted: blocking.length === 0,
    doubts,
    blocking,
    fragment: fragment === null || fragment.length === 0 ? null : fragment,
  };
}

/** Vrai si le libellé peut NOMMER le contrat. Raccourci de lecture — même garde, même sévérité. */
export function isContractLabelPrintable(
  label: string | null | undefined,
  options: ContractLabelGuardOptions = {},
): boolean {
  return inspectContractLabel(label, options).accepted;
}

/**
 * Ce que Bob DIT au pro quand il refuse — au point de décision, en français de tous les jours :
 * jamais un code, jamais « validation error ». Le pro doit comprendre CE QU'IL DOIT ENLEVER.
 */
export function contractLabelDoubtSaid(doubt: ContractLabelDoubt): string {
  switch (doubt) {
    case 'montant':
      return 'un montant';
    case 'nombre':
      return 'un nombre écrit comme une somme';
    case 'date':
      return 'une date';
    case 'cadence':
      return 'une cadence de passage';
    case 'client':
      return 'le nom d’un client';
    case 'attribution':
      return 'le nom de quelqu’un';
    case 'clause':
      return 'une clause du contrat';
    case 'forme':
      return 'un morceau de phrase';
    case 'longueur':
      return 'trop de mots pour un nom';
    case 'coupe':
      return 'une fin de phrase coupée';
    case 'vide':
      return 'trop peu de mots pour faire un nom';
  }
}

/**
 * Phrase COMPLÈTE du refus, prête à être dite : ce qui pose problème, où, et pourquoi Bob s'y
 * oppose. Une seule formulation pour les DEUX chemins (agent vocal et registre d'outils), afin
 * que le pro entende toujours la même explication du même refus. Elle parle du NOM — ce que la
 * garde protège — et jamais de la facture : la ligne de la facture annuelle, elle, ne reprend
 * plus le nom (le domaine compose sa désignation), donc la promettre serait mentir.
 */
export function contractLabelRefusalSaid(verdict: ContractLabelVerdict): string {
  const worst = verdict.blocking[0] ?? verdict.doubts[0];
  if (worst === undefined) return '';
  if (worst === 'vide') {
    return 'Ce nom est trop court pour nommer un contrat.';
  }
  const cited =
    verdict.fragment !== null && verdict.fragment.length > 0 ? ` (« ${verdict.fragment} »)` : '';
  if (worst === 'coupe') {
    return `Ce nom s’arrête au milieu d’une phrase${cited} — c’est lui qui s’afficherait partout sur le contrat.`;
  }
  if (worst === 'longueur') {
    return `Ce nom fait plus de ${MAX_MOTS} mots — c’est une phrase, et c’est elle qui s’afficherait partout sur le contrat.`;
  }
  return `Ce nom contient ${contractLabelDoubtSaid(worst)}${cited} — c’est lui qui s’afficherait partout sur le contrat.`;
}
