import { describe, expect, it } from 'vitest';
import { extractSpokenContractFacts, extractSpokenContractLabel } from './contract-command';
import { inspectContractLabel } from './contract-label-guard';

/**
 * §2.7 — TEST D'INVARIANT SUR CORPUS COMBINATOIRE.
 *
 * POURQUOI CE TEST EXISTE : quatre revues successives ont trouvé la MÊME pathologie sous quatre
 * formes différentes (un montant collé au libellé, puis une date, puis le nom du client, puis les
 * formes parlées qu'aucune des trois listes précédentes ne couvrait). Le libellé est persisté
 * comme libellé du contrat ET de sa LIGNE UNIQUE, donc repris comme LIGNE de la facture
 * annuelle : il s'IMPRIME sur une pièce légale archivée immuable. La confirmation vocale ne
 * protège de rien — elle récite le libellé fautif, le pro entend sa propre phrase et valide.
 *
 * CE QUE CE TEST GARANTIT : on ne vérifie pas des exemples, on vérifie des INVARIANTS sur le
 * PRODUIT CARTÉSIEN de toutes les manières de dire chaque fait, ET de toutes les POSITIONS où
 * elles peuvent être dites — avant le libellé comme après. Une forme parlée ajoutée demain à
 * l'une des dimensions est immédiatement croisée avec toutes les autres.
 *
 * CE QUE CE TEST NE PRÉTEND PLUS ÊTRE — et c'est le point de la quatrième revue : un corpus, si
 * large soit-il, reste une ÉNUMÉRATION. Il ne peut pas prouver qu'aucune forme parlée n'échappe
 * à l'extraction, parce que les formes parlées ne sont pas énumérables. C'est pourquoi la sûreté
 * de la pièce ne repose PAS sur ce test : elle repose sur la garde fail-closed
 * (`contract-label-guard.ts`), qui refuse tout libellé PORTANT LA TRACE d'un fait, y compris
 * celles que l'extraction n'a pas comprises. Ce corpus mesure autre chose : le NOMBRE DE
 * QUESTIONS que Bob devra poser. Chaque forme qu'il couvre est une question en moins ; chaque
 * forme qu'il rate est une question de plus — jamais une pièce fausse.
 *
 * INDÉPENDANCE DES DÉTECTEURS — troisième exigence de la revue : un test qui énumère les mêmes
 * jetons que le code ne teste que sa propre copie du code. Les détecteurs ci-dessous ne
 * connaissent AUCUN lexique de l'extracteur. Ils viennent de deux sources distinctes :
 *   · la FUITE — les jetons injectés par le générateur de corpus (donc connus indépendamment du
 *     code testé) ne doivent pas réapparaître dans le libellé lu ;
 *   · la PROPRIÉTÉ STRUCTURELLE — « aucun chiffre suivi d'un mot court commençant par e/€ »,
 *     « aucun nombre écrit comme une somme » : des formes, pas des listes de mots.
 *
 * Le corpus se génère en TypeScript, sans dépendance de fuzzing : il est DÉTERMINISTE, donc un
 * échec est reproductible à l'identique et la revue peut relire la phrase fautive.
 *
 * CE QUE CE CORPUS NE COUVRE PAS (honnêtement) :
 *   · les montants en TOUTES LETTRES (« deux mille euros ») : ils sont DÉLIBÉRÉMENT illisibles —
 *     ils bornent le libellé mais la valeur reste une question ; leur non-lecture est vérifiée
 *     dans `contract-command.test.ts`, pas ici ;
 *   · les repères de calendrier sans valeur (« à la rentrée », « en janvier ») : ils bornent le
 *     libellé sans produire de date ; même raison ;
 *   · les cadences que l'ADJECTIF SEUL porte (« contrat trimestriel ») : elles ne sont ni lues ni
 *     coupées, parce que « Entretien trimestriel » est un NOM de contrat parfaitement légitime —
 *     la garde les questionne, l'extracteur ne les tranche pas ;
 *   · les fautes de dictée, les mots collés, les répétitions et les auto-corrections (« le
 *     contrat euh non le contrat… ») ;
 *   · les langues autres que le français ;
 *   · plus généralement : toute forme parlée que personne n'a encore imaginée. C'est précisément
 *     ce trou-là que la garde fail-closed couvre, et qu'aucun corpus ne fermera jamais.
 */

const TODAY = '2026-09-20';

// ── Dimension 1 : AMORCE DE GESTE ───────────────────────────────────────────────────────────
const GESTURES: readonly string[] = [
  'Crée le contrat',
  'Fais-moi le contrat',
  'Ajoute un contrat',
  'Établis le contrat de maintenance',
];

