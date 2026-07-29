/**
 * §3.7 — CONSIGNE COMPOSITE de fiche de passage : « c'est terminé, facture ce passage ».
 *
 * [Revue de vérification 29/07 — LECTURE CLAUSE PAR CLAUSE, PUIS ROUTAGE PAR L'ÉTAT]
 *
 * Cinq passes ont tenté d'arbitrer « terminer » CONTRE « envoyer / facturer ». Chacune a
 * DÉPLACÉ l'impasse au lieu de la supprimer :
 *
 *   · passes 3 & 4 — gardes lexicales croisées dans `intent.ts` : « fin + envoyer » (puis
 *     « fin + facturer ») partait au geste aval sur une fiche qui n'existait pas encore ;
 *   · passe 5 — les gardes ont été retirées d'`intent.ts` et REMISES ici, appliquées au
 *     MESSAGE ENTIER. Un mot d'une clause éteignait alors l'autre clause : « envoie la fiche de
 *     passage ET FACTURE ce passage » perdait l'envoi (le mot « facture » de la 2ᵉ clause) ;
 *     « j'ai fini la visite ANNUELLE, facture ce passage » perdait la facturation (un mot du
 *     LIBELLÉ) ; « c'est terminé, facture ce passage, 0 € DE PIÈCES » aussi (un fait de terrain).
 *     Et le routage par l'état, INCONDITIONNEL, détournait « c'est terminé, ENVOIE LA FACTURE au
 *     client » vers la complétion d'un passage dont il n'était pas question.
 *
 * LA CAUSE COMMUNE : on appliquait des expressions régulières au MESSAGE ENTIER pour arbitrer
 * entre des gestes qui vivent dans des CLAUSES différentes. Le patron qui a résolu proprement la
 * même pathologie pour le résumé de passage (`intervention-summary.ts`) est appliqué ici :
 *
 *   1. la dictée est DÉCOUPÉE sur ses coordinations (virgule, « et », « puis », « ensuite »,
 *      « après »), et sur l'enchaînement au fil (« c'est terminé envoie la fiche ») ;
 *   2. CHAQUE CLAUSE est classée SÉPARÉMENT : annonce de fin, démarrage, geste de fiche,
 *      demande qui porte AILLEURS, ou simple fait de terrain ;
 *   3. plus AUCUNE expression régulière d'arbitrage ne voit le message entier. Une clause ne
 *      peut donc plus en éteindre une autre. La seule chose qu'une clause transmet aux autres
 *      est l'ANCRE « une fin de passage a été annoncée » — un fait qui ACTIVE des lectures
 *      (« envoie-LA », « prépare LA FACTURE »), jamais une garde qui en éteint.
 *
 * Ce qui reste vrai : l'arbitrage entre TERMINER et le geste aval appartient à l'ÉTAT RÉEL du
 * passage (`resolveInterventionGesture`), jamais au lexique —
 *
 *   passage `in_progress`            → on TERMINE, puis on annonce le geste aval ;
 *   passage `completed` / `signed`   → « c'est terminé » n'est qu'un RAPPEL : on exécute
 *                                      DIRECTEMENT le geste aval ;
 *   aucun passage au bon état        → on dit honnêtement ce qui manque.
 *
 * Ce qui est nouveau : ce routage est BORNÉ AUX GESTES DE PASSAGE. Si la clause aval demande
 * autre chose (envoyer/encaisser/émettre une FACTURE, la trésorerie, une dépense, une visite à
 * programmer), l'annonce de fin ne capte RIEN — chaque clause garde son intent d'origine. Et
 * rien n'est jamais jeté en silence : ce que Bob comprend sans pouvoir le faire, et ce qu'il ne
 * comprend pas du tout, sont RENDUS à l'appelant (`asides`) pour être DITS dans la même carte.
 */

/** Geste AVAL d'une consigne composite — ce que l'artisan enchaîne après la fin du passage. */
export type InterventionDownstream = 'sign' | 'send' | 'bill';

/** Geste de fiche réellement exécutable — l'ordre du parcours §3.7. */
export type InterventionGesture = 'start' | 'complete' | InterventionDownstream;

