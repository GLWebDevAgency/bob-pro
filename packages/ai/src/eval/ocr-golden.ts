/**
 * #13 (excellence OCR) — jeu d'évaluation GOLDEN : pièces fournisseurs françaises annotées.
 * Sert à mesurer la précision PAR CHAMP d'un moteur d'extraction (prompt × modèle) et à
 * décider des changements de catalogue avec des faits, pas des impressions.
 * Les markdowns imitent la sortie de mistral-ocr (fidèle, bruitée comme en vrai).
 */

export interface OcrGoldenTrade {
  label: string;
  customerWord: string;
  projectWord: string;
}

export interface OcrGoldenExpected {
  /** true = la pièce DOIT être rejetée par les garde-fous (devise, multi-pièces…). */
  rejected?: boolean;
  supplierName?: string;
  documentDate?: string;
  totalTtcCents?: number;
  /** null attendu explicitement = le moteur ne doit PAS inventer de TVA. */
  vatCents?: number | null;
  categoryGuess?: string;
}

export interface OcrGoldenCase {
  name: string;
  markdown: string;
  trade?: OcrGoldenTrade;
  expected: OcrGoldenExpected;
}

const PLOMBIER: OcrGoldenTrade = {
  label: 'Plombier chauffagiste',
  customerWord: 'client',
  projectWord: 'chantier',
};

const DEV: OcrGoldenTrade = {
  label: 'Développeur / consultant',
  customerWord: 'client',
  projectWord: 'mission',
};

export const OCR_GOLDEN_CASES: readonly OcrGoldenCase[] = [
  {
    name: 'ticket-leroy-merlin-propre',
    trade: PLOMBIER,
    markdown:
      '# LEROY MERLIN\nSèvres — le 27/06/2026\n\n| Article | Prix |\n|---|---|\n| Raccord cuivre 22 | 24,90 € |\n| Flexible inox | 160,00 € |\n\nTOTAL HT 154,08 €\nTVA 20% 30,82 €\n**TOTAL TTC 184,90 €**\nCB 184,90',
    expected: {
      supplierName: 'Leroy Merlin',
      documentDate: '2026-06-27',
      totalTtcCents: 18490,
      vatCents: 3082,
      categoryGuess: 'fournitures',
    },
  },
  {
    name: 'facture-cedeo-ht-tva-ttc',
    trade: PLOMBIER,
    markdown:
      'CEDEO — Distribution sanitaire\nFacture du 20/06/2026\nRobinetterie thermostatique\nMontant HT : 285,00 €\nTVA (20 %) : 57,00 €\nNet à payer TTC : 342,00 €',
    expected: {
      supplierName: 'Cedeo',
      documentDate: '2026-06-20',
      totalTtcCents: 34200,
      vatCents: 5700,
      categoryGuess: 'materiel',
    },
  },
  {
    name: 'ticket-carburant-bruite',
    trade: PLOMBIER,
    markdown:
      'TOTALENERGIES RELAIS A86\n02/07/26 14:32  POMPE 3\nGAZOLE  42.18 L\nTOTAL TTC   79,90 EUR\ndont TVA 20%  13,32\nMERCI DE VOTRE VISITE',
    expected: {
      supplierName: 'TotalEnergies',
      documentDate: '2026-07-02',
      totalTtcCents: 7990,
      vatCents: 1332,
      categoryGuess: 'carburant',
    },
  },
  {
    name: 'note-restaurant-tva10',
    trade: PLOMBIER,
    markdown:
      'BRASSERIE DU COIN\nLe 01/07/2026 — couverts : 2\nMenu du jour x2  36,00\nCafés x2  4,40\nTOTAL TTC 40,40 €\nTVA 10% incluse : 3,67 €',
    expected: {
      supplierName: 'Brasserie du Coin',
      documentDate: '2026-07-01',
      totalTtcCents: 4040,
      vatCents: 367,
      categoryGuess: 'repas',
    },
  },
  {
    name: 'facture-cloud-metier-dev',
    trade: DEV,
    markdown:
      'OVHcloud SAS\nFacture n° FR20260630\nDate : 30/06/2026\nHébergement VPS — mission Refonte SI\nTotal HT 39,99 € — TVA 20 % 8,00 € — Total TTC 47,99 €',
    expected: {
      supplierName: 'OVHcloud',
      documentDate: '2026-06-30',
      totalTtcCents: 4799,
      vatCents: 800,
    },
  },
  {
    name: 'sous-traitance-avec-siren',
    trade: PLOMBIER,
    markdown:
      'SARL DUPONT PLOMBERIE — SIREN 732 829 320\nFacture de sous-traitance — chantier Durand\nDate : 15/06/2026\nIntervention pose PAC : 1 200,00 € HT\nTVA 20 % : 240,00 €\nTOTAL TTC : 1 440,00 €',
    expected: {
      supplierName: 'SARL Dupont Plomberie',
      documentDate: '2026-06-15',
      totalTtcCents: 144000,
      vatCents: 24000,
      categoryGuess: 'sous_traitance',
    },
  },
  {
    name: 'materiaux-milliers-espaces',
    trade: PLOMBIER,
    markdown:
      'POINT P MATERIAUX\n14/06/2026\nCarrelage + colle + profilés\nTotal H.T. 1 267,00\nT.V.A. 20,00 % : 253,40\nNET A PAYER T.T.C. 1 520,40 EUR',
    expected: {
      supplierName: 'Point P',
      documentDate: '2026-06-14',
      totalTtcCents: 152040,
      vatCents: 25340,
      categoryGuess: 'materiel',
    },
  },
  {
    name: 'auto-entrepreneur-sans-tva',
    trade: PLOMBIER,
    markdown:
      'Jean Martin — Auto-entrepreneur\nPrestation de nettoyage fin de chantier\nLe 28/06/2026\nTotal : 180,00 €\nTVA non applicable, art. 293 B du CGI',
    expected: {
      supplierName: 'Jean Martin',
      documentDate: '2026-06-28',
      totalTtcCents: 18000,
      vatCents: null,
    },
  },
  {
    name: 'facture-avec-remise',
    trade: PLOMBIER,
    markdown:
      'REXEL FRANCE\nFacture du 25/06/2026\nFournitures électriques : 500,00 € HT\nRemise commerciale −10 % : −50,00 €\nBase HT : 450,00 €\nTVA 20 % : 90,00 €\nNET À PAYER TTC : 540,00 €',
    expected: {
      supplierName: 'Rexel',
      documentDate: '2026-06-25',
      totalTtcCents: 54000,
      vatCents: 9000,
    },
  },
  {
    name: 'devise-usd-doit-etre-rejetee',
    trade: DEV,
    markdown:
      'GITHUB, INC.\nInvoice date: 2026-06-30\nGitHub Team subscription\nTotal: $48.00 USD',
    expected: { rejected: true },
  },
];
