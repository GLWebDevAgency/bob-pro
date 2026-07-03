import { type Trade } from '../../domain/company/company';
import { type VatRate } from '../../domain/billing/shared/vat-rate';
import { type LineCategory } from '../../domain/billing/shared/line-item';
import { TRADE_PROFILES } from '../../domain/company/trade-profile';

/**
 * Catalogue de prestations (claim C27) — dérivation PURE métier → prestations proposées.
 *
 * Deux sources, jamais confondues :
 * · les prestations MÉTIER (source 'metier') dérivées de TRADE_PROFILES (vocabulaire C22) :
 *   libellés du terrain + PU HT INDICATIFS (fourchettes basses des marchés FR 2026, honnêtement
 *   estimées et MARQUÉES `indicative: true` — jamais présentées comme le prix de l'artisan) ;
 * · les prestations PERSONNELLES de l'artisan (source 'perso', `indicative: false`) — SES prix.
 *
 * TVA suggérée par les règles existantes : le taux par défaut du métier (TRADE_PROFILES —
 * 10 % travaux logement > 2 ans pour les 5 métiers du bâtiment, 20 % services), REVALIDÉ à la
 * génération par CreateQuote via suggestVatRate (franchise 293 B / autoliquidation ⇒ 0 imposé).
 * Le catalogue SUGGÈRE, le use case de facturation JUGE — rien n'est dupliqué ici.
 *
 * Fusion (« Bob garde tes prix ») : une prestation perso dont le libellé normalisé égale celui
 * d'une suggestion métier la REMPLACE — l'artisan a fait sienne la prestation, son prix fait foi.
 */

/** Catégories du catalogue (contrat C27) — sous-ensemble facturable des LineCategory. */
export type CatalogueCategory = Extract<LineCategory, 'labor' | 'supply' | 'travel'>;

export const CATALOGUE_CATEGORIES: readonly CatalogueCategory[] = ['labor', 'supply', 'travel'];

export function isCatalogueCategory(value: unknown): value is CatalogueCategory {
  return (CATALOGUE_CATEGORIES as readonly unknown[]).includes(value);
}

export type CatalogueSource = 'metier' | 'perso';

/** Prestation personnelle de l'artisan — persistée côté app (aucun endpoint serveur, C27). */
export interface CustomPrestation {
  readonly id: string;
  readonly label: string;
  readonly category: CatalogueCategory;
  /** Unité affichée (« 1 h », « m² », « forfait ») — null si sans objet. */
  readonly unit: string | null;
  /** Prix unitaire HT en centimes — le prix de l'artisan, jamais un indicatif. */
  readonly unitPriceHT: number;
  readonly vatRate: VatRate;
}

export interface CataloguePrestation {
  readonly id: string;
  readonly label: string;
  readonly category: CatalogueCategory;
  readonly unit: string | null;
  /** Prix unitaire HT en centimes. */
  readonly unitPriceHT: number;
  /** TVA suggérée (défaut métier TRADE_PROFILES) — CreateQuote revalide à la génération. */
  readonly vatRate: VatRate;
  readonly source: CatalogueSource;
  /** true = PU indicatif marché FR (suggestion métier) — jamais un prix de l'artisan. */
  readonly indicative: boolean;
}

interface SuggestedEntry {
  readonly label: string;
  readonly category: CatalogueCategory;
  readonly unit?: string;
  /** PU HT indicatif en centimes — fourchette basse honnête, marchés FR 2026. */
  readonly unitPriceHT: number;
}

/**
 * Prestations métier — table typée, UNE entrée par geste courant du métier (proto §catalogue
 * pour le plombier, prolongé aux autres métiers de TRADE_PROFILES). Prix HT indicatifs.
 */