/**
 * Ce qu'une clause demande SANS que cela porte sur le passage. `ailleurs` = un geste identifié
 * qui vit ailleurs (facture, trésorerie, dépense, planning) ; `incompris` = une demande dont Bob
 * n'a pas su faire quoi que ce soit. Les deux se DISENT — le silence sur la moitié d'une
 * consigne est interdit.
 */
export type InterventionAsideKind = 'ailleurs' | 'incompris';

/** Une demande de la consigne qui ne porte pas sur le passage — citée VERBATIM. */
export interface InterventionAside {
  /** Tranche du message ORIGINAL (aucune retranscription) : Bob cite ce qui a été dit. */
  readonly text: string;
  readonly kind: InterventionAsideKind;
}

/** Lecture CLAUSE PAR CLAUSE de la consigne : ce qui est dit, jamais qui l'emporte sur quoi. */
export interface InterventionDirective {
  /** « démarre l'intervention chez Carrefour » — ouverture du passage. */
  readonly startsPassage: boolean;
  /** « c'est terminé », « j'ai fini », « le passage est terminé » — ANNONCE de fin. */
  readonly announcesCompletion: boolean;
  /** PREMIER geste de fiche demandé, dans l'ordre dicté — `null` quand il n'y en a aucun. */
  readonly downstream: InterventionDownstream | null;
  /** TOUS les gestes de fiche demandés, dans l'ordre dicté, sans doublon. */
  readonly downstreams: readonly InterventionDownstream[];
  /** Ce que la consigne demande d'autre — jamais jeté en silence. */
  readonly asides: readonly InterventionAside[];
  /** Au moins une clause demande un geste IDENTIFIÉ qui ne porte pas sur le passage. */
  readonly divertsElsewhere: boolean;
}

