/**
 * §2.7 — GARDE FAIL-CLOSED du LIBELLÉ de contrat. Module PUR (zéro I/O, zéro état), placé en
 * SORTIE d'extraction et AVANT toute proposition de mutation.
 *
 * ── POURQUOI CETTE GARDE EST ÉCRITE À L'ENVERS DE LA PRÉCÉDENTE ────────────────────────────
 *
 * Cinq passes ont conclu la même chose, la cinquième CONTRE LA GARDE ELLE-MÊME : tant qu'on
 * ÉNUMÈRE ce qui est INTERDIT dans un nom de contrat, on énumère les tournures du français —
 * un ensemble INFINI. La garde de la passe 5 était une liste noire ; elle avait donc, mot pour
 * mot, les trous de l'extracteur qu'elle devait couvrir. Une vérification bout-en-bout a montré
 * qu'elle laissait passer « Entretien vitrines demain », « … toutes les semaines », « … sans
 * reconduction tacite », « … 30% à la commande », « … Monsieur Dupont », « … au tarif ».
 *
 * ON RENVERSE DONC LA CHARGE DE LA PREUVE. Ce qu'un nom de contrat PEUT contenir est, lui, FINI
 * et vérifiable : des mots, de petits nombres, une poignée de connecteurs. Un libellé est
 * ACCEPTÉ si et seulement si CHACUN de ses mots appartient à cette FORME SÛRE ; tout le reste
 * REFUSE. La garde ne cherche plus à reconnaître le mal (impossible) : elle reconnaît le bien
 * (fini), et le refus n'est jamais une pièce fausse — c'est une QUESTION que Bob pose.
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

/** Ce qui rend un libellé douteux. Un seul doute bloquant suffit à refuser (fail-closed). */
export type ContractLabelDoubt =
  /** Rien, trop court, ou pas un seul mot plein : ce n'est pas un nom. */
  | 'vide'
  /** Le libellé s'ARRÊTE sur un connecteur — cicatrice d'une découpe (« … à raison d' »). */
  | 'coupe'
  /** Un mot n'a pas la forme d'un mot de nom : symbole, jeton mixte, morceau de phrase. */
  | 'forme'
  /** Plus de mots qu'un nom de contrat n'en porte — c'est une phrase, pas un nom. */
  | 'longueur'
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
  | 'clause'
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
  /** Vrai si le libellé peut s'imprimer sur une pièce. Faux ⇒ Bob POSE LA QUESTION. */
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

// ────────────────────────────────────────────────────────────────────────────────────────────
// NORMALISATION — on lit une copie repliée, on CITE toujours le mot d'origine
// ────────────────────────────────────────────────────────────────────────────────────────────

const NON_ASCII = /[^\p{ASCII}]/gu;

/**
 * Repli d'accents : il permet de reconnaître « décembre » comme « decembre » sans perdre le mot
 * d'origine, qui reste celui que Bob CITE au pro — le pro doit reconnaître SON mot, pas une
 * normalisation interne. Tout caractère dont la forme repliée changerait de longueur est laissé
 * tel quel : la longueur n'est pas structurante ici, mais la règle reste la même partout.
 */