const SUGGESTED: Record<Trade, readonly SuggestedEntry[]> = {
  plombier: [
    { label: "Main-d'œuvre plomberie", category: 'labor', unit: '1 h', unitPriceHT: 5500 },
    { label: 'Pose & raccordement', category: 'labor', unit: '1 j', unitPriceHT: 42000 },
    { label: 'Recherche de fuite', category: 'labor', unit: 'forfait', unitPriceHT: 12000 },
    { label: 'Débouchage canalisation', category: 'labor', unit: 'forfait', unitPriceHT: 15000 },
    { label: 'Entretien chaudière', category: 'labor', unit: 'forfait', unitPriceHT: 13000 },
    { label: 'Dépose ancien équipement', category: 'labor', unitPriceHT: 8000 },
    { label: 'Chauffe-eau 200 L', category: 'supply', unitPriceHT: 89000 },
    { label: 'Mitigeur cuisine', category: 'supply', unitPriceHT: 8500 },
    { label: 'Mitigeur thermostatique douche', category: 'supply', unitPriceHT: 14500 },
    { label: 'WC suspendu complet', category: 'supply', unitPriceHT: 32000 },
    { label: "Robinet d'arrêt", category: 'supply', unitPriceHT: 1800 },
    { label: 'Déplacement zone locale', category: 'travel', unitPriceHT: 4500 },
    { label: 'Déplacement longue distance', category: 'travel', unit: '> 30 km', unitPriceHT: 7500 },
  ],
  electricien: [
    { label: "Main-d'œuvre électricité", category: 'labor', unit: '1 h', unitPriceHT: 5500 },
    { label: 'Remplacement tableau électrique', category: 'labor', unit: 'forfait', unitPriceHT: 95000 },
    { label: 'Mise en conformité Consuel', category: 'labor', unit: 'forfait', unitPriceHT: 19000 },
    { label: 'Recherche de panne', category: 'labor', unit: 'forfait', unitPriceHT: 11000 },
    { label: 'Pose point lumineux', category: 'labor', unitPriceHT: 9000 },
    { label: 'Pose prise ou interrupteur', category: 'labor', unitPriceHT: 6500 },
    { label: 'Tableau électrique 2 rangées', category: 'supply', unitPriceHT: 18000 },
    { label: 'Radiateur électrique 1500 W', category: 'supply', unitPriceHT: 25000 },
    { label: 'Déplacement zone locale', category: 'travel', unitPriceHT: 4500 },
    { label: 'Déplacement longue distance', category: 'travel', unit: '> 30 km', unitPriceHT: 7500 },
  ],
  macon: [
    { label: "Main-d'œuvre maçonnerie", category: 'labor', unit: '1 h', unitPriceHT: 5000 },
    { label: 'Montage mur en parpaings', category: 'labor', unit: 'm²', unitPriceHT: 9000 },
    { label: 'Chape béton', category: 'labor', unit: 'm²', unitPriceHT: 4500 },
    { label: 'Enduit de façade', category: 'labor', unit: 'm²', unitPriceHT: 5500 },
    { label: 'Démolition cloison', category: 'labor', unit: 'forfait', unitPriceHT: 60000 },
    { label: "Béton prêt à l'emploi", category: 'supply', unit: 'm³', unitPriceHT: 15000 },
    { label: 'Parpaings & mortier', category: 'supply', unit: 'm²', unitPriceHT: 3500 },
    { label: 'Déplacement & évacuation gravats', category: 'travel', unitPriceHT: 12000 },
  ],
  peintre: [
    { label: "Main-d'œuvre peinture", category: 'labor', unit: '1 h', unitPriceHT: 4500 },
    { label: 'Peinture murs & plafonds', category: 'labor', unit: 'm²', unitPriceHT: 3000 },
    { label: 'Préparation des supports', category: 'labor', unit: 'm²', unitPriceHT: 1500 },
    { label: 'Pose papier peint', category: 'labor', unit: 'm²', unitPriceHT: 2500 },
    { label: 'Peinture acrylique', category: 'supply', unit: 'pot 10 L', unitPriceHT: 7500 },
    { label: 'Enduit & bandes', category: 'supply', unitPriceHT: 4000 },
    { label: 'Déplacement zone locale', category: 'travel', unitPriceHT: 4000 },
  ],
  paysagiste: [
    { label: "Main-d'œuvre paysagiste", category: 'labor', unit: '1 h', unitPriceHT: 4500 },
    { label: 'Tonte de pelouse', category: 'labor', unit: 'forfait', unitPriceHT: 6000 },
    { label: 'Taille de haie', category: 'labor', unit: '1 h', unitPriceHT: 5500 },
    { label: 'Élagage petit arbre', category: 'labor', unit: 'forfait', unitPriceHT: 25000 },
    { label: 'Création de massif', category: 'labor', unit: 'forfait', unitPriceHT: 35000 },
    { label: 'Végétaux & plants', category: 'supply', unitPriceHT: 12000 },
    { label: 'Déplacement & évacuation déchets verts', category: 'travel', unitPriceHT: 6500 },
  ],
  consultant: [
    { label: 'Journée de conseil (TJM)', category: 'labor', unit: '1 j', unitPriceHT: 60000 },
    { label: 'Demi-journée de conseil', category: 'labor', unit: '0,5 j', unitPriceHT: 35000 },
    { label: 'Atelier de cadrage', category: 'labor', unit: 'forfait', unitPriceHT: 90000 },
    { label: 'Restitution & rapport', category: 'labor', unit: 'forfait', unitPriceHT: 45000 },
    { label: 'Déplacement mission', category: 'travel', unitPriceHT: 9000 },
  ],
  photographe: [
    { label: 'Séance portrait', category: 'labor', unit: 'forfait', unitPriceHT: 25000 },
    { label: 'Reportage événement', category: 'labor', unit: '1 j', unitPriceHT: 120000 },
    { label: 'Retouche photo', category: 'labor', unit: '1 h', unitPriceHT: 6000 },
    { label: "Cession de droits d'images", category: 'labor', unit: 'forfait', unitPriceHT: 30000 },
    { label: 'Tirages & album', category: 'supply', unitPriceHT: 15000 },
    { label: 'Déplacement prestation', category: 'travel', unitPriceHT: 6000 },
  ],
  coach: [
    { label: 'Séance individuelle', category: 'labor', unit: '1 h', unitPriceHT: 7000 },
    { label: 'Bilan initial', category: 'labor', unit: 'forfait', unitPriceHT: 9000 },
    { label: 'Forfait 5 séances', category: 'labor', unit: 'forfait', unitPriceHT: 32000 },
    { label: 'Forfait 10 séances', category: 'labor', unit: 'forfait', unitPriceHT: 60000 },
    { label: 'Déplacement à domicile', category: 'travel', unitPriceHT: 2500 },
  ],
  autre: [
    { label: "Main-d'œuvre", category: 'labor', unit: '1 h', unitPriceHT: 5000 },
    { label: 'Prestation forfaitaire', category: 'labor', unit: 'forfait', unitPriceHT: 15000 },
    { label: 'Déplacement', category: 'travel', unitPriceHT: 4500 },
  ],
};

