/**
 * §3.7 — RÉSUMÉ DE PASSAGE dicté dans le même geste que la complétion. Ce texte part sur la
 * FICHE DE PASSAGE signée : c'est une PIÈCE DE PREUVE. Rien d'autre que ce que l'artisan a
 * réellement résumé ne doit y entrer.
 *
 * [Revue adversariale 28/07 — finding 4] L'extraction gloutonne (« tout jusqu'à la fin de la
 * phrase ») écrivait la consigne SUIVANTE dans le résumé : « la pression était basse mais
 * c'est réglé ET ENVOIE LA FICHE AU CLIENT » finissait imprimé sur le PDF signé. Le correctif
 * n'est pas un motif plus fin : c'est un changement de MÉTHODE.
 *
 * EXTRACTION PAR CONSTRUCTION — le résumé n'est plus « ce qui suit l'amorce », c'est le
 * SEGMENT UTILE borné par les CHARNIÈRES FACTUELLES que Bob a déjà extraites par ailleurs :
 *
 *   1. une AMORCE de résumé ouvre le segment (« note-le : », « résumé : ») ;
 *   2. la dictée COORDONNE ses faits (virgule, « et », « puis », « ensuite ») : le segment est
 *      découpé sur ces coordinations, et chaque morceau est classé ;
 *   3. le segment se ferme au PREMIER morceau qui est une charnière :
 *      • une CONSIGNE SUIVANTE (verbe de geste que Bob route déjà — intent.ts) ;
 *      • une DURÉE / UNE HEURE (déjà extraite pour l'horodatage du passage) ;
 *      • un NOM DE SITE ou DE CLIENT déjà RÉSOLU (resolveSpokenChantier), ou une charnière
 *        locative explicite (« c'est chez … ») quand rien n'est encore résolu.
 *
 * Le résumé rendu est une TRANCHE du message d'origine (aucune retranscription, aucune
 * normalisation) : la pièce de preuve garde la lettre de ce qui a été dit.
 */

/** Charnières FACTUELLES déjà extraites par ailleurs — elles bornent le segment utile. */
export interface InterventionSummaryHinges {
  /** Sites DÉJÀ résolus (resolveSpokenChantier). */
  siteNames?: readonly string[];
  /** Clients DÉJÀ résolus. */
  customerNames?: readonly string[];
}

/** En deçà, ce n'est pas un résumé (« ok », « rien ») : on n'écrit rien plutôt qu'un déchet. */
const MIN_SUMMARY_LENGTH = 3;
/**
 * Au-delà, la dictée n'est plus un résumé mais un monologue dont on ne sait plus dire où il
 * s'arrête : Bob préfère NE RIEN écrire sur une pièce de preuve (le silence est honnête, et la
 * carte de confirmation montre toujours ce qui a été capté) — jamais une troncature muette.
 */
const MAX_SUMMARY_LENGTH = 300;

/**
 * Repli d'accents/apostrophes à LONGUEUR CONSTANTE : les index calculés sur le texte replié
 * découpent le texte ORIGINAL. Un repli qui change la longueur (NFD global) décalerait les
 * bornes et couperait un mot en deux sur une pièce de preuve.
 */
