/**
 * FORME SÛRE D'UN MOT IMPRIMABLE — module PUR du domaine (zéro I/O, zéro état).
 *
 * ── POURQUOI CETTE RÈGLE VIT DANS LE DOMAINE ────────────────────────────────────────────────
 *
 * Sept passes ont conclu la même chose, la dernière contre la garde elle-même : aucun extracteur
 * de langue naturelle ne sépare parfaitement le NOM d'une prestation des FAITS dits autour de
 * lui. Blanchir la forme ferme les symboles et les chiffres ; accepter un mot alphabétique
 * inconnu exigerait un dictionnaire du français — et refuserait les noms propres des clients.
 * C'est irréductible.
 *
 * On a donc cessé de poursuivre la perfection de l'extraction et supprimé sa CONSÉQUENCE : ce
 * qui s'imprime sur une pièce est COMPOSÉ par le domaine (`annual-invoice-designation.ts`), et
 * un texte venu de la parole n'y entre que FILTRÉ par la règle ci-dessous. C'est le domaine qui
 * imprime : c'est donc lui qui dit ce qu'un mot imprimable peut être. La garde de @bob/ai
 * (`contract-label-guard.ts`) lit la MÊME règle — une garde et une composition qui divergeraient
 * sur la définition d'un mot sûr laisseraient un trou entre elles.
 *
 * ── LES DEUX ÉTAGES ────────────────────────────────────────────────────────────────────────
 *
 *  1. LA FORME (fermée par construction). Un mot est sûr s'il est : alphabétique (accents,
 *     trait d'union, apostrophe interne — « porte-à-faux », « l'Eurotunnel ») ; OU un nombre
 *     COURT isolé (1 à 3 chiffres — « quai 3 », « 4 saisons ») ; OU l'un des DOUZE connecteurs
 *     dont un groupe nominal a besoin ; OU une LETTRE MAJUSCULE seule (« hall A », désignation
 *     de bâtiment que le métier dicte tous les jours). Tout le reste refuse : les symboles
 *     (%, €, /, +), les jetons mixtes (« 1er », « BT01 »), les millésimes, les nombres à
 *     séparateur, et les MOTS DE PHRASE — « au », « pour », « sans », « dans », « ici » —,
 *     dont la classe grammaticale est fermée, donc énumérable, contrairement aux tournures
 *     qu'ils composent. Un mot de phrase PROUVE que le fragment est un morceau de phrase et
 *     non un nom : c'est lui qui refuse « au tarif » sans qu'aucune liste ne parle de tarifs.
 *
 *  2. LE LEXIQUE FERMÉ (fini par nature). Des mots parfaitement alphabétiques qui ne nomment
 *     JAMAIS une prestation : les 12 mois, les 7 jours, les repères déictiques, les unités de
 *     durée, les mots de cadence, les mots monétaires, les civilités, les mots d'attribution,
 *     les mots de clause. Un lexique s'énumère exhaustivement ; une syntaxe, non.
 *     « saisons » n'y est délibérément PAS : « Contrat 4 saisons » est un nom, pas une date.
 */

/** Ce qui rend un MOT douteux — les doutes de STRUCTURE (vide, coupé, trop long, nom d'un
 *  client du fichier) appartiennent au lecteur de libellé, jamais au mot pris isolément. */
export type PrintableWordDoubt =
  /** Un mot n'a pas la forme d'un mot de nom : symbole, jeton mixte, morceau de phrase. */
  | 'forme'
  /** Marqueur monétaire : symbole, taux, mot de somme (chiffré ou en toutes lettres). */
  | 'montant'
  /** Nombre écrit comme une somme : séparateur de milliers, décimales, millésime. */
  | 'nombre'
  /** Repère de date : mois, jour, déictique (« demain »), mot de prise d'effet. */
  | 'date'
  /** Cadence ou unité de durée : visite, passage, « toutes les semaines », « annuel ». */
  | 'cadence'
  /** Civilité, rôle du donneur d'ordre, mot d'attribution (« client », « compte »). */
  | 'attribution'
  /** Clause du contrat : reconduction tacite, préavis, indexation. */
  | 'clause';

// ────────────────────────────────────────────────────────────────────────────────────────────
// NORMALISATION — on lit une copie repliée, on CITE toujours le mot d'origine
// ────────────────────────────────────────────────────────────────────────────────────────────

