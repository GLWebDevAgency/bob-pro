import { describe, expect, it } from 'vitest';
import { extractSpokenContractFacts, extractSpokenContractLabel } from './contract-command';

/**
 * §2.7 — TEST D'INVARIANT SUR CORPUS COMBINATOIRE.
 *
 * POURQUOI CE TEST EXISTE : trois revues successives ont trouvé la MÊME pathologie sous trois
 * formes différentes (un montant qui reste collé au libellé, puis une date, puis le nom du
 * client). À chaque fois la correction ajoutait un motif de plus à une liste de nettoyeurs, et à
 * chaque fois la revue suivante trouvait la forme parlée que la liste ne couvrait pas. Le libellé
 * est persisté comme libellé du contrat ET de sa LIGNE UNIQUE, donc repris comme LIGNE de la
 * facture annuelle : il s'IMPRIME sur une pièce légale archivée immuable. La confirmation vocale
 * ne protège de rien — elle récite le libellé fautif, le pro entend sa propre phrase et valide.
 *
 * CE QUE CE TEST GARANTIT : on ne vérifie plus des exemples, on vérifie des INVARIANTS sur le
 * PRODUIT CARTÉSIEN de toutes les manières de dire chaque fait. Une forme parlée ajoutée demain à
 * l'une des dimensions est immédiatement croisée avec toutes les autres — la classe de bug ne
 * peut plus se réintroduire par un angle mort d'énumération.
 *
 * Le corpus se génère en TypeScript, sans dépendance de fuzzing : il est DÉTERMINISTE, donc un
 * échec est reproductible à l'identique et la revue peut relire la phrase fautive.
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
 * `impliedCount` : le nombre d'équipements que le LIBELLÉ lui-même corrobore (« Entretien 12
 * ascenseurs » nomme bien 12 objets du parc) lorsqu'aucun cadre de parc n'est dit par ailleurs.
 */
interface BusinessLabel {
  readonly said: string;
  readonly impliedCount: number | null;
}
const LABELS: readonly BusinessLabel[] = [
  { said: 'Entretien vitrines', impliedCount: null },
  { said: 'Entretien 12 ascenseurs', impliedCount: 12 },
  { said: 'Porte-à-faux quai 3', impliedCount: null },
  { said: 'Nettoyage à sec hall B', impliedCount: null },
  { said: 'Maintenance Eurotunnel Nord', impliedCount: null },
  { said: 'Dépannage fontaines Europe 2', impliedCount: null },
];