function fold(value: string): string {
  let folded = '';
  for (const character of value) {
    const stripped = character.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const candidate = stripped.length === character.length ? stripped : character;
    folded += /['’‘`´]/.test(candidate) ? "'" : candidate;
  }
  return folded;
}

/**
 * AMORCES du résumé dicté. Les formes longues passent AVANT les courtes : « note-le : » ne doit
 * jamais être coupé après « note » (le résumé commencerait par « le : »).
 */
const AMORCE_RESUME =
  /\b(?:note[sz]?[- ](?:le|la|ca|cela|bien)|note[sz]?|resume|resumes)\b\s*[:,–—-]*\s*/;

/** Coordinations de la dictée — c'est là que la consigne suivante commence, quand elle commence. */
const COORDINATION = /\s*[,;]\s*|\s+(?:et|puis|ensuite|apres|donc|alors|enfin)\s+/g;

/** Fin de phrase : au-delà, on ne parle plus du passage. */
const FIN_DE_PHRASE = /[.!?…]/;

/** Verbes de GESTE que Bob route déjà (intent.ts) — une consigne s'ouvre par l'un d'eux. */
const VERBES_DE_GESTE =
  'envoie|envoies|envoyer|envoyez|transmets|transmettez|transmettre|adresse|adresses|adresser|' +
  'expedie|expedies|expediez|expedier|facture|factures|facturez|facturer|signe|signes|signer|' +
  'fais|faites|faire|demarre|demarres|demarrez|demarrer|commence|commences|commencez|commencer|' +
  'debute|debuter|lance|lances|lancez|lancer|prepare|prepares|preparez|preparer|relance|relances|' +
  'relancez|relancer|encaisse|encaisses|encaissez|encaisser|programme|programmer|planifie|' +
  'planifier|archive|archiver|imprime|imprimer|previens|prevenir|appelle|appeler|rappelle|rappeler';

/**
 * Une consigne OCCUPE son propre morceau : elle s'ouvre par son verbe (éventuellement précédé
 * d'un enchaînement ou d'un pronom). C'est la forme réelle de la dictée composite §3.7.
 */
const CONSIGNE_EN_TETE = new RegExp(
  `^(?:et\\s+|puis\\s+|ensuite\\s+|apres\\s+|enfin\\s+|maintenant\\s+|tu\\s+|il\\s+faut\\s+|faut\\s+|vas[- ]y\\s+)*` +
    `(?:me\\s+|lui\\s+|leur\\s+|nous\\s+|les\\s+|le\\s+|la\\s+|l')?(?:${VERBES_DE_GESTE})\\b`,
);

/**
 * Filet quand la dictée ENCHAÎNE sans coordination (« filtre changé envoie la fiche ») : un
 * verbe de geste SUIVI de son complément direct est une consigne, jamais un fait de terrain
 * (« la facture est jointe » n'est pas capté : « facture » y est suivi d'un verbe).
 */
const CONSIGNE_AU_FIL =
  /\b(?:envoie|envoies|envoyez|transmets|transmettez|expedie|expediez|facture|facturez|relance|relances|relancez|adresse|adresses|adressez)\s+(?:le|la|les|lui|leur|l'|ce|cette|ces|moi|nous)\b/;

/** DURÉES / HEURES : elles sont extraites pour l'horodatage — jamais recopiées dans le résumé. */
const DUREE_OU_HEURE =
  /\b\d{1,3}\s*h(?:\s*\d{1,2})?\b|\b\d{1,3}\s*(?:heures?|minutes?|mins?|min)\b|\b(?:une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|quinze|vingt|trente|quarante|cinquante)\s+(?:heures?|minutes?)\b|\bdemi[- ]heure\b|\b(?:midi|minuit)\b/;

/** Charnière LOCATIVE explicite — utile même quand aucun site n'a encore été résolu. */
const CHARNIERE_LOCATIVE = /^(?:c'est\s+|c\s+est\s+)?(?:chez|sur\s+le\s+site|au\s+site|site)\b/;

/** Tokens porteurs d'un nom propre résolu (les mots courts ne nomment rien à eux seuls). */
function tokensDeNom(nom: string): string[] {
  return fold(nom)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

function porteUnNomResolu(segment: string, hinges: InterventionSummaryHinges): boolean {
  const noms = [...(hinges.siteNames ?? []), ...(hinges.customerNames ?? [])];
  for (const nom of noms) {
    for (const token of tokensDeNom(nom)) {
      if (new RegExp(`\\b${token}\\b`).test(segment)) return true;
    }
  }
  return false;
}

/** Ce morceau est-il une CHARNIÈRE (donc la fin du résumé) plutôt qu'un fait de terrain ? */
function estCharniere(segment: string, hinges: InterventionSummaryHinges): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return false;
  if (CONSIGNE_EN_TETE.test(trimmed)) return true;
  if (CONSIGNE_AU_FIL.test(trimmed)) return true;
  if (DUREE_OU_HEURE.test(trimmed)) return true;
  if (CHARNIERE_LOCATIVE.test(trimmed)) return true;
  return porteUnNomResolu(trimmed, hinges);
}

/**
 * Résumé de passage dicté dans la consigne, ou `null` quand l'artisan n'en a dicté aucun —
 * Bob n'invente JAMAIS le contenu d'une pièce de preuve.
 */
export function extractInterventionSummary(
  message: string,
  hinges: InterventionSummaryHinges = {},
): string | null {
  const folded = fold(message);
  const amorce = AMORCE_RESUME.exec(folded);
  if (!amorce || amorce.index === undefined) return null;

  const debut = amorce.index + amorce[0].length;
  // Le résumé ne franchit pas la fin de phrase : au-delà, la dictée parle d'autre chose.
  const finDePhrase = FIN_DE_PHRASE.exec(folded.slice(debut));
  const fin = finDePhrase ? debut + finDePhrase.index : folded.length;
  const queue = folded.slice(debut, fin);

  // Découpe sur les coordinations : chaque morceau est un fait, ou une charnière.
  const morceaux: { start: number; end: number }[] = [];
  let curseur = 0;
  COORDINATION.lastIndex = 0;
  for (const separation of queue.matchAll(COORDINATION)) {
    if (separation.index === undefined) continue;
    morceaux.push({ start: curseur, end: separation.index });
    curseur = separation.index + separation[0].length;
  }
  morceaux.push({ start: curseur, end: queue.length });

  // Le segment utile court jusqu'à la PREMIÈRE charnière (exclue) — jamais au-delà.
  let coupe = queue.length;
  for (const [rang, morceau] of morceaux.entries()) {
    if (!estCharniere(queue.slice(morceau.start, morceau.end), hinges)) continue;
    coupe = rang === 0 ? 0 : morceaux[rang - 1]!.end;
    break;
  }

  const summary = message
    .slice(debut, debut + coupe)
    .trim()
    .replace(/[\s,;:–—-]+$/u, '')
    .trim();
  if (summary.length < MIN_SUMMARY_LENGTH || summary.length > MAX_SUMMARY_LENGTH) return null;
  return summary;
}
