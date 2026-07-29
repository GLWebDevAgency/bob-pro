import {
  extractInterventionSummary,
  type InterventionSummaryHinges,
} from './intervention-summary';

/**
 * §3.7 — LA CONSIGNE DE PASSAGE, LUE PAR LE CHEMIN DÉTERMINISTE.
 *
 * ┌─ PARTAGE DES RÔLES (à ne plus jamais élargir) ──────────────────────────────────────────┐
 * │                                                                                          │
 * │  `classifyWithLlm`  → PLUSIEURS étapes. C'est LUI qui DÉCOMPOSE une consigne composite   │
 * │                       en autant de gestes qu'elle en porte. Chemin de la production.     │
 * │                                                                                          │
 * │  `classifyWithRegex` → UNE consigne, UN geste, de façon fiable. Ce module en est la      │
 * │                       lecture pour la fiche de passage. Il n'arbitre JAMAIS entre        │
 * │                       plusieurs gestes dictés dans la même phrase.                       │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * SIX PASSES ont tenté d'arbitrer « terminer » CONTRE « envoyer / facturer » à coups
 * d'expressions régulières. Chacune a DÉPLACÉ l'impasse au lieu de la supprimer : gardes
 * croisées dans `intent.ts`, puis les mêmes gardes ici sur le MESSAGE ENTIER, puis la même
 * exclusion devenue INTRA-clause. La dernière vérification l'a chiffrée : 113 cas fautifs sur
 * 343, 78 clauses éteintes. La cause n'était pas le motif — c'était le PÉRIMÈTRE : on demandait
 * à des expressions régulières un travail de décomposition qui n'est pas le leur.
 *
 * LA RÈGLE, DÉSORMAIS — le doute ne produit ni geste faux, ni silence :
 *
 *   1. UN SEUL GESTE DICTÉ  → comportement d'avant (fiable, déjà prouvé) : on l'exécute.
 *   2. PLUSIEURS GESTES     → on ne devine pas. On retient CELUI QU'ON IDENTIFIE AVEC
 *                             CERTITUDE — le PREMIER geste impératif clairement identifié —
 *                             et on DIT le reste VERBATIM (`asides`, kind `reporte`). Rien
 *                             n'est détourné, rien n'est éteint.
 *   3. AUCUN GESTE CERTAIN  → `needsClarification` : on pose une question.
 *
 * CE QUI REND UN GESTE CERTAIN : son verbe est en TÊTE DE CLAUSE, c.-à-d. employé comme un
 * ORDRE. C'est la seule chose qu'une expression régulière sache trancher en français, où le
 * participe est homographe de l'impératif une fois les accents repliés (« rangé/range »,
 * « classé/classe », « marqué/marque », « archivé/archive »). Un déterminant devant le mot en
 * fait un NOM ou un PARTICIPE — jamais un ordre : « l'archive est à jour » ne demande rien.
 *
 * L'ANNONCE DE FIN n'est pas un geste, c'est un FAIT sur le passage (« c'est terminé »). Elle
 * accompagne le geste retenu : l'ÉTAT RÉEL du passage (`resolveInterventionGesture`) décide
 * ensuite si l'on termine d'abord puis on enchaîne, ou si l'on exécute directement.
 *
 *   passage `in_progress`            → on TERMINE, puis on annonce le geste aval ;
 *   passage `completed` / `signed`   → « c'est terminé » n'est qu'un RAPPEL : on exécute
 *                                      DIRECTEMENT le geste aval ;
 *   aucun passage au bon état        → on dit honnêtement ce qui manque.
 *
 * BORNE : quand la consigne porte une demande CERTAINE qui vit ailleurs (un ordre en tête de
 * clause, une question, une demande nominale) et aucun geste de passage, l'annonce de fin ne
 * capte rien — chaque clause garde son intent d'origine.
 *
 * ┌─ UNE SEULE LECTURE DU RÉSUMÉ ────────────────────────────────────────────────────────────┐
 * │  Le résumé dicté part sur la FICHE SIGNÉE : c'est une pièce de preuve. Il est lu ICI, UNE │
 * │  fois, charnières comprises, et RENDU (`summary`). L'appelant écrit CE texte-là et pas un │
 * │  autre : deux lectures du même message (l'une avec charnières, l'autre sans) pouvaient    │
 * │  écrire un texte sur la fiche ET le déclarer « incompris » dans la MÊME carte — ou        │
 * │  l'inverse, l'étouffer sans rien écrire. Une lecture, un jeu d'arguments, un résultat.    │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 */

/** Geste AVAL d'une consigne composite — ce que l'artisan enchaîne après la fin du passage. */
export type InterventionDownstream = 'sign' | 'send' | 'bill';

/** Geste de fiche réellement exécutable — l'ordre du parcours §3.7. */
export type InterventionGesture = 'start' | 'complete' | InterventionDownstream;

/**
 * Ce qu'une clause demande sans que le tour s'en occupe. `ailleurs` = un geste identifié qui vit
 * ailleurs (facture, trésorerie, dépense, planning) ; `reporte` = un geste de passage DE PLUS,
 * que le déterministe refuse d'arbitrer et redit tel quel ; `incompris` = une demande dont Bob
 * n'a pas su faire quoi que ce soit. Les trois se DISENT — le silence sur la moitié d'une
 * consigne est interdit.
 */
export type InterventionAsideKind = 'ailleurs' | 'reporte' | 'incompris';

/** Une demande de la consigne que ce tour ne traite pas — citée VERBATIM. */
export interface InterventionAside {
  /** Tranche du message ORIGINAL (aucune retranscription) : Bob cite ce qui a été dit. */
  readonly text: string;
  readonly kind: InterventionAsideKind;
}

