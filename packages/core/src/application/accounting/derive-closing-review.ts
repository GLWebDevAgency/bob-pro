import { type DateOnly } from '../../shared-kernel/time';
import { formatEUR } from '../../format/money';
import { deriveTrialBalance } from './derive-trial-balance';
import { deriveIncomeStatement } from './derive-income-statement';
import { deriveBalanceSheet } from './derive-balance-sheet';

/**
 * Revue de clôture (DOSSIER-2) — les DILIGENCES d'un expert-comptable exécutées par Bob avant
 * signature. Là où le dossier de clôture (DOSSIER-1) PRÉSENTE les états, la revue les CONTRÔLE :
 * elle rejoue les vérifications qu'un EC fait à la main et rend un verdict « prêt pour la revue
 * de l'expert-comptable » (Bob ne signe jamais — discipline de wording). Conçue puis VÉRIFIÉE
 * adversarialement (workflow wf_75ee09c3-b3e : réviseur + CAC + contrôleur de synthèse).
 * Use case PUR (aucune I/O, aucune horloge).
 *
 * Quatre statuts, calibrés comme la profession :
 * · ANOMALIE  = erreur comptable dure qui INTERDIT la signature (partie double, bilan,
 *   cohérence des états, caisse créditrice, dossier vide, 4191 débiteur) ;
 * · ATTENTION = réserve laissée à l'appréciation de l'EC (compte d'attente ouvert, tiers à
 *   contre-sens, banque créditrice, pièce sans justificatif, écriture hors période/non datée) ;
 * · INFO      = information ou limitation d'étendue — HORS compteur de réussite (une donnée
 *   non fournie n'est pas un contrôle réussi ; la position de TVA au grand-livre informe,
 *   elle ne déclare pas) ;
 * · OK        = diligence exécutée et passée.
 * readyToSign = ZÉRO anomalie ; hasReserves = au moins une attention (« signable sous réserves »).
 *
 * Règles cardinales issues de la vérification :
 * · JAMAIS de somme par préfixe pour un contrôle de SENS ou de SOLDAGE (471 débiteur et 472
 *   créditeur se compenseraient) — itération compte par compte ; la somme reste licite pour
 *   les positions agrégées (TVA).
 * · Ordre des préfixes tiers : 419 avant 41, 409 avant 40 (sinon un 4191 créditeur — normal —
 *   serait flagué « client créditeur »).
 * · Banque : cibler 512/514, jamais « 51 » entier (5186 Intérêts courus à payer est créditeur
 *   normal sur import FEC).
 * · TVA : aucun verbe fiscal depuis le grand-livre — 44571 est crédité à l'ÉMISSION et jamais
 *   liquidé par les flux ; la vérité déclarative est deriveVatPosition (encaissements,
 *   art. 269, 2-c CGI). Le 44567 (crédit reporté) est EXCLU du cumul déductible de période.
 * · Les détails LISTENT les comptes/écritures fautifs avec leur solde SIGNÉ et leur sens —
 *   l'EC corrige, il ne devine pas.
 * · PÉRIMÈTRE : les états et les positions se dérivent sur les écritures de la période (les
 *   écritures DATÉES hors période sont exclues et signalées) ; la partie double et l'équilibre
 *   pièce par pièce se contrôlent sur le jeu COMPLET (une écriture corrompue hors période doit
 *   rester détectée). Mono-exercice v1 — les à-nouveaux (bilan cumulatif vs CR périodique)
 *   sont un chantier ultérieur documenté.
 * · Le contrôle caisse porte sur le SOLDE EN CLÔTURE (le contrôle chronologique jour par jour
 *   est un chantier v2) ; les flux automatiques ne créditent jamais 53x (les décaissements
 *   passent par 512) — cette diligence couvre les OD manuelles et les imports.
 */

export interface ClosingReviewEntryData {
  entryDate?: DateOnly;
  lines: readonly { account: string; debitCents: number; creditCents: number }[];
}

export type ReviewStatus = 'ok' | 'info' | 'attention' | 'anomalie';

