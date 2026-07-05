/**
 * Soldes intermédiaires de gestion (BA-2) — la lecture GESTIONNAIRE de l'exploitation :
 * là où le compte de résultat répond « combien ? », les SIG répondent « d'où ça vient ? »
 * (marge sur matériaux → production → valeur ajoutée → EBE → résultat d'exploitation).
 * Use case pur ; mapping conçu et VÉRIFIÉ adversarialement (workflow wf_02776c87-fe3,
 * panel expert-comptable + contrôleur fiscal), même mécanique que deriveIncomeStatement :
 * cumul du solde signé PAR COMPTE puis ventilation au PLUS-LONG-PRÉFIXE, convention
 * produit = −balance / charge = +balance (RRR à contre-sens et déstockage absorbés).
 *
 * Règles cardinales issues de la vérification :
 * · MAPPING TOTAL SUR LES PRÉFIXES PCG, pas sur les comptes seedés : 709/6037/71/74…
 *   absents du plan opérationnel aujourd'hui pèsent zéro, et l'import ANC les rendra
 *   postables sans retouche du moteur.
 * · PARTITION EXACTE du périmètre exploitation du compte de résultat : chaque préfixe SIG
 *   est un sous-préfixe d'un préfixe exploitation du PREFIX_MAP (707/7097 ⊂ 70,
 *   607/6087/6097/6037 ⊂ 60) et les 786/787/796/797/686/687 restent EXCLUS par absence de
 *   préfixe englobant (78/79/68 ne figurent pas dans la table) — comme dans le CR.
 * · 781/791 au niveau du résultat d'exploitation, PAS dans l'EBE (position liasse
 *   2033/2052 : un transfert de charges peut corriger une dotation 681, située sous l'EBE).
 * · GATE MARGE : la marge sur matériaux n'a de sens que si un compte d'achats revendus
 *   {607, 6087, 6097, 6037} est mouvementé. Le cycle ventes crédite 707 (supply) mais le
 *   cycle achats débite 606 (fournitures) — sans cette gate, la « marge » vaudrait 100 %
 *   des ventes de matériaux, une fiction. Le moteur CALCULE toujours l'étage (invariant de
 *   recollement) ; le produit décide de l'AFFICHER via margeCommercialeActive.
 *
 * INVARIANT (testé) : resultatExploitationCents == deriveIncomeStatement(entries)
 * .resultatExploitationCents, au centime, pour TOUT jeu d'écritures — la cascade SIG est
 * une PARTITION de l'exploitation, elle télescope vers le même solde.
 */

export interface SigEntryData {
  lines: readonly { account: string; debitCents: number; creditCents: number }[];
}

type SigBucket =
  | 'margeProduits'
  | 'margeCharges'
  | 'production'
  | 'consommations'
  | 'subventions'
  | 'impotsTaxes'
  | 'personnel'
  | 'autresProduits'
  | 'autresCharges';

/** Table préfixe → étage SIG (partition vérifiée du périmètre exploitation du CR). */
const SIG_PREFIX_MAP: readonly { prefix: string; bucket: SigBucket; sens: 'produit' | 'charge' }[] = [
  // Marge commerciale (négoce) : ventes de marchandises nettes de RRR, coût d'achat revendu.
  { prefix: '707', bucket: 'margeProduits', sens: 'produit' },
  { prefix: '7097', bucket: 'margeProduits', sens: 'produit' }, // RRR accordés sur marchandises (débiteur → réduit)
  { prefix: '607', bucket: 'margeCharges', sens: 'charge' },
  { prefix: '6087', bucket: 'margeCharges', sens: 'charge' },
  { prefix: '6097', bucket: 'margeCharges', sens: 'charge' }, // RRR obtenus (créditeur → réduit la charge)
  { prefix: '6037', bucket: 'margeCharges', sens: 'charge' }, // variation de stocks de marchandises (signée)
  // Production de l'exercice : 70 attrape 701-706/708/709 hors 7097 par plus-long-préfixe.
  { prefix: '70', bucket: 'production', sens: 'produit' },
  { prefix: '71', bucket: 'production', sens: 'produit' }, // production stockée (déstockage absorbé par le signe)
  { prefix: '72', bucket: 'production', sens: 'produit' },
  { prefix: '73', bucket: 'production', sens: 'produit' }, // assimilé production (2033) — garantit l'invariant
  // Consommations de l'exercice en provenance de tiers : 60 reste (601-606, 603 hors 6037,
  // 608 hors 6087, 609 hors 6097), services extérieurs 61 (dont 611 sous-traitance) et 62.
  { prefix: '60', bucket: 'consommations', sens: 'charge' },
  { prefix: '61', bucket: 'consommations', sens: 'charge' },
  { prefix: '62', bucket: 'consommations', sens: 'charge' },
  // EBE : + subventions d'exploitation − impôts et taxes − charges de personnel.
  { prefix: '74', bucket: 'subventions', sens: 'produit' },
  { prefix: '63', bucket: 'impotsTaxes', sens: 'charge' },
  { prefix: '64', bucket: 'personnel', sens: 'charge' },
  // Résultat d'exploitation : autres produits/charges de gestion, reprises et transferts
  // d'exploitation, dotations d'exploitation — 781/791/681 réservés au plus-long-préfixe
  // face à rien (78/79/68 absents de la table) : les 786/787/796/797/686/687 sont EXCLUS.
  { prefix: '75', bucket: 'autresProduits', sens: 'produit' },
  { prefix: '781', bucket: 'autresProduits', sens: 'produit' },
  { prefix: '791', bucket: 'autresProduits', sens: 'produit' },
  { prefix: '65', bucket: 'autresCharges', sens: 'charge' },
  { prefix: '681', bucket: 'autresCharges', sens: 'charge' },
];

