import { type Trade } from './company';

export interface TradeProfile {
  trade: Trade;
  label: string;
  /** Modules/vocabulaire adaptés au métier (onboarding adaptatif). */
  modules: string[];
}

/** Onboarding adaptatif : le métier change le vocabulaire et les modules mis en avant. */
export const TRADE_PROFILES: Record<Trade, TradeProfile> = {
  plombier: { trade: 'plombier', label: 'Plombier', modules: ['Chantiers', 'Acomptes', 'Photos', 'TVA travaux 10 %', 'Retenue de garantie'] },
  electricien: { trade: 'electricien', label: 'Électricien', modules: ['Chantiers', 'Devis', 'TVA travaux', 'Décennale'] },
  macon: { trade: 'macon', label: 'Maçon', modules: ['Chantiers', 'Situations de travaux', 'Retenue de garantie', 'Décennale'] },
  peintre: { trade: 'peintre', label: 'Peintre', modules: ['Chantiers', 'TVA travaux', 'Photos avant/après'] },
  paysagiste: { trade: 'paysagiste', label: 'Paysagiste', modules: ['Chantiers', 'Entretien récurrent', 'TVA travaux'] },
  consultant: { trade: 'consultant', label: 'Consultant', modules: ['Missions', 'TJM', 'Compte rendu d’activité (CRA)', 'Frais refacturés'] },
  photographe: { trade: 'photographe', label: 'Photographe', modules: ['Prestations', 'Cession de droits', 'Acomptes'] },
  coach: { trade: 'coach', label: 'Coach', modules: ['Séances', 'Forfaits', 'Abonnements'] },
  autre: { trade: 'autre', label: 'Autre', modules: ['Devis', 'Factures', 'Trésorerie'] },
};