export interface ReviewControl {
  id: string;
  label: string;
  status: ReviewStatus;
  /** Explication lisible et ACTIONNABLE (comptes fautifs, soldes signés, sens en toutes
   *  lettres) — reprise telle quelle dans le dossier et à l'écran. */
  detail: string;
}

export interface ClosingReview {
  controls: ReviewControl[];
  /** Diligences exécutées et passées — les 'info' n'y comptent JAMAIS. */
  okCount: number;
  attentionCount: number;
  anomalieCount: number;
  infoCount: number;
  /** Aucune anomalie dure — prêt pour la revue de l'expert-comptable (qui seul signe). */
  readyToSign: boolean;
  /** Au moins une attention : signable « sous réserves », points à justifier. */
  hasReserves: boolean;
}

export interface ClosingReviewInput {
  /** Le grand-livre COMPLET — la revue filtre elle-même pour les états (voir doctrine). */
  entries: readonly ClosingReviewEntryData[];
  /** Période revue — active « écritures dans la période » et borne les états dérivés. */
  period?: { from: DateOnly; to: DateOnly };
  /** Compteur de pièces justificatives (caller) — non fourni ⇒ limitation d'étendue (info). */
  justificatifs?: { expected: number; provided: number };
  /** Clôture d'EXERCICE (vs revue mensuelle) : durcit le contrôle des avances clients 4191
   *  (créditrices en fin d'exercice = attention ; en cours d'année c'est normal = info). */
  yearEnd?: boolean;
}

/** Écritures retenues pour les états et les positions : les écritures DATÉES hors période
 *  sont exclues (et signalées par la revue) ; les non datées restent incluses (et signalées).
 *  Exportée pour que buildClosingDossier dérive ses états sur le MÊME périmètre. */
export function filterClosingPeriodEntries<T extends ClosingReviewEntryData>(
  entries: readonly T[],
  period?: { from: DateOnly; to: DateOnly },
): readonly T[] {
  if (!period) return entries;
  return entries.filter(
    (entry) => entry.entryDate === undefined || (entry.entryDate >= period.from && entry.entryDate <= period.to),
  );
}

const MAX_LISTED = 4;

function balanceByAccount(entries: readonly ClosingReviewEntryData[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      map.set(line.account, (map.get(line.account) ?? 0) + line.debitCents - line.creditCents);
    }
  }
  return map;
}

/** « 471 : 500,00 € débiteur » — solde signé, sens en toutes lettres, liste plafonnée. */
function listAccounts(faulty: readonly { account: string; balanceCents: number }[]): string {
  const shown = faulty
    .slice(0, MAX_LISTED)
    .map((f) => `${f.account} : ${formatEUR(Math.abs(f.balanceCents))} ${f.balanceCents >= 0 ? 'débiteur' : 'créditeur'}`)
    .join(' · ');
  const rest = faulty.length - MAX_LISTED;
  return rest > 0 ? `${shown} · +${rest} autre(s)` : shown;
}

/** Comptes du périmètre (préfixes inclus, préfixes exclus prioritaires) à solde non nul. */
function faultyAccounts(
  balances: Map<string, number>,
  include: readonly string[],
  opts?: { exclude?: readonly string[]; keep?: (balanceCents: number) => boolean },
): { account: string; balanceCents: number }[] {
  const out: { account: string; balanceCents: number }[] = [];
  for (const [account, balanceCents] of balances) {
    if (!include.some((p) => account.startsWith(p))) continue;
    if (opts?.exclude?.some((p) => account.startsWith(p))) continue;
    if (balanceCents === 0) continue;
    if (opts?.keep && !opts.keep(balanceCents)) continue;
    out.push({ account, balanceCents });
  }
  return out.sort((a, b) => a.account.localeCompare(b.account));
}