// ── Dimension 2 : LIBELLÉ MÉTIER légitime ───────────────────────────────────────────────────
/**
 * Libellés que le pro dicte VRAIMENT : avec des chiffres, des prépositions, des traits d'union,
 * des noms propres. Ce sont eux qui interdisent de « nettoyer » à la hache — sur-couper est une
 * faute aussi grave que sous-couper, elle mutile le nom d'un contrat sur une facture.
 */
const LABELS: readonly string[] = [
  'Entretien vitrines',
  'Entretien 12 ascenseurs',
  'Porte-à-faux quai 3',
  'Nettoyage à sec hall B',
  'Maintenance Eurotunnel Nord',
  'Dépannage fontaines Europe 2',
  // DÉSIGNATION de bâtiment en dernière position : la règle de queue pendante, lue sans égard à
  // la casse, amputait « Entretien hall A » en « Entretien hall » — un nom MUTILÉ, ni vide ni
  // moignon, que rien en aval ne signalait et qui s'imprimait tel quel sur la facture annuelle.
  'Entretien hall A',
];

// ── Dimension 3 : CLIENT ────────────────────────────────────────────────────────────────────
/**
 * « Carrefour » est aussi un nom COMMUN : c'est le piège qui interdit de traiter un nom propre
 * comme un simple mot rare. « pour RATP » (sans le mot « client ») n'est reconnaissable que
 * parce que RATP est un client du fichier ; « pour le compte de » et « au nom de » le sont par
 * la tournure seule, même quand le bénéficiaire est introuvable au fichier.
 */
interface SpokenCustomer {
  readonly name: string;
  readonly said: string;
}
const CUSTOMERS: readonly SpokenCustomer[] = [
  { name: 'RATP', said: 'pour le client RATP' },
  { name: 'RATP', said: 'pour RATP' },
  { name: 'Carrefour', said: 'chez Carrefour' },
  { name: 'Vinci Immobilier', said: 'pour la société Vinci Immobilier' },
  { name: 'RATP', said: 'pour le compte de RATP' },
  { name: 'Carrefour', said: 'au nom de Carrefour' },
];

/** Le fichier client RÉEL du tenant — ce que l'hôte donne au lecteur pur. */
const CUSTOMER_FILE: readonly string[] = ['RATP', 'Carrefour', 'Vinci Immobilier'];

// ── Dimension 4 : MONTANT ───────────────────────────────────────────────────────────────────
/** Espaces de milliers réellement produits par une dictée / un clavier FR. */
const NBSP = ' ';
const NNBSP = ' ';
interface SpokenAmount {
  readonly said: string;
  readonly cents: number | null;
}
const AMOUNTS: readonly SpokenAmount[] = [
  { said: 'à 1 200 € par an', cents: 120_000 },
  { said: '1200 euros par an', cents: 120_000 },
  { said: 'à 1 200,50 € par an', cents: 120_050 },
  { said: `à 1${NBSP}200 € par an`, cents: 120_000 },
  { said: `à 1${NNBSP}200 € par an`, cents: 120_000 },
  // Séparateur de milliers par POINT : la forme qui faisait naître le contrat au SIXIÈME de son
  // prix (« 1.200 € » lu 200 €), et dont le fragment « 1. » restait imprimé sur la ligne.
  { said: 'à 1.200 € par an', cents: 120_000 },
  // Forme ABRÉGÉE : le millier est dans le marqueur, pas dans les chiffres.
  { said: 'à 12 k€ par an', cents: 1_200_000 },
  // Argot : la SOMME reste illisible (Bob demandera le montant) mais elle a bien été ÉNONCÉE —
  // elle ne doit donc jamais finir imprimée comme nom de la ligne de facture.
  { said: '400 balles par an', cents: null },
];

// ── Dimension 5 : DATE DE DÉMARRAGE ─────────────────────────────────────────────────────────
interface SpokenDate {
  readonly said: string;
  readonly date: string | null;
}
const DATES: readonly SpokenDate[] = [
  { said: 'ça démarre au 1er octobre', date: '2026-10-01' },
  { said: 'à partir du 01/10/2026', date: '2026-10-01' },
  { said: 'à compter du 1er octobre 2026', date: '2026-10-01' },
  { said: 'dès le 2026-10-01', date: '2026-10-01' },
  { said: '', date: null },
];

