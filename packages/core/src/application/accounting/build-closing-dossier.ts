import { formatEUR } from '../../format/money';
import { type DateOnly } from '../../shared-kernel/time';
import { deriveTrialBalance } from './derive-trial-balance';
import { deriveIncomeStatement } from './derive-income-statement';
import { deriveBalanceSheet } from './derive-balance-sheet';
import { deriveClosingReview, filterClosingPeriodEntries, type ReviewStatus } from './derive-closing-review';

/**
 * Dossier de clôture (DOSSIER-1, enrichi DOSSIER-2) — la NOTE DE SYNTHÈSE lisible que
 * l'artisan envoie à son expert-comptable pour signature (vision « le cercle »). Ouvre sur la
 * REVUE DE PRÉ-SIGNATURE (les diligences exécutées par Bob : équilibres, cohérence des états,
 * comptes d'attente, justificatifs — deriveClosingReview) puis assemble les TROIS états de
 * synthèse dérivés (compte de résultat, bilan, balance générale), cohérents par construction.
 * Le FEC (fichier machine) l'accompagne à part. Use case PUR : ni I/O, ni date système.
 */

export interface ClosingDossierInput {
  company: { name: string; siren: string };
  period: { from: DateOnly; to: DateOnly };
  /** Date d'établissement du dossier (injectée — le domaine ne lit jamais l'horloge). */
  generatedOn: DateOnly;
  /** entryDate optionnelle : quand elle est fournie, la revue contrôle « écritures dans la période ». */
  entries: readonly { entryDate?: DateOnly; lines: readonly { account: string; debitCents: number; creditCents: number }[] }[];
  /** Compteur de pièces justificatives (fourni par le caller) — active le contrôle dédié de la revue. */
  justificatifs?: { expected: number; provided: number };
  /** Clôture d'exercice (vs mensuelle) — durcit le contrôle des avances clients de la revue. */
  yearEnd?: boolean;
}

export interface ClosingDossier {
  filename: string;
  content: string;
}

/** Ligne « Libellé ............ montant » alignée sur ~46 colonnes (lisible en texte brut). */
function row(label: string, cents: number, indent = 0): string {
  const pad = ' '.repeat(indent);
  const left = `${pad}${label}`;
  const right = formatEUR(cents);
  const dots = Math.max(2, 46 - left.length - right.length);
  return `${left} ${'.'.repeat(dots)} ${right}`;
}

function signed(cents: number): string {
  return `${cents >= 0 ? '+' : '−'}${formatEUR(Math.abs(cents))}`;
}

const STATUS_MARK: Record<ReviewStatus, string> = { ok: '✓', info: 'ℹ', attention: '!', anomalie: '✗' };