/** Lecture d'UNE consigne : le geste certain, et tout ce qui n'entre pas dans ce tour. */
export interface InterventionDirective {
  /** « démarre l'intervention chez Carrefour » — ouverture du passage. */
  readonly startsPassage: boolean;
  /** « c'est terminé », « j'ai fini », « le passage est terminé » — ANNONCE de fin (un FAIT). */
  readonly announcesCompletion: boolean;
  /** LE geste aval retenu — jamais deux : les suivants sont RENDUS en `asides`. */
  readonly downstream: InterventionDownstream | null;
  /** Le même, en liste (0 ou 1 élément) — la forme qu'attend le routage par l'état. */
  readonly downstreams: readonly InterventionDownstream[];
  /** Ce que la consigne demande d'autre — jamais jeté en silence. */
  readonly asides: readonly InterventionAside[];
  /**
   * LE résumé dicté, lu UNE SEULE FOIS pour tout le tour (charnières comprises), ou `null`
   * quand l'artisan n'en a dicté aucun. C'est CE texte-là qui part sur la fiche signée :
   * l'appelant ne relit jamais le message autrement, sinon la carte et la pièce de preuve
   * peuvent se contredire.
   */
  readonly summary: string | null;
  /** Au moins une clause porte une demande CERTAINE qui ne parle pas du passage. */
  readonly divertsElsewhere: boolean;
  /** Le geste que le déterministe ORIENTE — `null` quand il n'oriente rien vers le passage. */
  readonly gesture: InterventionGesture | null;
  /** Un geste de passage est demandé sous une forme INCERTAINE : Bob pose une question. */
  readonly needsClarification: boolean;
}

/** Demande RÉELLE portée par le tour : le geste classé, enrichi de ce que dit la phrase. */
export interface InterventionRequest {
  readonly starts: boolean;
  readonly completes: boolean;
  /** Geste aval du tour — 0 ou 1 : le déterministe n'en porte jamais deux. */
  readonly downstreams: readonly InterventionDownstream[];
  /** Demandes de la consigne que ce tour ne traite pas — l'appelant DOIT les dire. */
  readonly asides: readonly InterventionAside[];
}

/** Vue MINIMALE d'un passage réel — la seule matière du routage (jamais un statut deviné). */
export interface InterventionStateView {
  readonly status: 'scheduled' | 'in_progress' | 'completed' | 'signed' | 'cancelled';
  /** SEUL discriminant d'une visite contractuelle (direction 6) — jamais le libellé. */
  readonly contractId: string | null;
  readonly billedInvoiceId: string | null;
  /** Statut RÉEL de la pièce liée : une facture annulée (avoir) RALLUME le droit de facturer. */
  readonly billedInvoiceStatus: string | null;
}

/** Ce que l'état RÉEL rend possible : le geste de MAINTENANT, et celui qui s'annonce après. */
export interface InterventionResolution {
  readonly gesture: InterventionGesture;
  /** Geste ANNONCÉ pour le tour suivant — `null` quand la consigne s'arrête là. */
  readonly then: InterventionDownstream | null;
  /**
   * Geste aval COMPRIS mais impossible même une fois le geste courant fait (visite
   * contractuelle, passage déjà facturé…). Il est DIT, jamais tu.
   */
  readonly withheld: InterventionDownstream | null;
}

/**
 * MARQUEUR DES COMMANDES CANONIQUES — posé par BOB LUI-MÊME sur les commandes qu'il rejoue
 * après une désambiguïsation, jamais dicté par un humain (« # » ne se prononce pas).
 *
 * [Bloquant du CHEMIN DE L'ARGENT] La passe précédente faisait primer une référence de langage
 * (« le passage », « la visite ») pour rejouer ces commandes. Conséquence mesurée : « Facture
 * 380 € à Mme Girard POUR LA VISITE » — une facture DIRECTE dictée avec un montant, le chemin
 * de l'argent — partait vers `facturer_intervention`, parce que cette précédence faisait sauter
 * la garde du montant. Une phrase d'utilisateur ne peut PAS servir de marqueur : seul un
 * marqueur que Bob pose lui-même le peut.
 */
export const INTERVENTION_COMMAND_MARKER = '#passage';

/** Appose le marqueur sur une commande canonique — la seule façon de la rejouer. */
export function markInterventionCommand(command: string): string {
  return `${command} ${INTERVENTION_COMMAND_MARKER}`;
}

const MARQUEUR_DE_COMMANDE = /#passage\b/u;

/**
 * Repli d'accents/apostrophes à LONGUEUR CONSTANTE : les index calculés sur le texte replié
 * découpent le texte ORIGINAL. Un repli qui change la longueur (NFD global) décalerait les
 * bornes et Bob citerait une demande mutilée en disant ce qu'il ne fait pas.
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

// ── DÉCOUPE EN CLAUSES ───────────────────────────────────────────────────────────────────────

/**
 * Coordinations de la dictée — c'est là que la consigne suivante commence, quand elle commence.
 * « avec » et « ainsi que » en font partie : ils introduisent une SECONDE demande dans la même
 * respiration (« envoie-lui la fiche de passage AVEC LA FACTURE »). Sans cette coupe, l'objet
 * de la seconde demande éteignait la première — l'exclusion croisée était devenue intra-clause.
 *
 * La virgule et le point ENTRE DEUX CHIFFRES sont une décimale, jamais une coordination :
 * « facture 380,50 € » doit rester UNE clause, sinon le montant part dans la clause suivante et
 * la garde qui protège la facture directe (B1) ne le voit plus — et Bob citerait « facture 380 »
 * en disant ce qu'il ne fait pas. La règle ne vaut QUE pour la décimale : le point final de
 * « émets la facture 2026-014. » suit bien un chiffre, et il coupe.
 */
const COORDINATION =
  /(?:(?<!\d)|(?![.,]\d))\s*[,;.!?…]+\s*|\s+(?:et|puis|ensuite|apres|donc|alors|enfin|avec|ainsi que)\s+/gu;

/**
 * Filet quand la dictée ENCHAÎNE sans coordination (« c'est terminé envoie la fiche ») : un
 * verbe de geste SUIVI de son complément direct ouvre une nouvelle clause, jamais un fait de
 * terrain (« la facture est jointe » n'est pas capté : « facture » y est suivi d'un verbe).
 * MÊME motif que `intervention-summary.ts` — une seule lecture de l'enchaînement au fil.
 */