// ── Dimension 3 : CLIENT ────────────────────────────────────────────────────────────────────
/**
 * « Carrefour » est aussi un nom COMMUN : c'est le piège qui interdit de traiter un nom propre
 * comme un simple mot rare. « pour RATP » (sans le mot « client ») est la forme qui a échappé à
 * la quatrième revue — elle n'est reconnaissable que parce que RATP est un client du fichier.
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

interface CorpusEntry {
  readonly phrase: string;
  readonly label: BusinessLabel;
  readonly customer: SpokenCustomer;
  readonly amount: SpokenAmount;
  readonly date: SpokenDate;
  readonly periodicity: SpokenPeriodicity;
  readonly equipment: SpokenEquipment;
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
                index += 1;
                const said = [
                  customer.said,
                  amount.said,
                  date.said,
                  periodicity.said,
                  equipment.said,
                ];
                const tail = order
                  .map((position) => said[position] ?? '')
                  .filter((segment) => segment.length > 0);
                corpus.push({
                  phrase: [`${gesture} ${label.said}`, ...tail].join(separator),
                  label,
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

// ── Détecteurs d'invariants ─────────────────────────────────────────────────────────────────

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const MONEY_MARKER = /€|\beuros?\b|\beur\b|\bballes?\b|\bboules?\b|\bkeuros?\b/i;
const DATE_MARKER =
  /\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}|\b(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\b|\ba partir\b|\ba compter\b|\bdes le\b|\bca demarre\b|\b1er\b/i;
const PERIODICITY_MARKER =
  /\bvisites?\b|\bpassages?\b|\binterventions?\b|\btous les\b|\bfois par\b|\bpar an\b|\bpar trimestre\b|\bpar semestre\b/i;

interface Failure {
  readonly invariant: string;
  readonly phrase: string;
  readonly observed: string;
}

/** Les SEPT invariants du libellé, plus la restitution exacte et le comptage d'équipements. */
function checkEntry(entry: CorpusEntry): Failure[] {
  const failures: Failure[] = [];
  const facts = extractSpokenContractFacts(entry.phrase, TODAY, {
    customerNames: CUSTOMER_FILE,
  });
  const label = facts.label;
  const fail = (invariant: string, observed: string): void => {
    failures.push({ invariant, phrase: entry.phrase, observed });
  };

  // (6) — un libellé métier a été dicté : il ne peut pas revenir vide.
  if (label === null || label.trim().length === 0) {
    fail('6 · libellé non vide quand un libellé métier est dicté', String(label));
    return failures;
  }
  const folded = fold(label);
  // Ce qui reste du libellé une fois le libellé MÉTIER retiré : tout résidu est une pollution.
  const residue = folded.replace(fold(entry.label.said), ' ');

  // (1) — aucun chiffre d'un montant dit (les chiffres du libellé métier, eux, sont légitimes).
  if (/\d/.test(residue)) fail('1 · aucun chiffre de montant dans le libellé', label);
  // (2) — aucun symbole ni mot monétaire, argot compris.
  if (MONEY_MARKER.test(folded)) fail('2 · aucun symbole ni mot monétaire', label);
  // (3) — aucune date ni marqueur de date.
  if (DATE_MARKER.test(folded)) fail('3 · aucune date ni marqueur de date', label);
  // (4) — le nom du client dit n'appartient pas au libellé.
  for (const token of fold(entry.customer.name).split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2 && folded.includes(token)) {
      fail(`4 · le nom du client (« ${entry.customer.name} ») hors du libellé`, label);
      break;
    }
  }
  // (5) — la cadence dite n'appartient pas au libellé.
  if (PERIODICITY_MARKER.test(folded)) fail('5 · aucune périodicité dans le libellé', label);
  // (6 bis) — le libellé métier est restitué MOT POUR MOT : ni sur-coupe, ni sous-coupe.
  if (label !== entry.label.said) {
    fail(`6 bis · restitution exacte (attendu « ${entry.label.said} »)`, label);
  }
  // (7) — stabilité par relecture : la forme canonique que Bob REDIT à chaque followUp doit se
  // relire à l'identique, sinon le libellé se reconstruirait autrement d'un tour à l'autre.
  const reread = extractSpokenContractLabel(
    `Crée le contrat « ${label} » pour le client cus-x à 15000 € par an, à partir du 01/10/2026`,
    { customerNames: CUSTOMER_FILE },
  );
  if (reread !== label) fail(`7 · stable par relecture (relu « ${String(reread)} »)`, label);

  // Faits voisins : ils prouvent que la découpe n'a pas été obtenue en abîmant la lecture.
  if (facts.annualAmountCents !== entry.amount.cents) {
    fail(
      `montant lu (attendu ${String(entry.amount.cents)})`,
      String(facts.annualAmountCents),
    );
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
  // equipmentCount : un CADRE de parc dit prime ; sinon seul le libellé peut corroborer ;
  // à défaut, aucun fait — jamais un nombre faux au point de décision d'une mutation.
  const expectedCount = entry.equipment.count ?? entry.label.impliedCount;
  if (facts.equipmentCount !== expectedCount) {
    fail(
      `équipements comptés (attendu ${String(expectedCount)})`,
      String(facts.equipmentCount),
    );
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
  it('le corpus croise TOUTES les manières de dire chaque fait', () => {
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
    60_000,
  );
});