// ── Dimension 6 : PÉRIODICITÉ ───────────────────────────────────────────────────────────────
interface SpokenPeriodicity {
  readonly said: string;
  readonly visits: number | null;
}
const PERIODICITIES: readonly SpokenPeriodicity[] = [
  { said: '2 visites par an', visits: 2 },
  { said: '4 passages', visits: 4 },
  { said: 'tous les 6 mois', visits: 2 },
  { said: 'une fois par trimestre', visits: 4 },
  // Cadences NON CHIFFRÉES — les trois formes que la quatrième revue a listées.
  { said: 'un passage par mois', visits: 12 },
  { said: 'visite bimestrielle', visits: 6 },
  { said: 'deux interventions annuelles', visits: 2 },
  { said: '', visits: null },
];

// ── Dimension 7 : NOMBRE D'ÉQUIPEMENTS ──────────────────────────────────────────────────────
interface SpokenEquipment {
  readonly said: string;
  readonly count: number | null;
}
const EQUIPMENTS: readonly SpokenEquipment[] = [
  { said: 'ils ont 3 machines', count: 3 },
  { said: '12 ascenseurs à entretenir', count: 12 },
  { said: '', count: null },
];

/** Ordres de dictée : le pro énonce ses faits DANS LE DÉSORDRE, la lecture doit tenir. */
const ORDERS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4],
  [1, 3, 0, 4, 2],
  [4, 0, 2, 1, 3],
  [2, 0, 3, 1, 4],
];

/** Avec virgules (dictée ponctuée) ET sans (dictée d'une traite, le cas où les bugs se cachent). */
const SEPARATORS: readonly string[] = [', ', ' '];

/**
 * ── Dimension 8 : POSITION ──────────────────────────────────────────────────────────────────
 * L'ANGLE MORT STRUCTUREL de la quatrième revue : jusqu'ici le corpus disait TOUJOURS le libellé
 * d'abord et les faits ensuite. Or un pro dit tout aussi naturellement « Pour RATP, crée le
 * contrat Entretien vitrines » ou « À 1 200 € par an, fais-moi le contrat Entretien vitrines ».
 * Un fait dit AVANT le libellé n'était donc JAMAIS testé — ni sa lecture, ni son absence du nom.
 *  · `apres`   : tous les faits après le libellé (l'ancien corpus, conservé) ;
 *  · `avant`   : tous les faits AVANT l'amorce de geste ;
 *  · `encadre` : le premier fait avant, les autres après — le nom du contrat est ENCADRÉ.
 */
type Position = 'apres' | 'avant' | 'encadre';
const POSITIONS: readonly Position[] = ['apres', 'avant', 'encadre'];

interface CorpusEntry {
  readonly phrase: string;
  readonly label: string;
  readonly position: Position;
  readonly customer: SpokenCustomer;
  readonly amount: SpokenAmount;
  readonly date: SpokenDate;
  readonly periodicity: SpokenPeriodicity;
  readonly equipment: SpokenEquipment;
}

/** Une phrase qui commence par un fait ne commence pas par une majuscule de geste. */
function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function buildCorpus(): CorpusEntry[] {
  const corpus: CorpusEntry[] = [];
  let index = 0;
  for (const gesture of GESTURES) {
    for (const label of LABELS) {
      for (const customer of CUSTOMERS) {
        for (const amount of AMOUNTS) {
          for (const date of DATES) {
            for (const periodicity of PERIODICITIES) {
              for (const equipment of EQUIPMENTS) {
                const order = ORDERS[index % ORDERS.length] ?? [];
                const separator =
                  SEPARATORS[Math.floor(index / ORDERS.length) % SEPARATORS.length] ?? ' ';
                const position =
                  POSITIONS[Math.floor(index / (ORDERS.length * SEPARATORS.length)) % POSITIONS.length] ??
                  'apres';
                index += 1;
                const said = [
                  customer.said,
                  amount.said,
                  date.said,
                  periodicity.said,
                  equipment.said,
                ];
                const facts = order
                  .map((slot) => said[slot] ?? '')
                  .filter((segment) => segment.length > 0);
                const cut =
                  position === 'apres' ? 0 : position === 'avant' ? facts.length : Math.min(1, facts.length);
                const before = facts.slice(0, cut);
                const after = facts.slice(cut);
                const head = before.length === 0 ? `${gesture} ${label}` : lowerFirst(`${gesture} ${label}`);
                corpus.push({
                  phrase: [...before, head, ...after].join(separator),
                  label,
                  position,
                  customer,
                  amount,
                  date,
                  periodicity,
                  equipment,
                });
              }
            }
          }
        }
      }
    }
  }
  return corpus;
}

const CORPUS = buildCorpus();