const CONSIGNE_AU_FIL =
  /\b(?:envoie|envoies|envoyez|transmets|transmettez|expedie|expediez|facture|facturez|relance|relances|relancez|adresse|adresses|adressez|encaisse|encaisses|encaissez|prepare|prepares|preparez)\s+(?:le|la|les|lui|leur|l'|ce|cette|ces|moi|nous)\b/gu;

interface Clause {
  /** Borne basse dans le texte replié — et donc dans le texte ORIGINAL (repli constant). */
  readonly start: number;
  readonly end: number;
  readonly folded: string;
}

/** Découpe la consigne en clauses : coordinations d'abord, enchaînement au fil ensuite. */
function splitClauses(folded: string): Clause[] {
  const bornes: { start: number; end: number }[] = [];
  let curseur = 0;
  COORDINATION.lastIndex = 0;
  for (const separation of folded.matchAll(COORDINATION)) {
    if (separation.index === undefined) continue;
    bornes.push({ start: curseur, end: separation.index });
    curseur = separation.index + separation[0].length;
  }
  bornes.push({ start: curseur, end: folded.length });

  const clauses: Clause[] = [];
  for (const borne of bornes) {
    const segment = folded.slice(borne.start, borne.end);
    if (segment.trim().length === 0) continue;
    // Enchaînement AU FIL : chaque consigne qui s'ouvre en cours de clause ouvre sa propre clause.
    const coupes: number[] = [];
    CONSIGNE_AU_FIL.lastIndex = 0;
    for (const consigne of segment.matchAll(CONSIGNE_AU_FIL)) {
      if (consigne.index !== undefined && consigne.index > 0) coupes.push(consigne.index);
    }
    let debut = 0;
    for (const coupe of [...coupes, segment.length]) {
      if (coupe <= debut) continue;
      const tranche = segment.slice(debut, coupe);
      if (tranche.trim().length > 0)
        clauses.push({
          start: borne.start + debut,
          end: borne.start + coupe,
          folded: tranche,
        });
      debut = coupe;
    }
  }
  return clauses;
}

// ── ANNONCE DE FIN (lue sur UNE clause) ──────────────────────────────────────────────────────

/**
 * Annonce NUE : son objet est IMPLICITE, c'est le passage en cours. La position de la fin de
 * l'annonce est capturée pour lire CE QUI SUIT — « j'ai fini LA FACTURE » ne termine aucun passage.
 */
const ANNONCE_NUE =
  /\b(?:j'ai|on a|nous avons)\s+(?:bien\s+|enfin\s+)?(?:fini|termine)\b|\bc'est\s+(?:bon,?\s+)?(?:fini|termine)e?s?\b|^\s*(?:fini|termine)e?s?\b/gu;

/** Objet NON-PASSAGE juste après l'annonce : la fin porte alors sur une pièce ou une période. */
const OBJET_NON_PASSAGE =
  /^\s*(?:l(?:a|e|es)\s+|l'|mes\s+|ma\s+|mon\s+|ce(?:t|tte)?\s+|ces\s+|du\s+|de\s+la\s+)?(?:factures?|devis|avoirs?|relances?|mois|exercices?|tva|comptabilite|compta|cloture|saisie|journee|semaine|tournee)\b/u;

/** Annonce EXPLICITE : le sujet est NOMMÉ — « le passage est terminé », « la visite est finie ». */
const ANNONCE_EXPLICITE =
  /\b(?:le passage|l'intervention|la visite|le depannage|le chantier|la prestation)\s+(?:est|sont)\s+(?:fini|finie|finis|finies|termine|terminee|termines|terminees)\b/u;

/**
 * Annonce IMPÉRATIVE : « termine ce passage », « clôture le passage ». Le verbe est borné (`\b`)
 * pour que l'ADJECTIF (« cette intervention terminée la semaine dernière ») ne soit jamais pris
 * pour un ordre — un participe DÉCRIT le passage, il n'annonce aucune fin.
 */
const ANNONCE_IMPERATIVE =
  /\b(?:termine|termines|terminer|cloture|clotures|cloturer|boucle|boucles|boucler)\b\s+(?:l'|le|la|ce|cette|mon|ma)\s*(?:passage|intervention|visite|depannage|prestation)\b/u;

/** Clause réduite au constat (« passage terminé ») : rien d'autre n'y est demandé. */
const ANNONCE_TELEGRAPHIQUE =
  /^\s*(?:le\s+|la\s+|mon\s+|ma\s+)?(?:passage|intervention|visite|depannage)\s+(?:fini|finie|termine|terminee)e?s?\s*[!.…]*\s*$/u;

/** Sujet comptable / calendaire : sans ANCRE de passage, la fin annoncée ne parle pas du terrain. */
const SUJET_HORS_TERRAIN = /\b(?:devis|mois|exercices?|tva|bilan|comptabilite|paie)\b/u;
const ANCRE_DE_PASSAGE =
  /\b(?:passages?|interventions?|visites?|depannages?|chantiers?|sites?|chez|fiches?|rapports?|compte rendu)\b/u;

/** Cette CLAUSE annonce-t-elle la fin d'un passage ? (jamais lue sur le message entier) */
function annonceDeFin(clause: string): boolean {
  let annonce =
    ANNONCE_EXPLICITE.test(clause) ||
    ANNONCE_IMPERATIVE.test(clause) ||
    ANNONCE_TELEGRAPHIQUE.test(clause);
  if (!annonce) {
    ANNONCE_NUE.lastIndex = 0;
    for (
      let candidate = ANNONCE_NUE.exec(clause);
      candidate !== null;
      candidate = ANNONCE_NUE.exec(clause)
    ) {
      const suite = clause.slice(candidate.index + candidate[0].length);
      if (!OBJET_NON_PASSAGE.test(suite)) {
        annonce = true;
        break;
      }
    }
  }
  if (!annonce) return false;
  return !SUJET_HORS_TERRAIN.test(clause) || ANCRE_DE_PASSAGE.test(clause);
}

// ── TÊTE DE CLAUSE : ce qui distingue un ORDRE d'un fait de terrain ──────────────────────────

/**
 * Une consigne OCCUPE son propre morceau et s'OUVRE par son verbe, éventuellement précédé d'un
 * enchaînement ou d'une formule de politesse. AUCUN déterminant ni pronom antéposé : en
 * français, l'impératif ne se précède pas d'un clitique (« range-le », jamais « le range »).
 * C'est ce qui rend « L'ARCHIVE est à jour », « LA CLASSE énergétique est correcte », « c'est
 * RANGÉ » définitivement muets : le mot y est un NOM ou un PARTICIPE, jamais un ordre.
 */
const TETE_DE_CLAUSE =
  `^(?:et\\s+|puis\\s+|ensuite\\s+|apres\\s+|enfin\\s+|maintenant\\s+|alors\\s+|donc\\s+|` +
  `tu\\s+peux\\s+|peux[- ]tu\\s+|pourrais[- ]tu\\s+|merci\\s+de\\s+|s'il\\s+te\\s+plait\\s+|` +
  `tu\\s+|il\\s+faut\\s+|faut\\s+|faudrait\\s+|vas[- ]y\\s+|allez\\s+)*`;

/**
 * Ce verbe ouvre-t-il la clause — c.-à-d. est-il employé comme un ORDRE ? Rend la longueur de la
 * tête consommée (pour lire le COMPLÉMENT qui suit), ou `null` quand la clause n'ordonne rien.
 */
function ordreEnTete(clause: string, verbes: string): number | null {
  const found = new RegExp(`${TETE_DE_CLAUSE}(?:${verbes})\\b`, 'u').exec(clause);
  return found === null ? null : found[0].length;
}

// ── GESTES DE FICHE (lus sur UNE clause, en TÊTE) ────────────────────────────────────────────

/** Une négation ne déclenche JAMAIS un geste — ni avant le verbe, ni juste après. */
function nie(clause: string, verbes: string): boolean {
  return new RegExp(
    `\\b(?:ne|n|pas|jamais|surtout pas)\\b.{0,24}\\b(?:${verbes})\\b|\\b(?:${verbes})\\b.{0,30}\\bpas\\b`,
    'u',
  ).test(clause);
}

const VERBES_ENVOI =
  'envoie|envoies|envoyer|envoyez|transmets|transmettez|transmettre|adresse|adresses|adresser|expedie|expedies|expedier';
/**
 * L'OBJET d'un geste de fiche : LE DOCUMENT DU PASSAGE. « fiche », « rapport », « compte rendu »
 * sont des noms GÉNÉRIQUES — en français, c'est le complément en « de » qui donne son TYPE au
 * document : « fiche DE PAIE », « rapport DE TVA », « fiche DE PASSAGE ». Un nom COMPLÉTÉ ne
 * désigne donc le document du terrain que si son complément NOMME le passage ; NU (« envoie la
 * fiche », « envoie le compte rendu », « envoie la fiche au client »), il désigne la fiche du
 * passage sous la main. La règle dit ce que l'objet DÉSIGNE — elle n'énumère aucun contre-exemple.
 */
const NOM_DE_DOCUMENT = '(?:fiches?|rapports?|comptes? rendus?)';
const COMPLEMENT_DU_PASSAGE =
  `(?:de\\s+la\\s+|de\\s+l'|d'|de\\s+|du\\s+|des\\s+)` +
  `(?:passages?|interventions?|visites?|depannages?|chantiers?)`;
const OBJET_FICHE = new RegExp(
  `\\b${NOM_DE_DOCUMENT}\\s+${COMPLEMENT_DU_PASSAGE}\\b` +
    `|\\b${NOM_DE_DOCUMENT}\\b(?!\\s+(?:de\\b|d'|du\\b|des\\b))` +
    `|\\b(?:passages?|interventions?)\\b`,
  'u',
);
/**
 * Une pièce de BUREAU nommée garde son propre geste — elle ne se produit pas sur le terrain :
 * les pièces de VENTE (« envoie la facture 2026-014 »), les pièces SOCIALES et FISCALES
 * (« envoie la fiche de paie », « envoie le rapport de TVA ») et les états PÉRIODIQUES
 * (« envoie le rapport mensuel »). C'est la définition de ce qu'est une pièce de bureau, pas une
 * liste de contre-exemples de la fiche de passage.
 */
const PIECE_COMPTABLE =
  /\b(?:devis|factures?|avoirs?|relances?)\b|\b(?:paie|paies|paye|salaires?|tva|urssaf)\b|\bbulletins?\s+de\s+(?:paie|salaires?)\b|\b(?:rapports?|comptes? rendus?|etats?|releves?)\s+(?:mensuels?|hebdomadaires?|trimestriels?|semestriels?|annuels?)\b/u;
/** « envoie-la », « transmets-lui » : après une fin annoncée, le seul envoyable est la fiche. */
const ENVOI_PRONOMINAL =
  /\b(?:envoie|envoies|envoyer|transmets|transmettre|adresse|adresser)[- ](?:le|la|les|lui|leur|moi|nous|ca|cela)\b/u;

const VERBES_SIGNATURE = 'signe|signes|signer|signature';
const GESTE_SIGNATURE =
  `(?:fais(?:-| )?(?:le |la )?signer|faire signer|fais(?:-| )?moi signer|prends? la signature|prendre la signature|(?:le |la )?client signe|signature (?:du|de la) client)`;
/** Un devis / un contrat signé garde son intent : la signature de fiche n'y touche jamais. */
const SIGNATURE_HORS_FICHE = /\b(?:devis|factures?|contrats?|bons? de commande)\b/u;

const VERBES_FACTURATION = 'facture|factures|facturer|facturez|factureras';
/**
 * Un verbe de CRÉATION porte le geste de facturation même devant un déterminant (« prépare LA
 * facture ») : une pièce qui n'existe pas encore ne peut pas être l'objet d'une création. La
 * lecture reste bornée par les gardes ci-dessous (montant dit, devis, situation, pièce numérotée).
 */
const VERBES_CREATION_FACTURE =
  'prepare|prepares|preparez|preparer|fais|faites|faire|etablis|etablit|etablissez|etablir|' +
  'monte|montes|montez|monter|redige|rediges|redigez|rediger|genere|generes|generez|generer|' +
  'cree|crees|creez|creer';
const COMPLEMENT_DE_FACTURE = /^(?:[- ](?:moi|nous|lui))?\s+(?:la|une|ma|sa|leur|cette|l')\s*factur\w*/u;

/**
 * Un MONTANT dit fait de la consigne une FACTURE DIRECTE (B1) — jamais un passage à facturer.
 * La borne exclut les fragments d'identifiant : dans un uuid (« a1b2-123e-4567 »), « 123e » n'a
 * jamais été un montant. Sans cette borne, la commande canonique rejouée après désambiguïsation
 * s'éteignait toute seule et la question « Quel passage ? » rebouclait sur elle-même.
 */
const MONTANT_DIT = /(?:€|\beuros?\b|\bht\b|\bttc\b|\btva\b|(?<![\w-])\d+(?:[.,]\d+)?\s*(?:e|eur)(?![\w-]))/u;
/**
 * Facturation qui porte un AUTRE geste, jamais la fiche de passage : contractuelle, situation de
 * travaux, acompte/solde d'un devis — et la FACTURE DIRECTE (B1), que l'artisan nomme lui-même
 * (« facture directe de 2 jours de régie ») : elle vit sur le chemin de l'argent.
 */
const FACTURATION_HORS_PASSAGE =
  /\bfactures?\s+directes?\b|\b(?:annuelle?s?|contrats?|situations?|acomptes?|soldes?)\b/u;
/**
 * Une pièce NUMÉROTÉE existe déjà : « prépare la facture 2026-014 » n'est pas un passage à
 * facturer. Le numéro doit être ADJACENT à la pièce — un identifiant de passage plus loin dans
 * la phrase (« Facture le passage 4d1c…-112233445566 ») n'a jamais nommé de facture.
 */
const PIECE_NUMEROTEE = /\bfactur\w*\s+(?:n[°o]\s*)?[a-z]*\d{3,}/u;
/**
 * L'OBJET du geste est LE PASSAGE lui-même : « facture ce passage », « facture cette
 * intervention ». La forme DÉMONSTRATIVE est ANAPHORIQUE — elle renvoie au passage dont on vient
 * de parler, quoi qu'il suive. La forme DÉFINIE (« le passage », « la visite ») ne le désigne, en
 * revanche, que si rien ne la RE-QUALIFIE : en français, « nom + à + nom NU » soude un nom
 * COMPOSÉ qui nomme AUTRE CHOSE (« le passage À NIVEAU », « le passage À GUÉ ») — un passage à
 * niveau n'est pas une visite. Ce qui SITUE la visite ou en nomme le destinataire la désigne
 * toujours, lui : un déterminant, une civilité ou une heure après « à » (« la visite à la SNCF »,
 * « le passage à Mme Girard », « le passage à 14 h »), comme « chez … » ou « de ce matin ».
 */
const DETERMINANT_OU_DESTINATAIRE =
  `(?:l[ae]\\b|l'|les\\b|un\\b|une\\b|des\\b|mon\\b|ma\\b|mes\\b|son\\b|sa\\b|ses\\b|leurs?\\b|` +
  `notre\\b|nos\\b|votre\\b|vos\\b|ce\\b|cet\\b|cette\\b|ces\\b|` +
  `m\\.|mr\\b|mme\\b|mlle\\b|monsieur\\b|madame\\b|mademoiselle\\b|\\d)`;
const REFERENCE_PASSAGE = new RegExp(
  `\\b(?:ce passage|cette intervention|cette visite|ce depannage)\\b` +
    `|\\b(?:le passage|la visite)\\b(?!\\s+a\\s+(?!${DETERMINANT_OU_DESTINATAIRE}))` +
    `|\\bl'intervention de\\b`,
  'u',
);

const VERBES_DEMARRAGE = 'demarre|demarrer|demarres|commence|commencer|commences|debute|debuter|lance|lancer';
const OBJET_DEMARRAGE = /\b(?:interventions?|passages?|visites?|chantier|depannage)\b/u;
const DEMARRAGE_HORS_FICHE = /\b(?:devis|factures?|relances?|scan)\b/u;

// ── DEMANDES QUI PORTENT AILLEURS (lues sur UNE clause) ──────────────────────────────────────

/**
 * Verbes qui ne portent JAMAIS sur une fiche de passage : leur objet vit ailleurs (encaissement,
 * planning, comptabilité, pièces, lectures de pilotage). En TÊTE de clause, ils suffisent.
 */
const VERBES_AILLEURS =
  'encaisse|encaisses|encaissez|encaisser|paie|paies|payez|payer|paye|regle|regles|reglez|regler|' +
  'relance|relances|relancez|relancer|programme|programmes|programmez|programmer|planifie|planifies|' +
  'planifiez|planifier|scanne|scannes|scannez|scanner|numerise|numerises|numerisez|numeriser|' +
  'archive|archives|archivez|archiver|imprime|imprimes|imprimez|imprimer|emets|emet|emettez|emettre|' +
  'numerote|numerotes|numerotez|numeroter|classe|classes|classez|classer|range|ranges|rangez|ranger|' +
  'renomme|renommes|renommez|renommer|cherche|cherches|cherchez|chercher|retrouve|retrouves|retrouvez|' +
  'retrouver|montre|montres|montrez|montrer|affiche|affiches|affichez|afficher|liste|listes|listez|' +
  'lister|ajoute|ajoutes|ajoutez|ajouter|impute|imputes|imputez|imputer|declare|declares|declarez|' +
  'declarer|marque|marques|marquez|marquer|calcule|calcules|calculez|calculer';

/**
 * Verbes AMBIGUS : ils peuvent servir un geste de fiche. Ils ne comptent comme « ailleurs » que
 * si la clause NOMME un objet qui n'est pas le passage — et seulement après que la lecture de
 * fiche a dit non (l'ordre de classement fait foi, aucune garde croisée).
 */
const VERBES_AMBIGUS =
  'envoie|envoies|envoyez|envoyer|transmets|transmettez|transmettre|adresse|adresses|adressez|adresser|' +
  'expedie|expedies|expediez|expedier|facture|factures|facturez|facturer|prepare|prepares|preparez|preparer|' +
  'fais|faites|faire|genere|generes|generez|generer|etablis|etablit|etablissez|etablir|cree|crees|creez|creer|' +
  'enregistre|enregistres|enregistrez|enregistrer|signe|signes|signez|signer|' +
  'valide|valides|validez|valider|lie|lies|liez|lier|attache|attaches|attachez|attacher';

/** Objets qui vivent AILLEURS que sur la fiche de passage. */
const OBJET_AILLEURS_SOURCE =
  'devis|factures?|avoirs?|relances?|situations?|acomptes?|soldes?|tresorerie|depenses?|tickets?|' +
  'recus?|justificatifs?|notifications?|contrats?|bons? de commande|equipements?|parc|rendez[- ]vous|' +
  'rdv|catalogue|echeances?|cloture';
const OBJET_AILLEURS = new RegExp(`\\b(?:${OBJET_AILLEURS_SOURCE})\\b`, 'u');

const TETE_AILLEURS = new RegExp(`${TETE_DE_CLAUSE}(?:${VERBES_AILLEURS})\\b`, 'u');
const TETE_AMBIGUE = new RegExp(`${TETE_DE_CLAUSE}(?:${VERBES_AMBIGUS})\\b`, 'u');

/**
 * Une demande n'a pas besoin d'un verbe pour en être une. Sans ces deux lectures, la borne ne
 * s'armait que sur une liste de verbes en tête : « c'est terminé, COMBIEN JE GAGNE ? » et
 * « c'est terminé, MA TRÉSORERIE ? » repartaient vers le passage — le routage par l'état
 * redevenait inconditionnel dès qu'on ne dictait pas un impératif.
 */
const DEMANDE_INTERROGATIVE = new RegExp(
  `${TETE_DE_CLAUSE}(?:combien|comment|pourquoi|quand|ou|qui|quels?|quelles?|est[- ]ce que|qu'est[- ]ce)\\b`,
  'u',
);
const DEMANDE_NOMINALE = new RegExp(
  `${TETE_DE_CLAUSE}(?:le|la|les|l'|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|nos|votre|vos|leurs?|` +
    `ce|cet|cette|ces|un|une|des|du|de la)\\s*(?:${OBJET_AILLEURS_SOURCE})\\b`,
  'u',
);

/**
 * Geste de passage demandé sous une forme NON impérative (« la fiche de passage est À ENVOYER »,
 * « le passage Carrefour, À FACTURER »). Ce n'est pas une certitude : Bob pose une question
 * plutôt que de deviner un geste — et plutôt que de se taire.
 */
const DEMANDE_INFINITIVE =
  /\b(?:a|pour|de)\s+(?:envoyer|facturer|faire signer|signer|terminer|cloturer|demarrer|commencer)\b/u;

// ── CLASSEMENT D'UNE CLAUSE ──────────────────────────────────────────────────────────────────

interface ClauseReading {
  readonly announces: boolean;
  readonly starts: boolean;
  /** LE geste de fiche demandé par cette clause — au plus un, celui dont le verbe est en tête. */
  readonly downstream: InterventionDownstream | null;
  readonly aside: InterventionAsideKind | null;
  /** Un geste de passage y est demandé, mais sans certitude : il faut poser la question. */
  readonly uncertain: boolean;
}

/** La clause commande-t-elle un ENVOI de fiche ? (verbe en tête, objet fiche, jamais nié) */
function demandeEnvoi(clause: string, ancre: boolean): boolean {
  return (
    ordreEnTete(clause, VERBES_ENVOI) !== null &&
    !PIECE_COMPTABLE.test(clause) &&
    !nie(clause, VERBES_ENVOI) &&
    (OBJET_FICHE.test(clause) || (ancre && ENVOI_PRONOMINAL.test(clause)))
  );
}

/**
 * La clause commande-t-elle une FACTURATION de passage ? Le verbe NU en tête (« facture ce
 * passage ») ou un verbe de CRÉATION suivi de son complément (« prépare la facture ») : une
 * pièce qui n'existe pas encore ne peut pas être l'objet d'une création. Le déterminant ne
 * classe plus rien — c'est la position en TÊTE qui dit l'ordre.
 */
function demandeFacturation(clause: string, ancre: boolean, marquee: boolean): boolean {
  const teteCreation = ordreEnTete(clause, VERBES_CREATION_FACTURE);
  const ordonne =
    ordreEnTete(clause, VERBES_FACTURATION) !== null ||
    (teteCreation !== null && COMPLEMENT_DE_FACTURE.test(clause.slice(teteCreation)));
  return (
    ordonne &&
    !FACTURATION_HORS_PASSAGE.test(clause) &&
    !PIECE_COMPTABLE.test(clause.replace(/\bfactur\w*/gu, ' ')) &&
    !nie(clause, VERBES_FACTURATION) &&
    // GARDE DU CHEMIN DE L'ARGENT : un montant dit ou une pièce numérotée sortent la consigne du
    // passage. Seul le marqueur que BOB a posé lui-même peut en dispenser — jamais « la visite ».
    (marquee || (!MONTANT_DIT.test(clause) && !PIECE_NUMEROTEE.test(clause))) &&
    (marquee || REFERENCE_PASSAGE.test(clause) || ancre)
  );
}

/** La clause commande-t-elle la SIGNATURE de la fiche ? */
function demandeSignature(clause: string): boolean {
  return (
    ordreEnTete(clause, GESTE_SIGNATURE) !== null &&
    !SIGNATURE_HORS_FICHE.test(clause) &&
    !nie(clause, VERBES_SIGNATURE)
  );
}

/**
 * Classe UNE clause, isolément. Le seul fait venu des autres clauses est `announced` — l'ancre
 * « une fin de passage a été annoncée ». Elle ACTIVE des lectures (« envoie-LA », « prépare LA
 * facture ») ; elle n'en éteint aucune. Aucune clause ne peut donc en neutraliser une autre.
 */
function readClause(clause: string, announced: boolean, marquee: boolean): ClauseReading {
  const announces = annonceDeFin(clause);
  const ancre = announced || announces;

  const starts =
    ordreEnTete(clause, VERBES_DEMARRAGE) !== null &&
    OBJET_DEMARRAGE.test(clause) &&
    !DEMARRAGE_HORS_FICHE.test(clause) &&
    !nie(clause, VERBES_DEMARRAGE);

  // Une clause ne porte qu'UN geste : celui que son verbe de TÊTE commande. L'ordre départage
  // les tournures où deux motifs voient la même tête (« fais signer » vs la création « fais »).
  const downstream: InterventionDownstream | null = demandeSignature(clause)
    ? 'sign'
    : demandeEnvoi(clause, ancre)
      ? 'send'
      : demandeFacturation(clause, ancre, marquee)
        ? 'bill'
        : null;

  if (announces || starts || downstream !== null)
    return { announces, starts, downstream, aside: null, uncertain: false };

  // La clause ne porte pas sur le passage : demande-t-elle quand même quelque chose ?
  const uncertain =
    DEMANDE_INFINITIVE.test(clause) && (OBJET_FICHE.test(clause) || REFERENCE_PASSAGE.test(clause));
  if (uncertain) return { announces, starts, downstream, aside: null, uncertain };
  if (TETE_AILLEURS.test(clause))
    return { announces, starts, downstream, aside: 'ailleurs', uncertain };
  if (TETE_AMBIGUE.test(clause))
    return {
      announces,
      starts,
      downstream,
      aside: OBJET_AILLEURS.test(clause) ? 'ailleurs' : 'incompris',
      uncertain,
    };
  // Une demande sans verbe reste une demande : « ma trésorerie ? », « combien je gagne ? ».
  if (DEMANDE_INTERROGATIVE.test(clause) && !ANCRE_DE_PASSAGE.test(clause))
    return { announces, starts, downstream, aside: 'ailleurs', uncertain };
  if (DEMANDE_NOMINALE.test(clause))
    return { announces, starts, downstream, aside: 'ailleurs', uncertain };
  // Ni annonce, ni geste, ni demande : un fait de terrain (« 0 € de pièces »). Rien à dire.
  return { announces, starts, downstream, aside: null, uncertain };
}

/**
 * Lecture d'UNE consigne. Chaque clause est classée SEULE ; le tour retient LE geste certain et
 * REND le reste. Aucun arbitrage entre plusieurs gestes : c'est le travail du chemin LLM.
 *
 * `hinges` = les CHARNIÈRES FACTUELLES de la lecture du résumé (sites et clients déjà résolus).
 * C'est le SEUL endroit où le résumé est lu : l'appelant qui écrit sur la pièce de preuve reprend
 * `summary` tel quel, avec les mêmes charnières, donc exactement le même texte que celui que la
 * carte tient pour compris. Le défaut (aucune charnière) sert le classement d'intent, qui n'écrit
 * sur aucune pièce de preuve — il ORIENTE, il ne signe rien.
 */
export function readInterventionDirective(
  message: string,
  hinges: InterventionSummaryHinges = {},
): InterventionDirective {
  const folded = fold(message);
  const marquee = MARQUEUR_DE_COMMANDE.test(folded);
  const clauses = splitClauses(folded);

  // Passe 1 — l'ANCRE : une fin de passage a-t-elle été annoncée quelque part dans la dictée ?
  const announcesCompletion = clauses.some((clause) => annonceDeFin(clause.folded));

  // Le RÉSUMÉ dicté part sur la FICHE (pièce de preuve) : le texte qu'il capte n'est donc PAS
  // une demande incomprise. UNE SEULE lecture du même texte, rendue telle quelle — la
  // réconciliation se fait ici, à la source, plutôt que dans deux cartes qui se contredisent.
  const resume = extractInterventionSummary(message, hinges);
  const resumeFolded = resume === null ? null : fold(resume);

  // Passe 2 — chaque clause est classée SÉPARÉMENT, avec cette seule ancre pour contexte.
  const asides: InterventionAside[] = [];
  let startsPassage = false;
  let downstream: InterventionDownstream | null = null;
  let needsClarification = false;
  const citation = (clause: Clause): string =>
    message
      .slice(clause.start, clause.end)
      .trim()
      .replace(/[\s,;.!?…]+$/u, '');
  for (const clause of clauses) {
    const reading = readClause(clause.folded, announcesCompletion, marquee);
    // Le PREMIER geste certain est retenu ; tout geste de plus est RENDU, jamais arbitré.
    if (reading.starts && !startsPassage && downstream === null) {
      startsPassage = true;
      continue;
    }
    if (reading.downstream !== null && downstream === null && !startsPassage) {
      downstream = reading.downstream;
      continue;
    }
    if (reading.starts || reading.downstream !== null) {
      const text = citation(clause);
      if (text.length > 0) asides.push({ text, kind: 'reporte' });
      continue;
    }
    if (reading.uncertain) {
      needsClarification = true;
      continue;
    }
    if (reading.aside === null) continue;
    const text = citation(clause);
    if (text.length === 0) continue;
    // Le texte capté comme RÉSUMÉ est écrit sur la fiche : il n'est pas « incompris ».
    const inclus = fold(text);
    if (resumeFolded !== null && (inclus.includes(resumeFolded) || resumeFolded.includes(inclus)))
      continue;
    asides.push({ text, kind: reading.aside });
  }

  const divertsElsewhere = asides.some((aside) => aside.kind === 'ailleurs');
  const certain = startsPassage || downstream !== null;
  const gesture: InterventionGesture | null = startsPassage
    ? 'start'
    : announcesCompletion && (certain || !divertsElsewhere)
      ? 'complete'
      : downstream;

  return {
    startsPassage,
    announcesCompletion,
    downstream,
    downstreams: downstream === null ? [] : [downstream],
    asides,
    summary: resume,
    divertsElsewhere,
    gesture,
    // On ne pose la question que si RIEN n'est certain : le doute ne produit ni geste faux, ni
    // silence — mais il ne prend jamais le pas sur une consigne qui, elle, est claire.
    needsClarification: needsClarification && gesture === null,
  };
}

/**
 * Demande RÉELLE du tour : le geste classé, complété par ce que dit la phrase. Le classement
 * peut venir d'un modèle : la directive reste lue sur le texte, mais le tour ne porte JAMAIS
 * plus d'un geste aval — les autres ont été rendus (`asides`) à la lecture.
 */
export function interventionRequestFor(
  gesture: InterventionGesture,
  directive: InterventionDirective,
): InterventionRequest {
  if (gesture === 'start')
    return { starts: true, completes: false, downstreams: [], asides: directive.asides };
  const downstreams: readonly InterventionDownstream[] =
    gesture === 'complete' ? directive.downstreams : [gesture];
  return {
    starts: false,
    completes: gesture === 'complete' || directive.announcesCompletion,
    downstreams,
    asides: directive.asides,
  };
}

/**
 * Le geste que la consigne DEMANDE, dans l'ordre du parcours §3.7 — indépendamment de tout
 * passage. C'est LUI que Bob nomme quand aucune fiche ne se résout : sans cela, le refus était
 * libellé d'après l'intent DÉTECTÉ tandis que l'exécution suivait l'intent RÉSOLU, et la
 * télémétrie des refus mentait (revue de vérification 29/07, finding 7).
 */
export function requestedGesture(request: InterventionRequest): InterventionGesture {
  if (request.starts) return 'start';
  if (request.completes) return 'complete';
  return request.downstreams[0] ?? 'complete';
}

/** Un passage accepte-t-il CE geste, dans l'état où il est RÉELLEMENT ? */
export function acceptsGesture(view: InterventionStateView, gesture: InterventionGesture): boolean {
  if (gesture === 'start') return view.status === 'scheduled';
  if (gesture === 'complete') return view.status === 'in_progress';
  if (gesture === 'sign') return view.status === 'completed';
  const acheve = view.status === 'completed' || view.status === 'signed';
  if (gesture === 'send') return acheve;
  // Facturation : hors contrat (direction 6) et non couvert par une pièce VIVANTE. L'extinction
  // se fait par l'ÉTAT RÉEL — une facture annulée (avoir) rallume le geste, comme le use case.
  return (
    acheve &&
    view.contractId === null &&
    (view.billedInvoiceId === null ||
      view.billedInvoiceStatus === null ||
      view.billedInvoiceStatus === 'cancelled')
  );
}

/**
 * Ce que la consigne laisse pour APRÈS le geste courant : le prochain geste possible, et le
 * geste COMPRIS mais impossible — celui-là sera DIT, jamais tu. La liste ne contient qu'UN geste
 * (le déterministe n'en porte pas deux) : rien ne peut donc être perdu entre `then` et `withheld`.
 */
function planDownstream(
  view: InterventionStateView,
  gestures: readonly InterventionDownstream[],
): { then: InterventionDownstream | null; withheld: InterventionDownstream | null } {
  const then = gestures.find((geste) => acceptsGesture(view, geste)) ?? null;
  const withheld = gestures.find((geste) => geste !== then) ?? null;
  return { then, withheld };
}

/**
 * LE ROUTAGE. La consigne composite est tranchée par l'ÉTAT, jamais par le lexique : on termine
 * quand il y a quelque chose à terminer, sinon on exécute directement le geste aval. `null` =
 * ce passage-là n'est concerné par rien — l'appelant doit alors DIRE ce qui manque.
 */
export function resolveInterventionGesture(
  request: InterventionRequest,
  view: InterventionStateView,
): InterventionResolution | null {
  if (request.starts)
    return acceptsGesture(view, 'start') ? { gesture: 'start', then: null, withheld: null } : null;
  if (request.completes && acceptsGesture(view, 'complete')) {
    // Le geste aval se juge sur l'état d'APRÈS la complétion : c'est là qu'il s'exécutera.
    const apres: InterventionStateView = { ...view, status: 'completed' };
    return { gesture: 'complete', ...planDownstream(apres, request.downstreams) };
  }
  const faisable = request.downstreams.find((geste) => acceptsGesture(view, geste));
  if (faisable !== undefined) {
    const reste = request.downstreams.filter((geste) => geste !== faisable);
    return { gesture: faisable, ...planDownstream(view, reste) };
  }
  return null;
}

/** Verbe du geste aval, tel que Bob le DIT dans un refus honnête. */
const VERBE_AVAL: Record<InterventionDownstream, string> = {
  sign: 'le faire signer',
  send: 'envoyer la fiche',
  bill: 'le facturer',
};

/**
 * Pourquoi CE geste aval ne se fera pas, même après le geste courant. Bob le DIT dans la même
 * carte : une demande comprise n'est jamais jetée en silence.
 */
export function explainWithheldDownstream(
  view: InterventionStateView,
  downstream: InterventionDownstream,
  label: string,
): string {
  if (downstream === 'bill') {
    if (view.contractId !== null)
      return `Je ne pourrai pas ${VERBE_AVAL.bill} : ${label} est une visite contractuelle, déjà couverte par la facture annuelle du contrat.`;
    if (view.billedInvoiceId !== null && view.billedInvoiceStatus !== 'cancelled')
      return `Je ne pourrai pas ${VERBE_AVAL.bill} : ${label} est déjà couvert par une facture — je n’en refais pas une seconde.`;
  }
  if (downstream === 'sign' && view.status === 'signed')
    return `Je ne pourrai pas ${VERBE_AVAL.sign} : ${label} est déjà signé par le client.`;
  if (view.status === 'cancelled')
    return `Je ne pourrai pas ${VERBE_AVAL[downstream]} : ${label} est annulé.`;
  return `Je ne pourrai pas ${VERBE_AVAL[downstream]} sur ${label} dans la foulée — dis-le-moi à part et je regarde.`;
}

/**
 * Pourquoi CE passage n'est concerné par rien — l'état RÉEL, dit en clair, avec le chemin
 * actionnable. Bob ne répond jamais « aucun passage » quand il y en a un sous la main.
 */
export function explainInterventionBlock(
  view: InterventionStateView,
  request: InterventionRequest,
  label: string,
): string {
  if (request.starts) {
    if (view.status === 'in_progress') return `${label} est déjà en cours — dis-moi « c’est terminé » quand tu as fini.`;
    if (view.status === 'completed' || view.status === 'signed')
      return `${label} est déjà terminé — je peux t’envoyer la fiche ou préparer la facture.`;
    return `${label} est annulé — il ne se démarre plus.`;
  }
  // La RAISON se lit sur le geste réellement demandé : « prépare la facture » sur un passage
  // déjà facturé doit s'entendre dire « déjà couvert par une facture », jamais « plus rien à
  // terminer dessus » (revue de vérification 29/07 — cases E4/E5/E6 × C12).
  if (request.downstreams.includes('bill')) {
    if (view.contractId !== null)
      return `${label} est une visite contractuelle : il est couvert par la facture annuelle du contrat — il ne se facture pas à part.`;
    if (
      (view.status === 'completed' || view.status === 'signed') &&
      view.billedInvoiceId !== null &&
      view.billedInvoiceStatus !== null &&
      view.billedInvoiceStatus !== 'cancelled'
    )
      return `${label} est déjà couvert par une facture — je n’en refais pas une seconde.`;
  }
  if (view.status === 'scheduled')
    return `${label} n’est pas encore démarré — dis-moi « démarre l’intervention » quand tu y es.`;
  if (view.status === 'in_progress')
    return `${label} est encore en cours — dis-moi « c’est terminé » et j’enchaîne.`;
  if (view.status === 'cancelled') return `${label} est annulé — plus rien ne s’y fait.`;
  if (request.downstreams.includes('sign') && view.status === 'signed')
    return `${label} est déjà signé par le client.`;
  return `${label} est déjà terminé — il n’y a plus rien à terminer dessus.`;
}

/**
 * Ce que Bob NE fait PAS dans ce tour, dit dans la MÊME carte. Le silence sur la moitié d'une
 * consigne est interdit : un geste de passage EN TROP est reporté et redit tel quel, ce qui
 * porte ailleurs est cité VERBATIM, ce qui n'a pas été compris est avoué tel quel.
 */
export function explainInterventionAsides(asides: readonly InterventionAside[]): string {
  if (asides.length === 0) return '';
  const cite = (textes: readonly string[], liaison: string): string =>
    textes.map((texte) => `« ${texte} »`).join(liaison);
  const de = (kind: InterventionAsideKind): string[] =>
    asides.filter((aside) => aside.kind === kind).map((aside) => aside.text);
  const reporte = de('reporte');
  const ailleurs = de('ailleurs');
  const incompris = de('incompris');
  const phrases: string[] = [];
  if (reporte.length > 0)
    phrases.push(
      `Je ne traite pas ${cite(reporte, ' ni ')} dans ce tour — redis-le-moi et je m’en occupe.`,
    );
  if (ailleurs.length > 0)
    phrases.push(
      `Je ne touche pas à ${cite(ailleurs, ' ni à ')} dans ce tour — c’est un autre geste : redis-le-moi et je m’en occupe.`,
    );
  if (incompris.length > 0)
    phrases.push(
      `Je n’ai pas su quoi faire de ${cite(incompris, ' ni de ')} — reformule-le et je m’en occupe.`,
    );
  return phrases.join(' ');
}