export function deriveClosingReview(input: ClosingReviewInput): ClosingReview {
  const all = input.entries;
  const scoped = filterClosingPeriodEntries(all, input.period);
  const controls: ReviewControl[] = [];

  // ── Garde : un dossier vide n'est pas « tout vert », il est vide ─────────────────────
  if (all.length === 0) {
    controls.push({
      id: 'dossier_vide',
      label: 'Écritures présentes',
      status: 'anomalie',
      detail: 'Aucune écriture au grand-livre — il n’y a rien à réviser ni à signer.',
    });
  }

  // ── Diligences dures (une anomalie interdit la signature) — jeu COMPLET ─────────────
  const tbAll = deriveTrialBalance(all);
  controls.push({
    id: 'partie_double',
    label: 'Partie double équilibrée',
    status: tbAll.balanced ? 'ok' : 'anomalie',
    detail: tbAll.balanced
      ? `Débit = Crédit = ${formatEUR(tbAll.totalDebitCents)}`
      : `Écart Débit/Crédit de ${formatEUR(Math.abs(tbAll.totalDebitCents - tbAll.totalCreditCents))} — grand-livre corrompu`,
  });

  const imbalanced: string[] = [];
  all.forEach((entry, index) => {
    let d = 0;
    let c = 0;
    for (const line of entry.lines) {
      d += line.debitCents;
      c += line.creditCents;
    }
    if (d !== c) imbalanced.push(entry.entryDate ? `n°${index + 1} du ${entry.entryDate}` : `n°${index + 1} (non datée)`);
  });
  controls.push({
    id: 'ecritures_equilibrees',
    label: 'Écritures équilibrées une à une',
    status: imbalanced.length === 0 ? 'ok' : 'anomalie',
    detail:
      imbalanced.length === 0
        ? `${all.length} écriture(s) équilibrée(s)`
        : `${imbalanced.length} écriture(s) déséquilibrée(s) : ${imbalanced.slice(0, MAX_LISTED).join(' · ')}${imbalanced.length > MAX_LISTED ? ` · +${imbalanced.length - MAX_LISTED} autre(s)` : ''}`,
  });

  // ── États et positions — périmètre de la PÉRIODE ────────────────────────────────────
  const tb = deriveTrialBalance(scoped);
  const is = deriveIncomeStatement(scoped);
  const bs = deriveBalanceSheet(scoped);
  const balances = balanceByAccount(scoped);

  controls.push({
    id: 'bilan_equilibre',
    label: 'Bilan équilibré (actif = passif)',
    status: bs.balanced ? 'ok' : 'anomalie',
    detail: bs.balanced
      ? `Actif = Passif = ${formatEUR(bs.actif.totalCents)}`
      : `Écart actif/passif de ${formatEUR(Math.abs(bs.ecartCents))} — un compte hors classes 1-7 échappe au bilan (import ?)`,
  });

  const coherent = tb.resultCents === is.resultatNetCents && is.resultatNetCents === bs.passif.resultatNetCents;
  controls.push({
    id: 'coherence_etats',
    label: 'Cohérence balance / résultat / bilan',
    status: coherent ? 'ok' : 'anomalie',
    detail: coherent
      ? `Résultat identique dans les trois états : ${formatEUR(is.resultatNetCents)}`
      : `Divergence (balance ${formatEUR(tb.resultCents)} · CR ${formatEUR(is.resultatNetCents)} · bilan ${formatEUR(bs.passif.resultatNetCents)}) — défaut de dérivation à remonter au support, pas une erreur de saisie`,
  });

  const cashFaulty = faultyAccounts(balances, ['53'], { keep: (b) => b < 0 });
  controls.push({
    id: 'caisse',
    label: 'Caisse non créditrice en clôture',
    status: cashFaulty.length === 0 ? 'ok' : 'anomalie',
    detail:
      cashFaulty.length === 0
        ? 'Aucun compte de caisse créditeur'
        : `Caisse créditrice — impossible, à corriger : ${listAccounts(cashFaulty)}`,
  });

  // ── Réserves (attention — l'EC apprécie), compte par compte ─────────────────────────
  const suspenseFaulty = faultyAccounts(balances, ['47', '58']);
  controls.push({
    id: 'comptes_attente',
    label: "Comptes d'attente soldés (47, 58)",
    status: suspenseFaulty.length === 0 ? 'ok' : 'attention',
    detail:
      suspenseFaulty.length === 0
        ? 'Aucun compte d’attente ouvert'
        : `À imputer avant clôture : ${listAccounts(suspenseFaulty)}`,
  });

  // Tiers à contre-sens — 419/409 testés AVANT 41/40 (un 4191 créditeur est normal).
  const clientCreditors = faultyAccounts(balances, ['41'], { exclude: ['419'], keep: (b) => b < 0 });
  const supplierDebtors = faultyAccounts(balances, ['40'], { exclude: ['409'], keep: (b) => b > 0 });
  const advancePaidCreditors = faultyAccounts(balances, ['409'], { keep: (b) => b < 0 });
  const contresens = [...clientCreditors, ...supplierDebtors, ...advancePaidCreditors];
  controls.push({
    id: 'tiers_contresens',
    label: 'Tiers à contre-sens (client créditeur, fournisseur débiteur)',
    status: contresens.length === 0 ? 'ok' : 'attention',
    detail:
      contresens.length === 0
        ? 'Clients débiteurs, fournisseurs créditeurs : sens normaux'
        : [
            clientCreditors.length > 0 ? `Client(s) créditeur(s), trop-perçu ou acompte à reclasser en 4191 — ${listAccounts(clientCreditors)}` : null,
            supplierDebtors.length > 0 ? `Fournisseur(s) débiteur(s), double paiement ou avoir attendu — ${listAccounts(supplierDebtors)}` : null,
            advancePaidCreditors.length > 0 ? `Avance(s) versée(s) créditrice(s), anormal — ${listAccounts(advancePaidCreditors)}` : null,
          ]
            .filter((s): s is string => s !== null)
            .join(' ; '),
  });

  // Avances clients 4191 : débitrices = corruption (la reprise miroir est allouée au centime,
  // jamais au-delà) ; créditrices = en-cours légitime (info) sauf en clôture d'exercice
  // (attention : chantiers en cours, ou finale émise sans reprise ?).
  const advancesDebtors = faultyAccounts(balances, ['419'], { keep: (b) => b > 0 });
  const advancesCreditors = faultyAccounts(balances, ['419'], { keep: (b) => b < 0 });
  const advancesStatus: ReviewStatus =
    advancesDebtors.length > 0 ? 'anomalie' : advancesCreditors.length === 0 ? 'ok' : input.yearEnd ? 'attention' : 'info';
  controls.push({
    id: 'avances_4191',
    label: 'Avances clients (4191)',
    status: advancesStatus,
    detail:
      advancesDebtors.length > 0
        ? `Avance(s) DÉBITRICE(s) — impossible par construction, corruption ou OD erronée : ${listAccounts(advancesDebtors)}`
        : advancesCreditors.length === 0
          ? 'Aucune avance ouverte — tous les acomptes sont repris'
          : `${listAccounts(advancesCreditors)} — ${input.yearEnd ? 'non reprises en fin d’exercice : chantiers en cours, ou finale émise sans reprise d’acompte ?' : 'chantiers en cours (normal en cours d’année)'}`,
  });

  // Banque créditrice : 512/514 ciblés, JAMAIS « 51 » (5186 créditeur est normal).
  const bankCreditors = faultyAccounts(balances, ['512', '514'], { keep: (b) => b < 0 });
  controls.push({
    id: 'banque_crediteur',
    label: 'Banque créditrice (découvert)',
    status: bankCreditors.length === 0 ? 'ok' : 'attention',
    detail:
      bankCreditors.length === 0
        ? 'Aucun compte bancaire créditeur'
        : `Découvert à confirmer sur le relevé, ou encaissement non enregistré : ${listAccounts(bankCreditors)}`,
  });

  const undated = all.filter((entry) => entry.entryDate === undefined).length;
  controls.push({
    id: 'ecritures_non_datees',
    label: 'Écritures datées',
    status: undated === 0 ? 'ok' : 'attention',
    detail:
      undated === 0
        ? 'Toutes les écritures sont datées'
        : `${undated} écriture(s) sans date — inexploitables au FEC (art. A47 A-1 LPF), à dater avant clôture`,
  });

  if (input.justificatifs) {
    const { expected, provided } = input.justificatifs;
    if (provided > expected) {
      controls.push({
        id: 'justificatifs',
        label: 'Pièces justificatives au coffre',
        status: 'attention',
        detail: `Comptage incohérent : ${provided} pièce(s) justifiée(s) pour ${expected} attendue(s) — à vérifier`,
      });
    } else {
      const missing = expected - provided;
      const significant = expected > 0 && missing * 4 > expected; // > 25 % : matérialité
      controls.push({
        id: 'justificatifs',
        label: 'Pièces justificatives au coffre',
        status: missing === 0 ? 'ok' : 'attention',
        detail:
          missing === 0
            ? `${provided} pièce(s) justifiée(s)`
            : `${missing} pièce(s) sans justificatif sur ${expected}${significant ? ' — proportion significative' : ''}`,
      });
    }
  } else {
    // Limitation d'étendue : une diligence non exécutée doit être VISIBLE, pas absente.
    controls.push({
      id: 'justificatifs',
      label: 'Pièces justificatives au coffre',
      status: 'info',
      detail: 'Non contrôlé — comptage des pièces non fourni',
    });
  }

  if (input.period) {
    const { from, to } = input.period;
    const outOfPeriod = all.filter((entry) => entry.entryDate !== undefined && (entry.entryDate < from || entry.entryDate > to)).length;
    controls.push({
      id: 'hors_periode',
      label: 'Écritures dans la période',
      status: outOfPeriod === 0 ? 'ok' : 'attention',
      detail:
        outOfPeriod === 0
          ? `Période du ${from} au ${to}`
          : `${outOfPeriod} écriture(s) hors de la période ${from} → ${to} — exclue(s) des états présentés`,
    });
  } else {
    controls.push({
      id: 'hors_periode',
      label: 'Écritures dans la période',
      status: 'info',
      detail: 'Non contrôlé — période non fournie',
    });
  }

  // ── Information : position de TVA au grand-livre (JAMAIS un montant « à payer ») ─────
  // 44567 (crédit de TVA à reporter) est EXCLU du cumul déductible de la période.
  let vatCollected = 0;
  let vatDeductible = 0;
  let vatCarriedCredit = 0;
  for (const [account, balance] of balances) {
    if (account.startsWith('4457')) vatCollected += -balance;
    else if (account.startsWith('44567')) vatCarriedCredit += balance;
    else if (account.startsWith('4456')) vatDeductible += balance;
  }
  const vatNet = vatCollected - vatDeductible;
  const carried = vatCarriedCredit !== 0 ? ` (dont crédit de TVA reporté : ${formatEUR(vatCarriedCredit)}, hors cumul)` : '';
  controls.push({
    id: 'tva',
    label: 'Position de TVA au grand-livre',
    status: 'info',
    detail:
      vatCollected === 0 && vatDeductible === 0
        ? `Aucune TVA sur la période${carried}`
        : vatCollected < 0
          ? `TVA collectée négative (avoirs nets) : ${formatEUR(vatCollected)} — déductible ${formatEUR(vatDeductible)}${carried}`
          : `Collectée ${formatEUR(vatCollected)} − déductible ${formatEUR(vatDeductible)} = ${formatEUR(vatNet)} (fait générateur à la facturation). En régime des encaissements, l’exigible suit les paiements reçus — se référer à la position de TVA de Bob pour la déclaration.${carried}`,
  });

  const okCount = controls.filter((c) => c.status === 'ok').length;
  const attentionCount = controls.filter((c) => c.status === 'attention').length;
  const anomalieCount = controls.filter((c) => c.status === 'anomalie').length;
  const infoCount = controls.filter((c) => c.status === 'info').length;

  return {
    controls,
    okCount,
    attentionCount,
    anomalieCount,
    infoCount,
    readyToSign: anomalieCount === 0,
    hasReserves: attentionCount > 0,
  };
}