function fold(text: string): string {
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
function key(word: string): string {
  return fold(word).replace(APOSTROPHES, "'").toLowerCase();
}

/** Séparateurs de MOTS : l'espace sous toutes ses formes (`\s` couvre l'insécable et la fine).
 *  Le reste (ponctuation, symbole) RESTE dans le mot — et le rend invalide, ce qui est
 *  exactement l'effet recherché : « vitrines, » n'est pas un mot, c'est un mot et une virgule. */
const ESPACES = /\s+/u;

// ────────────────────────────────────────────────────────────────────────────────────────────
// ÉTAGE 1 — LA FORME SÛRE (ce qu'un nom de contrat PEUT contenir : fini, donc vérifiable)
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Les SEULS connecteurs qu'un groupe nominal réclame. Douze mots — c'est tout ce dont
 * « Entretien des vitrines du hall », « Nettoyage à sec » ou « l'Eurotunnel » ont besoin. Toute
 * autre préposition (« au », « pour », « chez », « sans ») trahit un morceau de PHRASE.
 */
const CONNECTEURS: ReadonlySet<string> = new Set([
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
 * prépositions, conjonctions, adverbes de liaison. Un nom de contrat n'en porte aucun hors des
 * douze connecteurs ci-dessus ; leur présence PROUVE qu'on tient un morceau de phrase.
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
const MOTS_DE_PHRASE: ReadonlySet<string> = new Set([
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
const NOMBRES_DITS: ReadonlySet<string> = new Set([
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze',
  'treize', 'quatorze', 'quinze', 'seize', 'vingt', 'vingts', 'trente', 'quarante', 'cinquante',
  'soixante', 'cent', 'cents', 'mille', 'million', 'millions', 'milliard', 'milliards',
]);

/** MAGNITUDES d'un nombre dit : ce sont elles qui font d'une suite de mots une SOMME. */
const MAGNITUDES: ReadonlySet<string> = new Set([
  'cent', 'cents', 'mille', 'million', 'millions', 'milliard', 'milliards',
]);

/** Formes sociales : jamais un jeton DISCRIMINANT d'un nom de client (« SARL » ne nomme rien). */
const FORMES_SOCIALES: ReadonlySet<string> = new Set([
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
// ÉTAGE 2 — LE LEXIQUE FERMÉ (des mots alphabétiques qui ne nomment JAMAIS une prestation)
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fatalité d'un groupe :
 *  · `true`        — refuse DANS LES DEUX MODES : ce mot imprimerait un FAIT FAUX sur la pièce ;
 *  · `false`       — refuse tant que personne n'a NOMMÉ le contrat : le métier l'emploie
 *                    légitimement (« Entretien annuel », « Visites de sécurité ») ;
 *  · `'quantifie'` — refuse dans les deux modes SI le mot suit une quantité : « deux mille
 *                    euros » est une somme, « Contrat Euro 2 » est un nom.
 */
type Fatalite = boolean | 'quantifie';

interface GroupeLexical {
  readonly doubt: ContractLabelDoubt;
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
  readonly doubt: ContractLabelDoubt;
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

type NatureMot = 'connecteur' | 'nombre' | 'mot';

interface LectureMot {
  /** Nature RETENUE quand le mot est sûr ; `null` quand il est douteux. */
  readonly nature: NatureMot | null;
  readonly doubt?: ContractLabelDoubt;
  readonly fatal?: boolean;
}

const SUR = (nature: NatureMot): LectureMot => ({ nature });
const DOUTE = (doubt: ContractLabelDoubt, fatal: boolean): LectureMot => ({
  nature: null,
  doubt,
  fatal,
});

/** Le mot précédent est-il une QUANTITÉ (chiffrée ou dite) ? — voir la fatalité `'quantifie'`. */
function estQuantite(precedent: string | null): boolean {
  if (precedent === null) return false;
  const clef = key(precedent);
  return /^\d/u.test(clef) || NOMBRES_DITS.has(clef);
}

/** Ce que dit un jeton entièrement CHIFFRÉ : petit nombre, millésime, ou nombre-somme. */
function lireChiffres(clef: string): LectureMot {
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
function lireMot(mot: string, precedent: string | null): LectureMot {
  if (SYMBOLE_MONETAIRE.test(mot)) return DOUTE('montant', true);
  const clef = key(mot);

  if (JETON_CHIFFRE.test(clef)) return lireChiffres(clef);

  // LETTRE SEULE — la casse est le seul indice disponible, et elle suffit : « hall A », « bloc D »
  // et « tour L » sont des noms que le métier dicte tous les jours, où la lettre DÉSIGNE un
  // bâtiment ; la minuscule, elle, trahit la préposition ou l'élision orpheline (« vitrines d »).
  if (mot.length === 1) {
    if (LETTRE_DESIGNATION.test(mot)) return SUR('mot');
    return CONNECTEURS.has(clef) ? SUR('connecteur') : DOUTE('forme', true);
  }

  if (CONNECTEURS.has(clef) || CONNECTEURS_ELIDES.has(clef)) return SUR('connecteur');

  const entree = LEXIQUE.get(clef);
  if (entree !== undefined) {
    const fatal =
      entree.fatalite === 'quantifie' ? estQuantite(precedent) : entree.fatalite;
    return DOUTE(entree.doubt, fatal);
  }

  if (MOTS_DE_PHRASE.has(clef)) return DOUTE('forme', true);

  // ÉLISION : « l'Eurotunnel » est un nom, « qu'on » un morceau de phrase, « d'ici » aussi. Le
  // préfixe doit être un connecteur élidé, et ce qui SUIT repasse par la même lecture. L'index
  // est cherché sur le mot D'ORIGINE : c'est lui qu'on découpe, et lui seul dont on est sûr.
  const apostrophe = mot.search(APOSTROPHE_SIMPLE);
  if (apostrophe > 0) {
    const prefixe = clef.slice(0, apostrophe);
    if (ELISIONS.has(prefixe)) {
      if (!CONNECTEURS_ELIDES.has(`${prefixe}'`)) return DOUTE('forme', true);
      const suite = mot.slice(apostrophe + 1);
      return suite.length === 0 ? SUR('connecteur') : lireMot(suite, precedent);
    }
  }

  return MOT.test(mot) ? SUR('mot') : DOUTE('forme', true);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// CLIENT — indevinable sans le fichier réel de l'hôte
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Radical grossier (pluriel FR) — « fontaines » et « fontaine » désignent la même chose. */
function stem(word: string): string {
  return word.replace(/[sx]$/u, '');
}

/** Jetons DISCRIMINANTS d'un nom : ni mot-outil, ni forme sociale, au moins trois lettres. */
function jetonsDiscriminants(value: string): string[] {
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .map((piece) => key(piece))
    .filter(
      (piece) =>
        piece.length >= 3 &&
        !FORMES_SOCIALES.has(piece) &&
        !MOTS_DE_PHRASE.has(piece) &&
        !CONNECTEURS.has(piece),
    );
}

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
 * réellement dicté sans que personne ne s'en aperçoive — c'est exactement la faute que la garde
 * existe pour empêcher.
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

  const mots = raw.length === 0 ? [] : raw.split(ESPACES).filter((mot) => mot.length > 0);
  if (raw.length < MIN_CARACTERES || mots.length === 0) noter('vide', raw, true);
  if (mots.length > MAX_MOTS) noter('longueur', '', true);

  const lectures = mots.map((mot, index) => lireMot(mot, index === 0 ? null : (mots[index - 1] ?? null)));
  lectures.forEach((lecture, index) => {
    if (lecture.doubt !== undefined) noter(lecture.doubt, mots[index] ?? '', lecture.fatal === true);
  });

  // MOIGNON — un nom qui ne porte AUCUN mot plein n'est pas un nom (« de la »), et un nom qui
  // s'ARRÊTE sur un connecteur est la cicatrice d'une découpe (« … au tarif de », « … à raison
  // d' ») : ce fragment s'imprimerait TEL QUEL sur la ligne de la facture annuelle. Il peut en
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
    const gauche = key(mots[index - 1] ?? '');
    const droite = key(mots[index] ?? '');
    const millier = /^\d{1,3}$/u.test(gauche) && /^\d{3}$/u.test(droite);
    const enLettres = NOMBRES_DITS.has(gauche) && MAGNITUDES.has(droite);
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
      const clef = stem(key(piece));
      if (clef.length >= 3 && !parRadical.has(clef)) parRadical.set(clef, piece);
    }
  }
  for (const name of options.customerNames ?? []) {
    const hit = jetonsDiscriminants(name).find((jeton) => parRadical.has(stem(jeton)));
    if (hit === undefined) continue;
    noter('client', parRadical.get(stem(hit)) ?? hit, false);
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

/** Vrai si le libellé peut s'imprimer. Raccourci de lecture — même garde, même sévérité. */
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
 * que le pro entende toujours la même explication du même refus.
 */
export function contractLabelRefusalSaid(verdict: ContractLabelVerdict): string {
  const worst = verdict.blocking[0] ?? verdict.doubts[0];
  if (worst === undefined) return '';
  if (worst === 'vide') {
    return 'Ce nom est trop court pour s’imprimer sur une facture.';
  }
  const cited =
    verdict.fragment !== null && verdict.fragment.length > 0 ? ` (« ${verdict.fragment} »)` : '';
  if (worst === 'coupe') {
    return `Ce nom s’arrête au milieu d’une phrase${cited} — il s’imprimerait tel quel sur la ligne de la facture annuelle.`;
  }
  if (worst === 'longueur') {
    return `Ce nom fait plus de ${MAX_MOTS} mots — c’est une phrase, et elle s’imprimerait telle quelle sur la ligne de la facture annuelle.`;
  }
  return `Ce nom contient ${contractLabelDoubtSaid(worst)}${cited} — il s’imprimerait tel quel sur la ligne de la facture annuelle.`;
}