/** Demande RÉELLE portée par le tour : le geste classé, enrichi de ce que dit la phrase. */
export interface InterventionRequest {
  readonly starts: boolean;
  readonly completes: boolean;
  /** Gestes de fiche demandés, DANS L'ORDRE DICTÉ — jamais réduits à un seul. */
  readonly downstreams: readonly InterventionDownstream[];
  /** Demandes de la consigne qui portent ailleurs — l'appelant DOIT les dire. */
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
 * Coordinations de la dictée — MÊME découpe que le résumé de passage : c'est là que la consigne
 * suivante commence, quand elle commence. La fin de phrase coupe aussi : au-delà, on ne parle
 * plus de la même chose.
 *
 * La virgule et le point ENTRE DEUX CHIFFRES sont une décimale, jamais une coordination :
 * « facture 380,50 € » doit rester UNE clause, sinon le montant part dans la clause suivante et
 * la garde qui protège la facture directe (B1) ne le voit plus — et Bob citerait « facture 380 »
 * en disant ce qu'il ne fait pas. La règle ne vaut QUE pour la décimale : le point final de
 * « émets la facture 2026-014. » suit bien un chiffre, et il coupe.
 */
const COORDINATION =
  /(?:(?<!\d)|(?![.,]\d))\s*[,;.!?…]+\s*|\s+(?:et|puis|ensuite|apres|donc|alors|enfin)\s+/gu;

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

// ── GESTES (lus sur UNE clause) ──────────────────────────────────────────────────────────────

/** Une négation ne déclenche JAMAIS un geste — ni avant le verbe, ni juste après. */
function nie(clause: string, verbes: string): boolean {
  return new RegExp(
    `\\b(?:ne|n|pas|jamais|surtout pas)\\b.{0,24}\\b(?:${verbes})\\b|\\b(?:${verbes})\\b.{0,30}\\bpas\\b`,
    'u',
  ).test(clause);
}

const VERBES_ENVOI =
  'envoie|envoies|envoyer|envoyez|transmets|transmettez|transmettre|adresse|adresses|adresser|expedie|expedies|expedier';
const OBJET_FICHE = /\b(?:fiches?|rapports?|comptes? rendus?|passages?|interventions?)\b/u;
/** Une pièce comptable nommée garde son propre geste : « envoie la facture 2026-014 ». */
const PIECE_COMPTABLE = /\b(?:devis|factures?|avoirs?|relances?)\b/u;
/** « envoie-la », « transmets-lui » : après une fin annoncée, le seul envoyable est la fiche. */
const ENVOI_PRONOMINAL =
  /\b(?:envoie|envoies|envoyer|transmets|transmettre|adresse|adresser)[- ](?:le|la|les|lui|leur|moi|nous|ca|cela)\b/u;

const VERBES_SIGNATURE = 'signe|signes|signer|signature';
const GESTE_SIGNATURE =
  /\b(?:fais(?:-| )?(?:le |la )?signer|faire signer|fais(?:-| )?moi signer|prends? la signature|prendre la signature|(?:le |la )?client signe|signature (?:du|de la) client)\b/u;
/** Un devis / un contrat signé garde son intent : la signature de fiche n'y touche jamais. */
const SIGNATURE_HORS_FICHE = /\b(?:devis|factures?|contrats?|bons? de commande)\b/u;

const VERBES_FACTURATION = 'facture|factures|facturer|facturez|factureras';
/**
 * « facture » est d'abord un NOM. Précédé d'un déterminant (« envoie LA FACTURE »), il désigne
 * une PIÈCE ; sans déterminant, c'est le GESTE. C'est cette distinction — et non la présence
 * d'un démonstratif — qui autorise « facture-moi ça » et « facture le client ».
 */
const DETERMINANT_AVANT_FACTURE =
  /(?:\b(?:la|une|ma|ta|sa|notre|votre|leur|leurs|cette|les|des|mes|tes|ses|nos|vos|aux?|du|de|d')\s+|\bd')$/u;
/**
 * [Revue de vérification 29/07 — E4/E5/E6 × C12] « prépare LA facture » restait classé PIÈCE par
 * la règle du déterminant : « j'ai fini le boulot, prépare la facture » ne facturait donc RIEN,
 * et Bob répondait « plus rien à terminer ». Le déterminant ne dit pas tout : un verbe de
 * CRÉATION (« prépare », « fais », « établis ») ne peut pas porter sur une pièce qui n'existe
 * pas encore — sur un passage, c'est LE geste de facturation. La lecture reste bornée : ni
 * montant dit, ni devis, ni situation, ni référence de pièce dans la MÊME clause.
 */
const CREATION_DE_FACTURE =
  /\b(?:prepare|prepares|preparez|preparer|fais|faites|faire|etablis|etablit|etablissez|etablir|monte|montes|montez|monter|redige|rediges|redigez|rediger|genere|generes|generez|generer|cree|crees|creez|creer)\b(?:[- ](?:moi|nous|lui))?\s+(?:la|une|ma|sa|leur|cette|l')\s*factur\w*/u;
/** Un MONTANT dit fait de la consigne une facture directe (B1) — jamais un passage à facturer. */
const MONTANT_DIT = /(?:€|\beuros?\b|\bht\b|\bttc\b|\btva\b|\b\d+\s*(?:e|eur)\b)/u;
/** Facturation contractuelle / de situation : d'autres gestes, jamais la fiche de passage. */
const FACTURATION_HORS_PASSAGE = /\b(?:annuelle?s?|contrats?|situations?|acomptes?|soldes?)\b/u;
/**
 * Une pièce NUMÉROTÉE existe déjà : « prépare la facture 2026-014 » n'est pas un passage à
 * facturer. Le numéro doit être ADJACENT à la pièce — un identifiant de passage plus loin dans
 * la phrase (« Facture le passage 4d1c…-112233445566 ») n'a jamais nommé de facture.
 */
const PIECE_NUMEROTEE = /\bfactur\w*\s+(?:n[°o]\s*)?[a-z]*\d{3,}/u;
/** Référence DÉMONSTRATIVE au passage — suffit à elle seule, sans annonce de fin. */
const REFERENCE_PASSAGE =
  /\b(?:ce passage|cette intervention|cette visite|ce depannage|le passage|la visite|l'intervention de)\b/u;

const VERBES_DEMARRAGE = 'demarre|demarrer|demarres|commence|commencer|commences|debute|debuter|lance|lancer';
const OBJET_DEMARRAGE = /\b(?:interventions?|passages?|visites?|chantier|depannage)\b/u;
const DEMARRAGE_HORS_FICHE = /\b(?:devis|factures?|relances?|scan)\b/u;

/** Première position d'un motif dans la clause — l'ordre dicté est l'ordre du parcours. */
function premierePosition(clause: string, motif: RegExp): number {
  const found = new RegExp(motif.source, 'u').exec(clause);
  return found ? found.index : Number.MAX_SAFE_INTEGER;
}

/** Le verbe de facturation est-il employé comme GESTE (et non comme nom de pièce) ? */
function gesteDeFacturation(clause: string): number {
  for (const match of clause.matchAll(new RegExp(`\\b(?:${VERBES_FACTURATION})\\b`, 'gu'))) {
    if (match.index === undefined) continue;
    if (!DETERMINANT_AVANT_FACTURE.test(clause.slice(0, match.index))) return match.index;
  }
  return Number.MAX_SAFE_INTEGER;
}

// ── DEMANDES QUI PORTENT AILLEURS (lues sur UNE clause) ──────────────────────────────────────

/**
 * Une consigne OCCUPE son propre morceau : elle s'ouvre par son verbe (éventuellement précédé
 * d'un enchaînement ou d'un pronom). Lire la TÊTE de clause — et non le message — évite de
 * prendre un participe pour un ordre : dans « la pression était basse mais c'est réglé »,
 * « réglé » n'a jamais demandé de régler quoi que ce soit.
 */
const TETE_DE_CLAUSE =
  `^(?:et\\s+|puis\\s+|ensuite\\s+|apres\\s+|enfin\\s+|maintenant\\s+|tu\\s+|il\\s+faut\\s+|faut\\s+|vas[- ]y\\s+|allez\\s+)*` +
  `(?:me\\s+|te\\s+|lui\\s+|leur\\s+|nous\\s+|les\\s+|le\\s+|la\\s+|l')?`;

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
  'declarer|marque|marques|marquez|marquer|resume|resumes|resumez|resumer|calcule|calcules|calculez|calculer';

/**
 * Verbes AMBIGUS : ils peuvent servir un geste de fiche. Ils ne comptent comme « ailleurs » que
 * si la clause NOMME un objet qui n'est pas le passage — et seulement après que la lecture de
 * fiche a dit non (l'ordre de classement fait foi, aucune garde croisée).
 */
const VERBES_AMBIGUS =
  'envoie|envoies|envoyez|envoyer|transmets|transmettez|transmettre|adresse|adresses|adressez|adresser|' +
  'expedie|expedies|expediez|expedier|facture|factures|facturez|facturer|prepare|prepares|preparez|preparer|' +
  'fais|faites|faire|genere|generes|generez|generer|etablis|etablit|etablissez|etablir|cree|crees|creez|creer|' +
  'note|notes|notez|noter|enregistre|enregistres|enregistrez|enregistrer|signe|signes|signez|signer|' +
  'valide|valides|validez|valider|lie|lies|liez|lier|attache|attaches|attachez|attacher';

/** Objets qui vivent AILLEURS que sur la fiche de passage. */
const OBJET_AILLEURS =
  /\b(?:devis|factures?|avoirs?|relances?|situations?|acomptes?|soldes?|tresorerie|depenses?|tickets?|recus?|justificatifs?|notifications?|contrats?|bons? de commande|equipements?|parc|rendez[- ]vous|rdv|catalogue|echeances?|cloture)\b/u;

const TETE_AILLEURS = new RegExp(`${TETE_DE_CLAUSE}(?:${VERBES_AILLEURS})\\b`, 'u');
const TETE_AMBIGUE = new RegExp(`${TETE_DE_CLAUSE}(?:${VERBES_AMBIGUS})\\b`, 'u');

// ── CLASSEMENT D'UNE CLAUSE ──────────────────────────────────────────────────────────────────

interface ClauseReading {
  readonly announces: boolean;
  readonly starts: boolean;
  /** Gestes de fiche demandés PAR CETTE CLAUSE, dans l'ordre où ils y apparaissent. */
  readonly downstreams: readonly InterventionDownstream[];
  readonly aside: InterventionAsideKind | null;
}

/**
 * Classe UNE clause, isolément. Le seul fait venu des autres clauses est `announced` — l'ancre
 * « une fin de passage a été annoncée ». Elle ACTIVE des lectures (« envoie-la », « prépare la
 * facture ») ; elle n'en éteint aucune. Aucune clause ne peut donc en neutraliser une autre.
 */
function readClause(clause: string, announced: boolean): ClauseReading {
  const announces = annonceDeFin(clause);
  const ancre = announced || announces;

  const starts =
    new RegExp(`\\b(?:${VERBES_DEMARRAGE})\\b`, 'u').test(clause) &&
    OBJET_DEMARRAGE.test(clause) &&
    !DEMARRAGE_HORS_FICHE.test(clause) &&
    !nie(clause, VERBES_DEMARRAGE);

  const positionEnvoi =
    new RegExp(`\\b(?:${VERBES_ENVOI})\\b`, 'u').test(clause) &&
    !PIECE_COMPTABLE.test(clause) &&
    !nie(clause, VERBES_ENVOI) &&
    (OBJET_FICHE.test(clause) || (ancre && ENVOI_PRONOMINAL.test(clause)))
      ? premierePosition(clause, new RegExp(`\\b(?:${VERBES_ENVOI})\\b`))
      : Number.MAX_SAFE_INTEGER;

  const gesteFacture = gesteDeFacturation(clause);
  const creationFacture =
    gesteFacture === Number.MAX_SAFE_INTEGER ? CREATION_DE_FACTURE.exec(clause) : null;
  const positionFactureBrute =
    gesteFacture !== Number.MAX_SAFE_INTEGER
      ? gesteFacture
      : (creationFacture?.index ?? Number.MAX_SAFE_INTEGER);
  // Une référence EXPLICITE au passage (« ce passage », « le passage », « cette intervention »)
  // est un signal plus fort qu'un nombre : c'est elle que porte la commande canonique rejouée
  // après une désambiguïsation (« Facture le passage <id> »). Sans cette précédence, un
  // identifiant de fiche suffisait à éteindre le geste — et la question « Quel passage ? »
  // rebouclait indéfiniment sur elle-même. La NATURE de la facturation (contrat, situation,
  // acompte), elle, reste décisive dans tous les cas : ce n'est pas un nombre, c'est un geste.
  const referenceExplicite = REFERENCE_PASSAGE.test(clause);
  const positionFacture =
    positionFactureBrute !== Number.MAX_SAFE_INTEGER &&
    !FACTURATION_HORS_PASSAGE.test(clause) &&
    !PIECE_COMPTABLE.test(clause.replace(/\bfactur\w*/gu, ' ')) &&
    !nie(clause, VERBES_FACTURATION) &&
    (referenceExplicite || (!MONTANT_DIT.test(clause) && !PIECE_NUMEROTEE.test(clause))) &&
    (referenceExplicite || ancre)
      ? positionFactureBrute
      : Number.MAX_SAFE_INTEGER;

  const positionSignature =
    GESTE_SIGNATURE.test(clause) && !SIGNATURE_HORS_FICHE.test(clause) && !nie(clause, VERBES_SIGNATURE)
      ? premierePosition(clause, GESTE_SIGNATURE)
      : Number.MAX_SAFE_INTEGER;

  const downstreams = ([
    ['sign', positionSignature],
    ['send', positionEnvoi],
    ['bill', positionFacture],
  ] as readonly [InterventionDownstream, number][])
    .filter(([, position]) => position !== Number.MAX_SAFE_INTEGER)
    .sort((left, right) => left[1] - right[1])
    .map(([geste]) => geste);

  if (announces || starts || downstreams.length > 0)
    return { announces, starts, downstreams, aside: null };

  // La clause ne porte pas sur le passage : demande-t-elle quand même quelque chose ?
  if (TETE_AILLEURS.test(clause)) return { announces, starts, downstreams, aside: 'ailleurs' };
  if (TETE_AMBIGUE.test(clause))
    return {
      announces,
      starts,
      downstreams,
      aside: OBJET_AILLEURS.test(clause) ? 'ailleurs' : 'incompris',
    };
  // Ni annonce, ni geste, ni demande : un fait de terrain (« 0 € de pièces »). Rien à dire.
  return { announces, starts, downstreams, aside: null };
}

/**
 * Lecture CLAUSE PAR CLAUSE de la consigne. Aucun arbitrage lexical ne s'applique au message
 * entier : chaque clause est classée seule, et l'arbitrage entre les gestes retenus a lieu sur
 * l'ÉTAT du passage (`resolveInterventionGesture`).
 */
export function readInterventionDirective(message: string): InterventionDirective {
  const folded = fold(message);
  const clauses = splitClauses(folded);

  // Passe 1 — l'ANCRE : une fin de passage a-t-elle été annoncée quelque part dans la dictée ?
  const announcesCompletion = clauses.some((clause) => annonceDeFin(clause.folded));

  // Passe 2 — chaque clause est classée SÉPARÉMENT, avec cette seule ancre pour contexte.
  const downstreams: InterventionDownstream[] = [];
  const asides: InterventionAside[] = [];
  let startsPassage = false;
  for (const clause of clauses) {
    const reading = readClause(clause.folded, announcesCompletion);
    if (reading.starts) startsPassage = true;
    for (const geste of reading.downstreams) if (!downstreams.includes(geste)) downstreams.push(geste);
    if (reading.aside !== null) {
      // Citation VERBATIM (tranche du message d'origine), débarrassée de la seule ponctuation
      // de liaison : Bob cite ce qui a été dit, jamais un fragment orné d'une virgule pendante.
      const text = message
        .slice(clause.start, clause.end)
        .trim()
        .replace(/[\s,;.!?…]+$/u, '');
      if (text.length > 0) asides.push({ text, kind: reading.aside });
    }
  }

  return {
    startsPassage,
    announcesCompletion,
    downstream: downstreams[0] ?? null,
    downstreams,
    asides,
    divertsElsewhere: asides.some((aside) => aside.kind === 'ailleurs'),
  };
}

/**
 * Demande RÉELLE du tour : le geste principal issu du classement, complété par ce que dit la
 * phrase. Le classement peut venir d'un modèle (classifieur LLM) : la directive reste lue sur le
 * texte, si bien qu'une consigne composite garde TOUS ses gestes aval, même mal classée.
 */
export function interventionRequestFor(
  gesture: InterventionGesture,
  directive: InterventionDirective,
): InterventionRequest {
  if (gesture === 'start')
    return { starts: true, completes: false, downstreams: [], asides: directive.asides };
  const dictes = directive.downstreams;
  const downstreams =
    gesture === 'complete'
      ? [...dictes]
      : [gesture, ...dictes.filter((geste) => geste !== gesture)];
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
 * premier geste COMPRIS mais impossible — celui-là sera DIT, jamais tu.
 */
function planDownstream(
  view: InterventionStateView,
  gestures: readonly InterventionDownstream[],
): { then: InterventionDownstream | null; withheld: InterventionDownstream | null } {
  const then = gestures.find((geste) => acceptsGesture(view, geste)) ?? null;
  const withheld = gestures.find((geste) => geste !== then && !acceptsGesture(view, geste)) ?? null;
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
 * consigne est interdit : ce qui porte ailleurs est cité VERBATIM, ce qui n'a pas été compris
 * est avoué tel quel.
 */
export function explainInterventionAsides(asides: readonly InterventionAside[]): string {
  if (asides.length === 0) return '';
  const ailleurs = asides.filter((aside) => aside.kind === 'ailleurs').map((aside) => aside.text);
  const incompris = asides.filter((aside) => aside.kind === 'incompris').map((aside) => aside.text);
  const phrases: string[] = [];
  if (ailleurs.length > 0)
    phrases.push(
      `Je ne touche pas à ${ailleurs.map((texte) => `« ${texte} »`).join(' ni à ')} dans ce tour — c’est un autre geste : redis-le-moi et je m’en occupe.`,
    );
  if (incompris.length > 0)
    phrases.push(
      `Je n’ai pas su quoi faire de ${incompris.map((texte) => `« ${texte} »`).join(' ni de ')} — reformule-le et je m’en occupe.`,
    );
  return phrases.join(' ');
}