const NON_ASCII = /[^\p{ASCII}]/gu;

/**
 * Repli d'accents : il permet de reconnaître « décembre » comme « decembre » sans perdre le mot
 * d'origine, qui reste celui que l'on CITE au pro — le pro doit reconnaître SON mot, pas une
 * normalisation interne. Tout caractère dont la forme repliée changerait de longueur est laissé
 * tel quel : la longueur n'est pas structurante ici, mais la règle reste la même partout.
 */
export function foldPrintable(text: string): string {
  return text.replace(NON_ASCII, (char) => {
    const stripped = char.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return stripped.length === char.length ? stripped : char;
  });
}

/** Apostrophes typographiques ramenées à l'apostrophe droite (une dictée produit les deux). */
const APOSTROPHES = /['’ʼ‘`´]/gu;

/** La même chose, sans le drapeau global : on cherche une POSITION, pas un remplacement. */
const APOSTROPHE_SIMPLE = /['’ʼ‘`´]/u;

/** Clef de comparaison d'un mot : repliée, minusculée, apostrophes unifiées. */
export function printableWordKey(word: string): string {
  return foldPrintable(word).replace(APOSTROPHES, "'").toLowerCase();
}

/** Radical grossier (pluriel FR) — « fontaines » et « fontaine » désignent la même chose. */
export function printableStem(word: string): string {
  return word.replace(/[sx]$/u, '');
}

/** Séparateurs de MOTS : l'espace sous toutes ses formes (`\s` couvre l'insécable et la fine).
 *  Le reste (ponctuation, symbole) RESTE dans le mot — et le rend invalide, ce qui est
 *  exactement l'effet recherché : « vitrines, » n'est pas un mot, c'est un mot et une virgule. */
export const PRINTABLE_WORD_SEPARATORS = /\s+/u;

// ────────────────────────────────────────────────────────────────────────────────────────────
// ÉTAGE 1 — LA FORME SÛRE (ce qu'un nom PEUT contenir : fini, donc vérifiable)
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Les SEULS connecteurs qu'un groupe nominal réclame. Douze mots — c'est tout ce dont
 * « Entretien des vitrines du hall », « Nettoyage à sec » ou « l'Eurotunnel » ont besoin. Toute
 * autre préposition (« au », « pour », « chez », « sans ») trahit un morceau de PHRASE.
 */
export const PRINTABLE_CONNECTORS: ReadonlySet<string> = new Set([
  'de', 'du', 'des', 'a', 'la', 'le', 'les', 'et', 'sur', 'en',
]);

/** Connecteurs ÉLIDÉS — reconnus AVEC leur apostrophe seulement : « d' » nu est un moignon. */
const CONNECTEURS_ELIDES: ReadonlySet<string> = new Set(["l'", "d'"]);

/** Élisions du français : celles qui ne sont pas des connecteurs autorisés refusent (« qu' »). */
const ELISIONS: ReadonlySet<string> = new Set([
  'l', 'd', 'n', 'c', 'j', 's', 't', 'm', 'qu', 'jusqu', 'lorsqu', 'puisqu', 'quoiqu', 'quelqu',
  'presqu', 'entr',
]);

/**
 * MOTS DE PHRASE — la classe grammaticale FERMÉE du français : articles, déterminants, pronoms,
 * prépositions, conjonctions, adverbes de liaison. Un nom n'en porte aucun hors des douze
 * connecteurs ci-dessus ; leur présence PROUVE qu'on tient un morceau de phrase.
 *
 * C'est la pièce maîtresse de l'inversion : cette classe est finie et ne bouge plus (le français
 * n'invente pas de prépositions), là où les TOURNURES qu'elle compose sont infinies. Elle refuse
 * « au tarif de », « pour le compte de », « sous huit jours », « d'ici la fin du mois » et toutes
 * les formes que personne n'a encore imaginées, sans qu'aucune liste ne les nomme.
 *
 * DÉLIBÉRÉMENT ABSENTS — « car » (le contrat CAR scolaire), « or » (formule Or), « plus »
 * (formule Plus), « tout/tous/toutes » et « chaque » (contrat TOUTES zones) : ces mots-là sont
 * aussi des noms du métier. Les deux derniers sont au lexique de cadence, qui ne refuse qu'un
 * libellé DÉDUIT — jamais un nom que le pro a délibérément écrit.
 */
export const PRINTABLE_SENTENCE_WORDS: ReadonlySet<string> = new Set([
  // Déterminants et articles (hors connecteurs).
  'un', 'une', 'uns', 'unes', 'au', 'aux', 'ce', 'cet', 'cette', 'ces',
  'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses',
  'notre', 'nos', 'votre', 'vos', 'leur', 'leurs',
  'quel', 'quelle', 'quels', 'quelles', 'quelque', 'quelques', 'plusieurs',
  'aucun', 'aucune', 'nul', 'nulle', 'tel', 'telle', 'tels', 'telles',
  'meme', 'memes', 'autre', 'autres', 'certains', 'certaines',
  // Pronoms (et leurs élisions nues, laissées par une dictée sans apostrophe).
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles',
  'me', 'te', 'se', 'moi', 'toi', 'lui', 'eux', 'y',
  'qui', 'que', 'quoi', 'dont', 'ou', 'lequel', 'laquelle', 'lesquels', 'lesquelles',
  'celui', 'celle', 'ceux', 'celles', 'ca', 'cela', 'ceci',
  'c', 'd', 'j', 'l', 'm', 'n', 's', 't', 'qu',
  // Prépositions.
  'pour', 'par', 'avec', 'sans', 'sous', 'dans', 'chez', 'vers', 'depuis', 'jusque', 'jusqu',
  'pendant', 'durant', 'entre', 'parmi', 'contre', 'malgre', 'sauf', 'hors', 'selon', 'envers',
  'apres', 'avant', 'devant', 'derriere', 'pres', 'autour', 'afin', 'lors', 'via', 'concernant',
  // Conjonctions et adverbes de liaison.
  'mais', 'donc', 'ni', 'quand', 'comme', 'lorsque', 'puisque', 'parce', 'si',
  'ne', 'pas', 'non', 'oui', 'aussi', 'encore', 'deja', 'toujours', 'jamais', 'ici',
  'alors', 'puis', 'ensuite', 'enfin', 'ainsi', 'environ', 'presque', 'seulement', 'uniquement',
  'notamment', 'surtout', 'moins', 'tres', 'bien', 'trop', 'assez', 'peu', 'beaucoup',
]);

/**
 * NOMBRES DITS EN TOUTES LETTRES. Ils ne refusent RIEN par eux-mêmes (« Les Mille Étangs »,
 * « Résidence Cent Marches » sont des noms) : ils servent uniquement à reconnaître qu'un mot
 * monétaire est QUANTIFIÉ — « deux mille euros » est une somme, « Contrat Euro 2 » un nom.
 */
export const PRINTABLE_SPELLED_NUMBERS: ReadonlySet<string> = new Set([
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze',
  'treize', 'quatorze', 'quinze', 'seize', 'vingt', 'vingts', 'trente', 'quarante', 'cinquante',
  'soixante', 'cent', 'cents', 'mille', 'million', 'millions', 'milliard', 'milliards',
]);

/** MAGNITUDES d'un nombre dit : ce sont elles qui font d'une suite de mots une SOMME. */
export const PRINTABLE_MAGNITUDES: ReadonlySet<string> = new Set([
  'cent', 'cents', 'mille', 'million', 'millions', 'milliard', 'milliards',
]);

/** Formes sociales : jamais un jeton DISCRIMINANT d'un nom de client (« SARL » ne nomme rien). */
export const PRINTABLE_LEGAL_FORMS: ReadonlySet<string> = new Set([
  'sarl', 'sas', 'sasu', 'eurl', 'sci', 'scop', 'gie', 'ste', 'societe', 'snc', 'selarl', 'scm',
  'sem', 'earl', 'entreprise', 'groupe',
]);

/** Symbole d'une SOMME ou d'un TAUX — aucun n'appartient au nom d'une prestation. */
const SYMBOLE_MONETAIRE = /[€$£¥%]/u;

/** Nombre COURT isolé : de 1 à 3 chiffres (« quai 3 », « 4 saisons », « 12 ascenseurs »). */
const NOMBRE_COURT = /^\d{1,3}$/u;

/** Jeton fait de chiffres et de séparateurs seulement — reste à savoir CE qu'il dit. */
const JETON_CHIFFRE = /^\d[\d./,-]*$/u;

/** Millésime plausible — au-delà, ce n'est plus une année mais un artefact de dictée. */
const MILLESIME = /^(?:1[89]|2[01])\d{2}$/u;

/**
 * MOT alphabétique français : lettres (accents compris), trait d'union et apostrophe INTERNES.
 * Il commence et finit par une lettre — ce qui exclut « 1er », « BT01 », « M. », « vitrines, ».
 */
const MOT = /^\p{L}[\p{L}'’-]*\p{L}$/u;

/** LETTRE MAJUSCULE seule : une DÉSIGNATION de bâtiment (« hall A », « bloc D », « tour L »). */
const LETTRE_DESIGNATION = /^\p{Lu}$/u;

// ────────────────────────────────────────────────────────────────────────────────────────────
// ÉTAGE 2 — LE LEXIQUE FERMÉ (des mots alphabétiques qui ne nomment JAMAIS une prestation)
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fatalité d'un groupe :
 *  · `true`        — le mot imprimerait un FAIT FAUX sur la pièce, quoi qu'il arrive ;
 *  · `false`       — le métier l'emploie légitimement (« Entretien annuel », « Visites de
 *                    sécurité ») : il ne condamne qu'un nom DÉDUIT, jamais un nom écrit ;
 *  · `'quantifie'` — fatal SI le mot suit une quantité : « deux mille euros » est une somme,
 *                    « Contrat Euro 2 » est un nom.
 */
type Fatalite = boolean | 'quantifie';

interface GroupeLexical {
  readonly doubt: PrintableWordDoubt;
  readonly fatalite: Fatalite;
  readonly mots: readonly string[];
}

const LEXIQUE_FERME: readonly GroupeLexical[] = [
  {
    // Les 12 mois, les 7 jours, les repères DÉICTIQUES (ils ne veulent dire quelque chose que
    // depuis l'instant où l'on parle, donc jamais sur une pièce archivée des années), et les
    // mots de PRISE D'EFFET — « effectif », « applicable », que la découpe laisse en fin de nom.
    doubt: 'date',
    fatalite: true,
    mots: [
      'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre',
      'octobre', 'novembre', 'decembre',
      'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
      'demain', 'apres-demain', "aujourd'hui", 'hier', 'avant-hier', 'veille', 'lendemain',
      'prochain', 'prochaine', 'prochains', 'prochaines', 'rentree', 'rentrees',
      'date', 'dates', 'effet', 'effets', 'effectif', 'effective', 'effectifs', 'effectives',
      'applicable', 'applicables', 'valable', 'valables', 'echeance', 'echeances',
    ],
  },
  {
    // Cadence et unités de durée. NON FATAL : « Entretien annuel », « Visites de sécurité »,
    // « Contrat toutes zones » sont des noms que le métier dicte — les refuser au pro qui vient
    // de les écrire ferait un cul-de-sac. Ils ne refusent donc qu'un libellé DÉDUIT.
    doubt: 'cadence',
    fatalite: false,
    mots: [
      'fois', 'passage', 'passages', 'visite', 'visites', 'intervention', 'interventions',
      'mensuel', 'mensuelle', 'mensuels', 'mensuelles',
      'bimensuel', 'bimensuelle', 'bimensuels', 'bimensuelles',
      'bimestriel', 'bimestrielle', 'bimestriels', 'bimestrielles',
      'trimestriel', 'trimestrielle', 'trimestriels', 'trimestrielles',
      'quadrimestriel', 'quadrimestrielle', 'semestriel', 'semestrielle', 'semestriels',
      'semestrielles', 'annuel', 'annuelle', 'annuels', 'annuelles',
      'hebdomadaire', 'hebdomadaires', 'journalier', 'journaliere', 'journaliers',
      'journalieres', 'quotidien', 'quotidienne', 'quotidiens', 'quotidiennes',
      'jour', 'jours', 'semaine', 'semaines', 'mois', 'an', 'ans', 'annee', 'annees',
      'trimestre', 'trimestres', 'semestre', 'semestres',
      'chaque', 'tous', 'toutes', 'tout', 'toute',
      'periodicite', 'periodicites', 'cadence', 'cadences', 'frequence', 'frequences',
    ],
  },
  {
    // Mots MONÉTAIRES explicites — fatals dès qu'une quantité les précède.
    doubt: 'montant',
    fatalite: 'quantifie',
    mots: [
      'euro', 'euros', 'eur', 'keuro', 'keuros', 'tarif', 'tarifs', 'prix',
      'montant', 'montants', 'somme', 'sommes', 'cout', 'couts',
      'tva', 'ht', 'ttc', 'remise', 'remises', 'acompte', 'acomptes',
      'versement', 'versements', 'paiement', 'paiements', 'payable', 'payables',
    ],
  },
  {
    // ARGOT de la somme. Jamais fatal : « briques », « plaques », « sacs » et « boules » sont
    // AUSSI des objets que ces métiers nettoient ou entretiennent. Le doute suffit à faire poser
    // la question quand le nom a été DÉDUIT ; il ne condamne pas un nom délibérément écrit.
    doubt: 'montant',
    fatalite: false,
    mots: [
      'balle', 'balles', 'boule', 'boules', 'brique', 'briques', 'patate', 'patates',
      'plaque', 'plaques', 'sac', 'sacs',
    ],
  },
  {
    // Civilités et mots d'attribution : ils désignent QUELQU'UN, jamais une prestation. Fatals —
    // le nom d'un tiers imprimé comme nom de la ligne d'une facture annuelle est un fait faux.
    doubt: 'attribution',
    fatalite: true,
    mots: [
      'monsieur', 'madame', 'mademoiselle', 'messieurs', 'mesdames',
      'm.', 'mr', 'mr.', 'mme', 'mme.', 'mlle', 'mlle.', 'mm.',
      'client', 'cliente', 'clients', 'clientes', 'societe', 'societes',
      'compte', 'comptes', 'nom', 'noms', 'part',
      'destinataire', 'destinataires', 'destine', 'destinee', 'destines', 'destinees',
    ],
  },
  {
    // Clauses : ce sont des STIPULATIONS du contrat, pas son nom. Non fatales (aucune n'imprime
    // de fait chiffré) mais elles font poser la question dès que le nom a été déduit.
    doubt: 'clause',
    fatalite: false,
    mots: [
      'reconduction', 'reconductions', 'tacite', 'tacites', 'tacitement',
      'renouvellement', 'renouvellements', 'preavis', 'resiliation', 'resiliations',
      'engagement', 'engagements', 'indexation', 'indexations',
      'indexe', 'indexee', 'indexes', 'indexees', 'indice', 'indices',
      'revision', 'revisions', 'avenant', 'avenants', 'clause', 'clauses', 'duree', 'durees',
    ],
  },
];

interface EntreeLexicale {
  readonly doubt: PrintableWordDoubt;
  readonly fatalite: Fatalite;
}

const LEXIQUE: ReadonlyMap<string, EntreeLexicale> = new Map(
  LEXIQUE_FERME.flatMap((groupe) =>
    groupe.mots.map(
      (mot): [string, EntreeLexicale] => [mot, { doubt: groupe.doubt, fatalite: groupe.fatalite }],
    ),
  ),
);

// ────────────────────────────────────────────────────────────────────────────────────────────
// LECTURE D'UN MOT — acceptation POSITIVE : hors des trois formes sûres, tout refuse
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Nature RETENUE d'un mot SÛR — `null` sur la lecture d'un mot douteux. */
export type PrintableWordNature = 'connecteur' | 'nombre' | 'mot';

export interface PrintableWordReading {
  /** Nature RETENUE quand le mot est sûr ; `null` quand il est douteux. */
  readonly nature: PrintableWordNature | null;
  readonly doubt?: PrintableWordDoubt;
  readonly fatal?: boolean;
}

const SUR = (nature: PrintableWordNature): PrintableWordReading => ({ nature });
const DOUTE = (doubt: PrintableWordDoubt, fatal: boolean): PrintableWordReading => ({
  nature: null,
  doubt,
  fatal,
});

/** Le mot précédent est-il une QUANTITÉ (chiffrée ou dite) ? — voir la fatalité `'quantifie'`. */
function estQuantite(precedent: string | null): boolean {
  if (precedent === null) return false;
  const clef = printableWordKey(precedent);
  return /^\d/u.test(clef) || PRINTABLE_SPELLED_NUMBERS.has(clef);
}

/** Ce que dit un jeton entièrement CHIFFRÉ : petit nombre, millésime, ou nombre-somme. */
function lireChiffres(clef: string): PrintableWordReading {
  if (NOMBRE_COURT.test(clef)) return SUR('nombre');
  if (MILLESIME.test(clef)) return DOUTE('date', true);
  if (/^\d+$/u.test(clef)) return DOUTE('nombre', true);
  const separateurs = (clef.match(/[./,-]/gu) ?? []).length;
  // Deux séparateurs (« 01/10/2026 », « 2026-10-01 ») ou une barre oblique : c'est une DATE.
  // Un seul point ou une seule virgule : c'est un nombre écrit comme une somme (« 1.200 »).
  if (clef.includes('/') || separateurs >= 2) return DOUTE('date', true);
  return DOUTE('nombre', true);
}

/**
 * LIT UN MOT et dit s'il appartient à une forme sûre. L'ordre des questions est celui de la
 * gravité : un symbole d'abord (il ne peut RIEN nommer), puis les chiffres, puis le lexique
 * fermé (il diagnostique mieux qu'une règle de forme : « septembre » est une DATE, pas un
 * « mot invalide »), puis la forme proprement dite.
 */
export function readPrintableWord(mot: string, precedent: string | null): PrintableWordReading {
  if (SYMBOLE_MONETAIRE.test(mot)) return DOUTE('montant', true);
  const clef = printableWordKey(mot);

  if (JETON_CHIFFRE.test(clef)) return lireChiffres(clef);

  // LETTRE SEULE — la casse est le seul indice disponible, et elle suffit : « hall A », « bloc D »
  // et « tour L » sont des noms que le métier dicte tous les jours, où la lettre DÉSIGNE un
  // bâtiment ; la minuscule, elle, trahit la préposition ou l'élision orpheline (« vitrines d »).
  if (mot.length === 1) {
    if (LETTRE_DESIGNATION.test(mot)) return SUR('mot');
    return PRINTABLE_CONNECTORS.has(clef) ? SUR('connecteur') : DOUTE('forme', true);
  }

  if (PRINTABLE_CONNECTORS.has(clef) || CONNECTEURS_ELIDES.has(clef)) return SUR('connecteur');

  const entree = LEXIQUE.get(clef);
  if (entree !== undefined) {
    const fatal = entree.fatalite === 'quantifie' ? estQuantite(precedent) : entree.fatalite;
    return DOUTE(entree.doubt, fatal);
  }

  if (PRINTABLE_SENTENCE_WORDS.has(clef)) return DOUTE('forme', true);

  // ÉLISION : « l'Eurotunnel » est un nom, « qu'on » un morceau de phrase, « d'ici » aussi. Le
  // préfixe doit être un connecteur élidé, et ce qui SUIT repasse par la même lecture. L'index
  // est cherché sur le mot D'ORIGINE : c'est lui qu'on découpe, et lui seul dont on est sûr.
  const apostrophe = mot.search(APOSTROPHE_SIMPLE);
  if (apostrophe > 0) {
    const prefixe = clef.slice(0, apostrophe);
    if (ELISIONS.has(prefixe)) {
      if (!CONNECTEURS_ELIDES.has(`${prefixe}'`)) return DOUTE('forme', true);
      const suite = mot.slice(apostrophe + 1);
      return suite.length === 0 ? SUR('connecteur') : readPrintableWord(suite, precedent);
    }
  }

  return MOT.test(mot) ? SUR('mot') : DOUTE('forme', true);
}

/** Jetons DISCRIMINANTS d'un nom : ni mot-outil, ni forme sociale, au moins trois lettres. */
export function printableDiscriminantTokens(value: string): string[] {
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .map((piece) => printableWordKey(piece))
    .filter(
      (piece) =>
        piece.length >= 3 &&
        !PRINTABLE_LEGAL_FORMS.has(piece) &&
        !PRINTABLE_SENTENCE_WORDS.has(piece) &&
        !PRINTABLE_CONNECTORS.has(piece),
    );
}