export interface SigStatement {
  /** Ventes de marchandises nettes (707 − 7097). */
  margeCommercialeProduitsCents: number;
  /** Coût d'achat des marchandises vendues (607 + 6087 − 6097 ± 6037). */
  margeCommercialeChargesCents: number;
  margeCommercialeCents: number;
  /** Un compte d'achats revendus {607, 6087, 6097, 6037} est mouvementé — sans lui, la
   *  « marge » serait fictive (ventes 707 sans coût d'achat en face) : le produit masque. */
  margeCommercialeActive: boolean;
  /** Production de l'exercice (70 hors 707/7097, 71, 72, 73). */
  productionCents: number;
  /** Consommations de l'exercice en provenance de tiers (60 hors périmètre marge, 61, 62). */
  consommationsCents: number;
  /** Valeur ajoutée = marge commerciale + production − consommations. */
  valeurAjouteeCents: number;
  /** Subventions d'exploitation (74). */
  subventionsCents: number;
  /** Impôts, taxes et versements assimilés (63). */
  impotsTaxesCents: number;
  /** Charges de personnel (64) — 0 chez l'indépendant sans salarié. */
  chargesPersonnelCents: number;
  /** EBE = VA + subventions − impôts et taxes − personnel. */
  ebeCents: number;
  /** Autres produits d'exploitation (75 + 781 + 791). */
  autresProduitsExploitationCents: number;
  /** Autres charges d'exploitation (65 + 681). */
  autresChargesExploitationCents: number;
  /** INVARIANT = deriveIncomeStatement(entries).resultatExploitationCents. */
  resultatExploitationCents: number;
}

/** Étage SIG du compte le plus spécifique (plus long préfixe) — null hors exploitation. */
function bucketOf(account: string): { bucket: SigBucket; sens: 'produit' | 'charge' } | null {
  let best: { bucket: SigBucket; sens: 'produit' | 'charge' } | null = null;
  let bestLen = 0;
  for (const { prefix, bucket, sens } of SIG_PREFIX_MAP) {
    if (account.startsWith(prefix) && prefix.length > bestLen) {
      best = { bucket, sens };
      bestLen = prefix.length;
    }
  }
  return best;
}

export function deriveSig(entries: readonly SigEntryData[]): SigStatement {
  const totals: Record<SigBucket, number> = {
    margeProduits: 0,
    margeCharges: 0,
    production: 0,
    consommations: 0,
    subventions: 0,
    impotsTaxes: 0,
    personnel: 0,
    autresProduits: 0,
    autresCharges: 0,
  };
  let margeChargesTouched = false;

  // Cumul par compte d'abord (solde signé unique par compte), puis ventilation.
  const balanceByAccount = new Map<string, number>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      balanceByAccount.set(line.account, (balanceByAccount.get(line.account) ?? 0) + line.debitCents - line.creditCents);
      if (bucketOf(line.account)?.bucket === 'margeCharges') margeChargesTouched = true;
    }
  }

  for (const [account, balanceCents] of balanceByAccount) {
    const hit = bucketOf(account);
    if (!hit) continue; // bilan, financier, exceptionnel, 69x : hors exploitation
    totals[hit.bucket] += hit.sens === 'produit' ? -balanceCents : balanceCents;
  }

  const margeCommercialeCents = totals.margeProduits - totals.margeCharges;
  const valeurAjouteeCents = margeCommercialeCents + totals.production - totals.consommations;
  const ebeCents = valeurAjouteeCents + totals.subventions - totals.impotsTaxes - totals.personnel;
  const resultatExploitationCents = ebeCents + totals.autresProduits - totals.autresCharges;

  return {
    margeCommercialeProduitsCents: totals.margeProduits,
    margeCommercialeChargesCents: totals.margeCharges,
    margeCommercialeCents,
    margeCommercialeActive: margeChargesTouched,
    productionCents: totals.production,
    consommationsCents: totals.consommations,
    valeurAjouteeCents,
    subventionsCents: totals.subventions,
    impotsTaxesCents: totals.impotsTaxes,
    chargesPersonnelCents: totals.personnel,
    ebeCents,
    autresProduitsExploitationCents: totals.autresProduits,
    autresChargesExploitationCents: totals.autresCharges,
    resultatExploitationCents,
  };
}
