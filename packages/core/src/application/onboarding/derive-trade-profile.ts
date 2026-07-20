import { type Trade } from '../../domain/company/company';
import { TRADE_PROFILES } from '../../domain/company/trade-profile';

/**
 * Onboarding adaptatif (claim C22) — dérivation PURE métier → espace personnalisé.
 *
 * Le choix du métier ADAPTE le vocabulaire de l'app (proto dc.html §onb2/§onb4) :
 * · `preview` = chips « Ton espace inclura » — libellés EXACTS du proto (`onbPreview`),
 *   même partition : les 5 métiers du bâtiment partagent la liste chantier, les
 *   métiers de services ont chacun la leur ;
 * · `highlights` = repères de conformité/vocabulaire PROPRES au métier (décennale,
 *   Consuel, retenue de garantie, TVA travaux, cession de droits, CRA) — ids typés,
 *   la copy vit dans @bob/i18n côté écrans ;
 * · `spaceLabel` = « ton espace {métier} » (proto `onbMetierLabel` : autre → « pro »,
 *   sinon libellé en minuscules).
 *
 * Zéro duplication de source : tout est dérivé de TRADE_PROFILES (modules, vocabulaire).
 * L'appartenance bâtiment = présence du module `chantiers`,
 * strictement équivalente au set BTP du domaine company (les 5 mêmes métiers) — testé.
 */

/** Repères adaptatifs par métier — la copy (×3 humeurs) est portée par @bob/i18n. */
export type TradeHighlightId =
  | 'decennale' // assurance décennale — métiers du bâtiment
  | 'consuel' // attestation de conformité électrique — électricien
  | 'retenue_garantie' // retenue de garantie 5 % — module métier
  | 'tva_travaux' // TVA travaux à choisir selon l'éligibilité du chantier
  | 'cession_droits' // cession de droits — photographe
  | 'cra'; // compte rendu d'activité — consultant

export interface TradeSpacePreview {
  trade: Trade;
  /** « ton espace {métier} » — proto : autre → 'pro', sinon label en minuscules. */
  spaceLabel: string;
  /** Chips du preview « Ton espace inclura » — libellés proto EXACTS (§onbPreview). */
  preview: readonly string[];
  /** Repères de vocabulaire/conformité propres au métier (ordre = pertinence). */
  highlights: readonly TradeHighlightId[];
  /** Vocabulaire de l'app (Chantier / Mission / Prestation / Séance / Projet). */
  vocabulary: { customer: string; project: string };
}

/** Libellés proto EXACTS (dc.html `onbPreview`) — les 5 métiers bâtiment partagent la liste. */
const BTP_PREVIEW = [
  'Chantiers',
  'Acomptes',
  'Photos avant/après',
  'TVA travaux',
  'Retenue de garantie',
] as const;

const PREVIEW: Record<Trade, readonly string[]> = {
  plombier: BTP_PREVIEW,
  electricien: BTP_PREVIEW,
  macon: BTP_PREVIEW,
  peintre: BTP_PREVIEW,
  paysagiste: BTP_PREVIEW,
  consultant: ['Missions', 'TJM', 'CRA', 'Frais refacturés', 'Acompte'],
  freelance_it: ['Régie & TJM', 'CRA', 'Forfait projet', 'Maintenance (TMA)', 'Frais refacturés'],
  photographe: ['Prestations', 'Acompte', 'Cession de droits', 'Galeries'],
  coach: ['Séances', 'Forfaits', 'Abonnements', 'Acompte'],
  autre: ['Devis', 'Factures', 'Acomptes', 'Récurrent'],
};

export function deriveTradeProfile(trade: Trade): TradeSpacePreview {
  const p = TRADE_PROFILES[trade];
  // Bâtiment = module `chantiers` pertinent — mêmes 5 métiers que le set BTP du domaine.
  const isBtp = p.modules.includes('chantiers');

  const highlights: TradeHighlightId[] = [];
  if (isBtp) highlights.push('decennale');
  if (trade === 'electricien') highlights.push('consuel');
  if (p.modules.includes('retenue_garantie')) highlights.push('retenue_garantie');
  if (isBtp) highlights.push('tva_travaux');
  if (p.modules.includes('cession_droits')) highlights.push('cession_droits');
  if (p.modules.includes('cra')) highlights.push('cra');

  return {
    trade,
    spaceLabel: trade === 'autre' ? 'pro' : p.label.toLowerCase(),
    preview: PREVIEW[trade],
    highlights,
    vocabulary: { ...p.vocabulary },
  };
}
