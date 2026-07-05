/**
 * Bilan simplifié (BILAN-1) — le document que l'expert-comptable associé SIGNE (vision
 * produit « le cercle »). Use case pur ; classement compte PCG → poste conçu et VÉRIFIÉ
 * adversarialement (workflow wf_1c2a2fb3-1c3). Complète la balance générale et le compte
 * de résultat pour former les états de synthèse.
 *
 * Deux régimes de classement (issus de la vérification) :
 * · CÔTÉ FIXE PAR PRÉFIXE (classes 1, 2, 3) : la classe donne le côté, jamais le signe.
 *   Classe 2 → actif (immobilisations NETTES : les amortissements 28xx, contra-actifs de
 *   solde créditeur, réduisent l'actif via la somme signée). Classe 3 → actif (stocks).
 *   Classe 1 → passif (10/12 capitaux propres, 15 provisions, 16 emprunts).
 * · PAR SIGNE (classes 4 et 5, comptes MIXTES) : un compte de tiers/financier va à l'ACTIF
 *   s'il est débiteur (411 créance client, 44 crédit de TVA, 512 banque), au PASSIF s'il est
 *   créditeur (401 dette fournisseur, 44551 TVA à décaisser, 512 découvert). Chaque compte
 *   est classé par le signe de SON solde net.
 *
 * AFFECTATION DU RÉSULTAT : le grand-livre n'est pas clôturé (classes 6/7 ouvertes, 120/129
 * vides). Le résultat net (produits − charges) est calculé et ajouté aux CAPITAUX PROPRES
 * au passif — sans quoi l'actif ne balancerait pas le passif.
 *
 * INVARIANT prouvé : actif = passif. La balance étant équilibrée (Σ débits = Σ crédits sur
 * TOUS les comptes, 6/7 comprises), la somme signée de toutes les classes est nulle ; en
 * isolant le résultat des classes 6/7 dans les capitaux propres, actifTotal ≡ passifTotal.
 */

export interface BalanceSheetEntryData {
  lines: readonly { account: string; debitCents: number; creditCents: number }[];
}

export interface BalanceSheet {
  actif: {
    immobilisationsNettesCents: number;
    stocksCents: number;
    creancesCents: number;
    disponibilitesCents: number;
    totalCents: number;
  };
  passif: {
    capitauxPropresCents: number;
    /** Résultat de l'exercice (produits − charges), composante des capitaux propres. */
    resultatNetCents: number;
    provisionsCents: number;
    empruntsCents: number;
    dettesCents: number;
    decouvertCents: number;
    totalCents: number;
  };
  /** actif.total == passif.total (au centime). */
  balanced: boolean;
  /** actif − passif : 0 si équilibré (diagnostic si jamais un compte échappe au classement). */
  ecartCents: number;
}

export function deriveBalanceSheet(entries: readonly BalanceSheetEntryData[]): BalanceSheet {
  // Solde signé par compte (débit − crédit) d'abord, puis classement.
  const balanceByAccount = new Map<string, number>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      balanceByAccount.set(line.account, (balanceByAccount.get(line.account) ?? 0) + line.debitCents - line.creditCents);
    }
  }

  let immobilisationsNettes = 0;
  let stocks = 0;
  let creances = 0;
  let disponibilites = 0;
  let capitauxPropres = 0;
  let provisions = 0;
  let emprunts = 0;
  let dettes = 0;
  let decouvert = 0;
  let resultatNet = 0;

  for (const [account, b] of balanceByAccount) {
    if (account.startsWith('2')) {
      immobilisationsNettes += b; // 28xx (crédit) réduit l'actif net
    } else if (account.startsWith('3')) {
      stocks += b;
    } else if (account.startsWith('15')) {
      provisions += -b; // passif : créditeur → positif
    } else if (account.startsWith('16')) {
      emprunts += -b;
    } else if (account.startsWith('1')) {
      capitauxPropres += -b; // 10/12 (108 débiteur, 129 perte réduisent)
    } else if (account.startsWith('4') || account.startsWith('5')) {
      // MIXTE : le signe décide du côté.
      const isTreasury = account.startsWith('5');
      if (b > 0) {
        if (isTreasury) disponibilites += b;
        else creances += b;
      } else if (b < 0) {
        if (isTreasury) decouvert += -b;
        else dettes += -b;
      }
    } else if (account.startsWith('6') || account.startsWith('7')) {
      // Résultat de l'exercice = produits − charges = −Σ(débit−crédit) des classes 6 et 7.
      resultatNet += -b;
    }
    // Autres classes (8, 9 hors résultat…) : hors bilan simplifié.
  }

  const actifTotal = immobilisationsNettes + stocks + creances + disponibilites;
  const passifTotal = capitauxPropres + resultatNet + provisions + emprunts + dettes + decouvert;

  return {
    actif: {
      immobilisationsNettesCents: immobilisationsNettes,
      stocksCents: stocks,
      creancesCents: creances,
      disponibilitesCents: disponibilites,
      totalCents: actifTotal,
    },
    passif: {
      capitauxPropresCents: capitauxPropres,
      resultatNetCents: resultatNet,
      provisionsCents: provisions,
      empruntsCents: emprunts,
      dettesCents: dettes,
      decouvertCents: decouvert,
      totalCents: passifTotal,
    },
    balanced: actifTotal === passifTotal,
    ecartCents: actifTotal - passifTotal,
  };
}