// ── Détecteurs d'invariants — AUCUN lexique emprunté au code testé ───────────────────────────

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * Mots-outils du FRANÇAIS — grammaire, pas lexique d'extracteur. Ils appartiennent à toutes les
 * phrases et ne prouvent aucune fuite : « Nettoyage à sec hall B » contient légitimement « à ».
 * Aucun pronom ni aucun verbe n'y figure : « ils ont 3 machines » qui fuirait dans un nom de
 * contrat DOIT être vu.
 */
const MOTS_OUTILS: ReadonlySet<string> = new Set([
  'a', 'au', 'aux', 'de', 'du', 'des', 'd', 'l', 'le', 'la', 'les', 'un', 'une',
  'et', 'ou', 'en', 'sur', 'par', 'pour', 'chez', 'avec', 'sans', 'dans',
]);

/** Jetons SIGNIFICATIFS d'un fragment dicté — la seule « connaissance » du test est le corpus. */
function jetons(said: string): string[] {
  return fold(said)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !MOTS_OUTILS.has(token));
}

/**
 * PROPRIÉTÉS STRUCTURELLES — formulées comme des FORMES, jamais comme des listes de mots, pour
 * ne pas retester la copie du lexique du code :
 *  · `CHIFFRE_PUIS_MOT_MONETAIRE` : « aucun chiffre suivi d'un mot court commençant par € ou e »
 *    — elle attrape €, euro, euros, eur, k€, keuros sans les nommer ;
 *  · `SYMBOLE_MONETAIRE` : aucun symbole de devise, où qu'il soit ;
 *  · `NOMBRE_ECRIT_COMME_UNE_SOMME` : un groupe de chiffres séparé par un point, une virgule ou
 *    une espace d'un groupe de 2 ou 3 chiffres — c'est la FORME d'une somme, pas son lexique.
 */
const CHIFFRE_PUIS_MOT_MONETAIRE = /\d[\s\u00a0\u202f]*(?:k[\s\u00a0\u202f]*)?(?:€|e\p{L}{0,3}\b)/iu;
const SYMBOLE_MONETAIRE = /[€$£]/u;
const NOMBRE_ECRIT_COMME_UNE_SOMME = /\d[.,\s\u00a0\u202f]\d{2,3}\b/u;

interface Failure {
  readonly invariant: string;
  readonly phrase: string;
  readonly observed: string;
}

function checkEntry(entry: CorpusEntry): Failure[] {
  const failures: Failure[] = [];
  const facts = extractSpokenContractFacts(entry.phrase, TODAY, {
    customerNames: CUSTOMER_FILE,
  });
  const label = facts.label;
  const fail = (invariant: string, observed: string): void => {
    failures.push({ invariant, phrase: entry.phrase, observed });
  };

  // (1) — un libellé métier a été dicté : il ne peut pas revenir vide.
  if (label === null || label.trim().length === 0) {
    fail('1 · libellé non vide quand un libellé métier est dicté', String(label));
    return failures;
  }

  // (2) — FUITE : aucun jeton d'un fait INJECTÉ ne réapparaît dans le libellé lu, sauf s'il
  //       appartient déjà au libellé métier (« 12 » est légitime dans « Entretien 12 ascenseurs »).
  //       Ce détecteur ne connaît que ce que le GÉNÉRATEUR a dit — source indépendante du code.
  const duMetier = new Set(jetons(entry.label));
  const duLabelLu = new Set(jetons(label));
  const fuites = [
    entry.customer.said,
    entry.amount.said,
    entry.date.said,
    entry.periodicity.said,
    entry.equipment.said,
  ]
    .flatMap(jetons)
    .filter((token) => !duMetier.has(token) && duLabelLu.has(token));
  if (fuites.length > 0) {
    fail(`2 · fuite d’un fait dit dans le libellé (« ${[...new Set(fuites)].join(', ')} »)`, label);
  }

  // (3) — PROPRIÉTÉS : aucune trace de somme, quelle qu'en soit l'écriture.
  if (CHIFFRE_PUIS_MOT_MONETAIRE.test(label)) fail('3a · chiffre collé à un mot monétaire', label);
  if (SYMBOLE_MONETAIRE.test(label)) fail('3b · symbole monétaire dans le libellé', label);
  if (NOMBRE_ECRIT_COMME_UNE_SOMME.test(label)) fail('3c · nombre écrit comme une somme', label);

  // (4) — RESTITUTION EXACTE : ni sur-coupe (un nom mutilé s'imprimerait tel quel), ni
  //       sous-coupe. C'est l'invariant le plus fort : il subsume les précédents et les rend
  //       lisibles quand il tombe.
  if (label !== entry.label) {
    fail(`4 · restitution exacte (attendu « ${entry.label} »)`, label);
  }

  // (5) — STABILITÉ PAR RELECTURE : la forme canonique que Bob REDIT à chaque followUp doit se
  //       relire à l'identique, sinon le libellé se reconstruirait autrement d'un tour à l'autre.
  const reread = extractSpokenContractLabel(
    `Crée le contrat « ${label} » pour le client cus-x à 15000 € par an, à partir du 01/10/2026`,
    { customerNames: CUSTOMER_FILE },
  );
  if (reread !== label) fail(`5 · stable par relecture (relu « ${String(reread)} »)`, label);

  // (6) — LA GARDE NE COÛTE PAS UNE QUESTION INUTILE : un libellé métier correctement dicté doit
  //       traverser la garde SANS refus. C'est le contrepoids honnête de la garde fail-closed —
  //       elle a le droit d'être large, pas celui de rendre le geste vocal impraticable.
  const verdict = inspectContractLabel(label, { customerNames: CUSTOMER_FILE });
  if (!verdict.accepted) {
    fail(`6 · la garde refuse un libellé métier légitime (${verdict.blocking.join(', ')})`, label);
  }

  // ── Faits voisins : ils prouvent que la découpe n'a pas été obtenue en abîmant la lecture ──
  if (facts.annualAmountCents !== entry.amount.cents) {
    fail(`montant lu (attendu ${String(entry.amount.cents)})`, String(facts.annualAmountCents));
  }
  if (facts.startDate !== entry.date.date) {
    fail(`date de démarrage lue (attendu ${String(entry.date.date)})`, String(facts.startDate));
  }
  if (facts.visitsPerYear !== entry.periodicity.visits) {
    fail(
      `périodicité lue (attendu ${String(entry.periodicity.visits)})`,
      String(facts.visitsPerYear),
    );
  }
  // equipmentCount : SEUL un cadre de parc explicite compte désormais. La corroboration par le
  // LIBELLÉ a été supprimée parce qu'elle était TAUTOLOGIQUE — le libellé est lui-même lu de la
  // phrase, il ne prouve donc rien de plus qu'elle, et « entretien 4 saisons » s'auto-corroborait
  // en 4 ÉQUIPEMENTS que Bob récitait au point de décision d'une mutation.
  if (facts.equipmentCount !== entry.equipment.count) {
    fail(`équipements comptés (attendu ${String(entry.equipment.count)})`, String(facts.equipmentCount));
  }
  return failures;
}

