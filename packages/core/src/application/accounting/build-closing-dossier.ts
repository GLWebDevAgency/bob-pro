import { formatEUR } from '../../format/money';
import { type DateOnly } from '../../shared-kernel/time';
import { deriveTrialBalance } from './derive-trial-balance';
import { deriveIncomeStatement } from './derive-income-statement';
import { deriveBalanceSheet } from './derive-balance-sheet';

/**
 * Dossier de clôture (DOSSIER-1) — la NOTE DE SYNTHÈSE lisible que l'artisan envoie à son
 * expert-comptable pour signature (vision « le cercle »). Assemble en un document texte les
 * TROIS états de synthèse déjà dérivés (compte de résultat, bilan, balance générale), tous
 * cohérents entre eux par construction. Le FEC (fichier machine) l'accompagne à part.
 * Use case PUR : ni I/O, ni date système (generatedOn injecté).
 */

export interface ClosingDossierInput {
  company: { name: string; siren: string };
  period: { from: DateOnly; to: DateOnly };
  /** Date d'établissement du dossier (injectée — le domaine ne lit jamais l'horloge). */
  generatedOn: DateOnly;
  entries: readonly { lines: readonly { account: string; debitCents: number; creditCents: number }[] }[];
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

export function buildClosingDossier(input: ClosingDossierInput): ClosingDossier {
  const tb = deriveTrialBalance(input.entries);
  const is = deriveIncomeStatement(input.entries);
  const bs = deriveBalanceSheet(input.entries);

  const L: string[] = [];
  L.push('DOSSIER DE CLÔTURE');
  L.push(`${input.company.name} — SIREN ${input.company.siren}`);
  L.push(`Période du ${input.period.from} au ${input.period.to}`);
  L.push(`Établi le ${input.generatedOn} par Bob Pro`);
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
