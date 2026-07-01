import { type ExpenseCategory, type OcrExtraction } from '@bob/core';

/**
 * Mémoire d'entreprise — connaissances propres à la société, apprises sur les actions VALIDÉES par
 * l'utilisateur (jamais devinées). Elle sert à proposer des valeurs par défaut intelligentes (fournisseur
 * récurrent, catégorie habituelle, TVA) plutôt que de tout redemander. Invariant : la mémoire ne produit
 * que des DÉFAUTS confirmables — elle n'exécute rien et n'invente rien (cf. plancher de sécurité de Bob).
 */

/** Normalise un nom de fournisseur pour la comparaison : casse, diacritiques, ponctuation, espaces. */
export function normalizeSupplierName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // retire les accents (diacritiques combinants)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Profil appris d'un fournisseur récurrent. */
export interface SupplierProfile {
  /** Nom normalisé (clé de rapprochement). */
  readonly key: string;
  /** Dernier libellé lisible rencontré. */
  readonly displayName: string;
  readonly siren: string | null;
  readonly category: ExpenseCategory;
  readonly vatRatePct: number | null;
  /** Nombre d'occurrences validées — mesure de confiance. */
  readonly seen: number;
}

export interface RememberSupplierInput {
  readonly name: string;
  readonly siren?: string | null;
  readonly category: ExpenseCategory;
  readonly vatRatePct?: number | null;
}

/** Port de la mémoire d'entreprise (un adapter durable multi-tenant viendra côté domaine/Prisma). */
export interface CompanyMemoryPort {
  /** Profil d'un fournisseur si connu (comparaison sur nom normalisé), sinon null. */
  supplierProfile(name: string): SupplierProfile | null;
  /** Mémorise/actualise un fournisseur à partir d'une dépense validée ; renvoie le profil à jour. */
  rememberSupplier(input: RememberSupplierInput): SupplierProfile;
  /** Libellés des fournisseurs connus (pour enrichir le contexte du classifieur, minimisé). */
  knownSupplierNames(): string[];
}

/** Implémentation en mémoire, déterministe — V1 démo, remplaçable par un adapter persistant. */
export class InMemoryCompanyMemory implements CompanyMemoryPort {
  private readonly suppliers = new Map<string, SupplierProfile>();

  constructor(seed: readonly RememberSupplierInput[] = []) {
    for (const s of seed) this.rememberSupplier(s);
  }

  supplierProfile(name: string): SupplierProfile | null {
    const key = normalizeSupplierName(name);
    return key ? this.suppliers.get(key) ?? null : null;
  }

  rememberSupplier(input: RememberSupplierInput): SupplierProfile {
    const key = normalizeSupplierName(input.name);
    const prev = this.suppliers.get(key);
    const profile: SupplierProfile = {
      key,
      displayName: input.name.trim() || prev?.displayName || input.name,
      siren: input.siren ?? prev?.siren ?? null,
      category: input.category,
      vatRatePct: input.vatRatePct ?? prev?.vatRatePct ?? null,
      seen: (prev?.seen ?? 0) + 1,
    };
    this.suppliers.set(key, profile);
    return profile;
  }

  knownSupplierNames(): string[] {
    return [...this.suppliers.values()].map((s) => s.displayName);
  }
}

/** Défauts proposés pour une dépense (toujours confirmables ; jamais postés automatiquement). */
export interface ExpenseDefaults {
  readonly supplierName: string;
  readonly supplierSiren: string | null;
  readonly category: ExpenseCategory;
  readonly vatRatePct: number | null;
  /** 'memory' = catégorie issue de ton historique ; 'ocr' = devinette OCR (rien inventé). */
  readonly source: 'memory' | 'ocr';
}

/** Champs de l'extraction OCR nécessaires à la suggestion (sous-ensemble structurel d'OcrExtraction). */
export type OcrDefaultsInput = Pick<OcrExtraction, 'supplierName' | 'supplierSiren' | 'vatRatePctApplied' | 'categoryGuess'>;

/**
 * Propose des valeurs par défaut pour une dépense à partir de l'extraction OCR ET de la mémoire. PUR.
 * Un fournisseur connu PRIME pour la catégorie (ton habitude validée > devinette générique de l'OCR) ;
 * sinon on retombe sur la devinette OCR. Le SIREN et la TVA de l'OCR priment s'ils sont présents (données
 * de la pièce réelle), complétés par la mémoire sinon. Aucune valeur n'est inventée.
 */
export function suggestExpenseDefaults(memory: CompanyMemoryPort, ocr: OcrDefaultsInput): ExpenseDefaults {
  const known = memory.supplierProfile(ocr.supplierName);
  if (known) {
    return {
      supplierName: known.displayName || ocr.supplierName,
      supplierSiren: ocr.supplierSiren ?? known.siren,
      category: known.category,
      vatRatePct: ocr.vatRatePctApplied ?? known.vatRatePct,
      source: 'memory',
    };
  }
  return {
    supplierName: ocr.supplierName,
    supplierSiren: ocr.supplierSiren,
    category: ocr.categoryGuess,
    vatRatePct: ocr.vatRatePctApplied,
    source: 'ocr',
  };
}