/** minuscules + sans accents (œ → oe) + ponctuation → espaces (même convention que la voix C20). */
function normalizeLabel(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/œ/gi, 'oe')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Id STABLE d'une suggestion métier (clé React, dédup) — slug du libellé, préfixé du métier. */
function suggestedId(trade: Trade, label: string): string {
  return `metier:${trade}:${normalizeLabel(label).replace(/ /g, '-')}`;
}

export interface DeriveCatalogueInput {
  trade: Trade;
  /** Prestations personnelles de l'artisan (persistance app) — prioritaires sur les suggestions. */
  custom?: readonly CustomPrestation[];
}

export interface CatalogueView {
  trade: Trade;
  /** Prestations fusionnées, ordonnées : catégorie (labor → supply → travel), perso avant métier. */
  prestations: readonly CataloguePrestation[];
}

export function deriveCatalogue(input: DeriveCatalogueInput): CatalogueView {
  const custom = input.custom ?? [];
  const vatRate = TRADE_PROFILES[input.trade].defaultVatRate;

  const perso: CataloguePrestation[] = custom.map((p) => ({
    id: p.id,
    label: p.label,
    category: p.category,
    unit: p.unit,
    unitPriceHT: p.unitPriceHT,
    vatRate: p.vatRate,
    source: 'perso',
    indicative: false,
  }));

  // « Bob garde tes prix » : une perso au même libellé (normalisé) ÉCLIPSE la suggestion métier.
  const owned = new Set(perso.map((p) => normalizeLabel(p.label)));
  const metier: CataloguePrestation[] = SUGGESTED[input.trade]
    .filter((s) => !owned.has(normalizeLabel(s.label)))
    .map((s) => ({
      id: suggestedId(input.trade, s.label),
      label: s.label,
      category: s.category,
      unit: s.unit ?? null,
      unitPriceHT: s.unitPriceHT,
      vatRate,
      source: 'metier',
      indicative: true,
    }));

  const order: Record<CatalogueCategory, number> = { labor: 0, supply: 1, travel: 2 };
  const prestations = [...perso, ...metier].sort((a, b) => {
    if (order[a.category] !== order[b.category]) return order[a.category] - order[b.category];
    if (a.source !== b.source) return a.source === 'perso' ? -1 : 1;
    return a.label.localeCompare(b.label, 'fr');
  });

  return { trade: input.trade, prestations };
}

/**
 * Recherche au fil de la saisie (écran catalogue + suggestions de l'étape lignes du devis C21) :
 * inclusion insensible à la casse et aux accents. Requête vide → tout le catalogue.
 */
export function searchCatalogue(
  prestations: readonly CataloguePrestation[],
  query: string,
): CataloguePrestation[] {
  const q = normalizeLabel(query);
  if (q === '') return [...prestations];
  return prestations.filter((p) => normalizeLabel(p.label).includes(q));
}