export function buildClosingDossier(input: ClosingDossierInput): ClosingDossier {
  // MÊME périmètre que la revue : les états présentés et les contrôles signés portent sur
  // les écritures de la période (les écritures datées hors période sont exclues ET signalées).
  const scoped = filterClosingPeriodEntries(input.entries, input.period);
  const tb = deriveTrialBalance(scoped);
  const is = deriveIncomeStatement(scoped);
  const bs = deriveBalanceSheet(scoped);
  const review = deriveClosingReview({
    entries: input.entries,
    period: input.period,
    ...(input.justificatifs ? { justificatifs: input.justificatifs } : {}),
    ...(input.yearEnd !== undefined ? { yearEnd: input.yearEnd } : {}),
  });

  const L: string[] = [];
  L.push('DOSSIER DE CLÔTURE');
  L.push(`${input.company.name} — SIREN ${input.company.siren}`);
  L.push(`Période du ${input.period.from} au ${input.period.to}`);
  L.push(`Établi le ${input.generatedOn} par Bob Pro`);
  L.push('');

  // La revue OUVRE le dossier : l'expert-comptable lit le verdict avant les chiffres.
  L.push('═══ REVUE DE PRÉ-SIGNATURE ═══');
  for (const control of review.controls) {
    L.push(`${STATUS_MARK[control.status]} ${control.label} — ${control.detail}`);
  }
  L.push(
    !review.readyToSign
      ? `VERDICT : NON PRÊT — ${review.anomalieCount} anomalie(s) à corriger avant signature.`
      : review.hasReserves
        ? `VERDICT : prêt à signer SOUS RÉSERVES — ${review.attentionCount} point(s) à justifier.`
        : 'VERDICT : prêt à signer — aucun point bloquant, aucune réserve.',
  );
  L.push('');

  L.push('═══ COMPTE DE RÉSULTAT ═══');
  L.push(row("Produits d'exploitation", is.exploitationProduitsCents));
  L.push(row("Charges d'exploitation", -is.exploitationChargesCents));
  L.push(row("Résultat d'exploitation", is.resultatExploitationCents));
  if (is.financierProduitsCents !== 0 || is.financierChargesCents !== 0) {
    L.push(row('Produits financiers', is.financierProduitsCents));
    L.push(row('Charges financières', -is.financierChargesCents));
    L.push(row('Résultat financier', is.resultatFinancierCents));
    L.push(row('Résultat courant avant impôt', is.resultatCourantCents));
  }
  if (is.resultatExceptionnelCents !== 0) {
    L.push(row('Résultat exceptionnel', is.resultatExceptionnelCents));
  }
  if (is.impotBeneficesCents !== 0) L.push(row('Impôt sur les bénéfices', -is.impotBeneficesCents));
  L.push(row('RÉSULTAT NET', is.resultatNetCents));
  L.push('');

  L.push('═══ BILAN ═══');
  L.push('ACTIF');
  if (bs.actif.immobilisationsNettesCents !== 0) L.push(row('Immobilisations nettes', bs.actif.immobilisationsNettesCents, 2));
  if (bs.actif.stocksCents !== 0) L.push(row('Stocks', bs.actif.stocksCents, 2));
  if (bs.actif.creancesCents !== 0) L.push(row('Créances', bs.actif.creancesCents, 2));
  if (bs.actif.disponibilitesCents !== 0) L.push(row('Disponibilités', bs.actif.disponibilitesCents, 2));
  L.push(row('Total actif', bs.actif.totalCents));
  L.push('PASSIF');
  if (bs.passif.capitauxPropresCents !== 0) L.push(row('Capitaux propres', bs.passif.capitauxPropresCents, 2));
  if (bs.passif.resultatNetCents !== 0) L.push(row("Résultat de l'exercice", bs.passif.resultatNetCents, 2));
  if (bs.passif.provisionsCents !== 0) L.push(row('Provisions', bs.passif.provisionsCents, 2));
  if (bs.passif.empruntsCents !== 0) L.push(row('Emprunts et dettes financières', bs.passif.empruntsCents, 2));
  if (bs.passif.dettesCents !== 0) L.push(row('Dettes', bs.passif.dettesCents, 2));
  if (bs.passif.decouvertCents !== 0) L.push(row('Découvert', bs.passif.decouvertCents, 2));
  L.push(row('Total passif', bs.passif.totalCents));
  L.push(bs.balanced ? 'Équilibre : actif = passif ✓' : `Équilibre : écart de ${formatEUR(Math.abs(bs.ecartCents))} À VÉRIFIER`);
  L.push('');

  L.push('═══ BALANCE GÉNÉRALE ═══');
  L.push('Compte        Débit         Crédit        Solde');
  for (const r of tb.rows) {
    const acc = r.account.padEnd(12);
    const d = formatEUR(r.debitCents).padStart(12);
    const c = formatEUR(r.creditCents).padStart(12);
    const s = signed(r.balanceCents).padStart(12);
    L.push(`${acc}${d}  ${c}  ${s}`);
  }
  L.push(`Totaux : Débit ${formatEUR(tb.totalDebitCents)} · Crédit ${formatEUR(tb.totalCreditCents)}`);
  L.push(tb.balanced ? 'Partie double équilibrée ✓' : 'Partie double NON équilibrée — à vérifier');
  L.push('');

  L.push('Ce dossier est établi automatiquement par Bob Pro à partir du grand-livre réel.');
  L.push('Le fichier des écritures comptables (FEC) l’accompagne pour contrôle.');
  L.push('À faire vérifier et signer par votre expert-comptable.');

  const filename = `Dossier-cloture-${input.company.siren}-${input.period.to.replace(/-/g, '')}.txt`;
  return { filename, content: `${L.join('\n')}\n` };
}