function report(failures: readonly Failure[]): string {
  if (failures.length === 0) return '';
  const shown = failures.slice(0, 25);
  const lines = shown.map(
    (failure) => `• [${failure.invariant}] « ${failure.phrase} » ⇒ « ${failure.observed} »`,
  );
  if (failures.length > shown.length) {
    lines.push(`• … et ${failures.length - shown.length} autre(s) échec(s)`);
  }
  return lines.join('\n');
}

describe('libellé de contrat — invariants sur corpus combinatoire (§2.7)', () => {
  it('le corpus croise TOUTES les manières de dire chaque fait, et toutes les POSITIONS', () => {
    expect(CORPUS.length).toBe(
      GESTURES.length *
        LABELS.length *
        CUSTOMERS.length *
        AMOUNTS.length *
        DATES.length *
        PERIODICITIES.length *
        EQUIPMENTS.length,
    );
    // Le seuil de la revue : au moins 300 phrases réalistes, dictées dans le désordre.
    expect(CORPUS.length).toBeGreaterThanOrEqual(300);
    // Les deux styles de dictée sont représentés : ponctuée ET d'une traite (sans virgule).
    expect(CORPUS.some((entry) => entry.phrase.includes(','))).toBe(true);
    expect(CORPUS.some((entry) => !entry.phrase.includes(','))).toBe(true);
    // Les TROIS positions sont réellement produites — sans quoi l'angle mort resterait ouvert.
    for (const position of POSITIONS) {
      const sample = CORPUS.filter((entry) => entry.position === position);
      expect(sample.length, `position « ${position} » absente du corpus`).toBeGreaterThan(0);
    }
    // …et un fait est bien dit AVANT le geste dans la position « avant ».
    const avant = CORPUS.find(
      (entry) => entry.position === 'avant' && entry.customer.said.length > 0,
    );
    expect(avant?.phrase.indexOf('ontrat')).toBeGreaterThan(0);
  });

  it(
    'aucune phrase du corpus ne laisse un fait dit polluer le libellé (échecs ÉNUMÉRÉS)',
    () => {
      const failures = CORPUS.flatMap(checkEntry);
      expect(
        report(failures),
        `${failures.length} violation(s) d’invariant sur ${CORPUS.length} phrases du corpus`,
      ).toBe('');
    },
    120_000,
  );
});
