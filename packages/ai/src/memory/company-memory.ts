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

// ── ASK-3 : la catégorie ambiguë au scan ──────────────────────────────────────────────

/** Impact comptable sobre de chaque catégorie — la ligne secondaire de l'option. */
const CATEGORY_INFO: Record<ExpenseCategory, { label: string; description: string }> = {
  fournitures: { label: 'Fournitures', description: 'Consommées sur le chantier — compte 606, TVA récupérable si mentionnée.' },
  materiel: { label: 'Matériel', description: 'Équipement et outillage — compte 606.' },
  carburant: { label: 'Carburant', description: 'Véhicule professionnel — compte 606.' },
  repas: { label: 'Repas', description: 'Frais de repas — compte 625, déductible sous conditions.' },
  sous_traitance: { label: 'Sous-traitance', description: 'Travaux confiés à un autre pro — compte 611, pèse sur ta marge.' },
  autre: { label: 'Autre', description: 'Charge générale — compte 606.' },
};

/** Confusions plausibles : les alternatives proposées à côté de la devinette. */
const CATEGORY_NEIGHBORS: Record<ExpenseCategory, readonly ExpenseCategory[]> = {
  fournitures: ['materiel'],
  materiel: ['fournitures'],
  carburant: ['fournitures'],
  repas: [],
  sous_traitance: ['materiel'],
  autre: ['fournitures', 'materiel', 'sous_traitance'],
};

/** Seuil de confiance OCR au-dessous duquel la devinette mérite une question. */
const CATEGORY_CONFIDENT = 0.75;

export interface CategoryClarificationOption {
  readonly value: ExpenseCategory;
  readonly label: string;
  readonly description: string;
}

export interface CategoryClarification {
  readonly question: string;
  readonly header: string;
  readonly options: readonly CategoryClarificationOption[];
}

/**
 * La question de catégorie (ASK-3) — posée SEULEMENT quand la décision est réelle :
 * · l'habitude fournisseur (source 'memory') PRIME : jamais de question sur un fournisseur
 *   déjà classé — ton historique vaut mieux qu'une devinette ;
 * · OCR confiant ET devinette ≠ « autre » : silence (une question inutile use la confiance) ;
 * · OCR hésitant OU devinette « autre » (l'OCR avoue ne pas savoir) : question à 2-4 options,
 *   la devinette d'abord, puis les confusions plausibles, « autre » toujours joignable.
 * Le choix nourrit la mémoire fournisseur au premier enregistrement — la question ne se
 * reposera pas pour ce fournisseur.
 */
export function suggestCategoryClarification(
  defaults: ExpenseDefaults,
  ocr: { confidence: number },
): CategoryClarification | null {
  if (defaults.source === 'memory') return null;
  const guess = defaults.category;
  if (ocr.confidence >= CATEGORY_CONFIDENT && guess !== 'autre') return null;

  const seen = new Set<ExpenseCategory>();
  const ordered = [guess, ...CATEGORY_NEIGHBORS[guess], 'autre' as ExpenseCategory]
    .filter((c) => (seen.has(c) ? false : (seen.add(c), true)))
    .slice(0, 4);
  return {
    question: `C'est quelle catégorie de dépense${defaults.supplierName ? ` chez ${defaults.supplierName}` : ''} ?`,
    header: 'Dépense',
    options: ordered.map((c) => ({ value: c, label: CATEGORY_INFO[c].label, description: CATEGORY_INFO[c].description })),
  };
}

