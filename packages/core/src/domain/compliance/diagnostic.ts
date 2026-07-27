import { type Trade, type VatRegime, isBtpTrade } from '../company/company';
import { assessVatFranchise } from './vat-thresholds';

/** Pays couverts. France encodée ; structure prête pour l'expansion européenne/internationale. */
export type Country = 'FR' | 'BE' | 'LU' | 'DE' | 'ES' | 'IT';

export interface DiagnosticInput {
  country: Country;
  trade: Trade;
  vatRegime: VatRegime;
  customerTypes: ('b2c' | 'b2b' | 'b2g')[];
  hasDecennale: boolean;
  asOf: string; // DateOnly
  /** Recettes ENCAISSÉES de l'année civile en cours (centimes) — alimente la surveillance
   *  RÉELLE des seuils de franchise 293 B (E6). Absent → l'item reste informatif (on
   *  n'invente pas une alerte sans donnée). */
  annualEncaissedCents?: number | null;
}

export type ItemStatus = 'ok' | 'todo' | 'na';
export type ItemSeverity = 'info' | 'important' | 'critical';

export interface ComplianceItem {
  id: string;
  label: string;
  status: ItemStatus;
  severity: ItemSeverity;
  dueDate?: string;
  help: string;
}

export interface CalendarEntry {
  date: string;
  label: string;
}

export interface DiagnosticResult {
  country: Country;
  supported: boolean;
  score: number;
  band: 'green' | 'orange' | 'red';
  items: ComplianceItem[];
  calendar: CalendarEntry[];
}

const WEIGHT: Record<ItemSeverity, number> = { critical: 15, important: 8, info: 3 };

function scoreFrom(items: ComplianceItem[]): number {
  const penalty = items
    .filter((i) => i.status === 'todo')
    .reduce((sum, i) => sum + WEIGHT[i.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function band(score: number): 'green' | 'orange' | 'red' {
  return score >= 85 ? 'green' : score >= 65 ? 'orange' : 'red';
}

/** Calendrier de la réforme française de la facturation électronique. */
const FR_CALENDAR: CalendarEntry[] = [
  {
    date: '2026-09-01',
    label: 'Réception des factures électroniques obligatoire pour toutes les entreprises ; émission obligatoire pour les grandes entreprises et ETI.',
  },
  {
    date: '2027-09-01',
    label: 'Émission des factures électroniques obligatoire pour les PME et les TPE (micro-entreprises).',
  },
];

function diagnoseFrance(input: DiagnosticInput): DiagnosticResult {
  // PR-10 — SOURCE UNIQUE du domaine (isBtpTrade) : la liste dupliquée locale divergeait dès
  // l'arrivée du frigoriste (décennale/autoliquidation absentes du diagnostic à tort).
  const isBtp = isBtpTrade(input.trade);
  const hasB2g = input.customerTypes.includes('b2g');
  const hasB2c = input.customerTypes.includes('b2c');
  const hasB2b = input.customerTypes.includes('b2b');
  const items: ComplianceItem[] = [];

  items.push({
    id: 'einvoice-reception',
    label: 'Pouvoir recevoir des factures électroniques',
    status: 'todo',
    severity: 'important',
    dueDate: '2026-09-01',
    help: 'Au 1ᵉʳ septembre 2026, toutes les entreprises assujetties à la TVA doivent pouvoir recevoir leurs factures au format électronique via une plateforme.',
  });

  items.push({
    id: 'einvoice-emission',
    label: 'Émettre tes factures au format électronique',
    status: 'todo',
    severity: 'important',
    dueDate: '2027-09-01',
    help: 'En tant que TPE/PME, l’émission de factures électroniques devient obligatoire au 1ᵉʳ septembre 2027 (formats Factur-X / UBL / CII).',
  });

  items.push({
    id: 'pa',
    label: 'Choisir une Plateforme Agréée (PA)',
    status: 'todo',
    severity: 'important',
    help: 'Le e-invoicing B2B domestique passe par une Plateforme Agréée (PA) par l’administration (terme remplaçant « PDP »). Bob t’aide à en choisir une.',
  });

  if (hasB2g) {
    items.push({
      id: 'chorus-pro',
      label: 'Clients publics : transmission via Chorus Pro',
      status: 'ok',
      severity: 'info',
      help: 'La facturation électronique vers le secteur public (B2G) passe par Chorus Pro, déjà en place.',
    });
  }

  if (hasB2c) {
    items.push({
      id: 'ereporting',
      label: 'e-reporting de tes ventes aux particuliers',
      status: 'todo',
      severity: 'info',
      dueDate: '2027-09-01',
      help: 'Les ventes aux particuliers (B2C) et à l’international relèvent du e-reporting : transmission des données de transaction et de paiement.',
    });
  }

  items.push({
    id: 'mentions',
    label: 'Mentions légales obligatoires à jour',
    status: 'ok',
    severity: 'important',
    help: 'Bob génère automatiquement les mentions obligatoires (SIREN, pénalités de retard, indemnité forfaitaire de 40 €, etc.).',
  });

  items.push({
    id: 'numbering',
    label: 'Numérotation séquentielle sans trou',
    status: 'ok',
    severity: 'info',
    help: 'Bob garantit une numérotation chronologique continue, sans rupture — une obligation fiscale.',
  });

  if (input.vatRegime === 'franchise') {
    // E6 : surveillance RÉELLE des seuils 293 B quand les encaissements sont fournis —
    // artisan = prestations de services (fourniture-et-pose : la pose rend la prestation
    // prépondérante ; position documentée, seuils services 37 500 / 41 250 €).
    const revenue = input.annualEncaissedCents ?? null;
    if (revenue === null) {
      items.push({
        id: 'tva-franchise',
        label: 'Franchise en base : surveiller les seuils',
        status: 'ok',
        severity: 'info',
        help: 'Franchise en base (art. 293 B du CGI) : pas de TVA facturée, mention obligatoire. Surveille les seuils (85 000 € ventes / 37 500 € services).',
      });
    } else {
      const franchise = assessVatFranchise({ activity: 'services', annualRevenueCents: revenue });
      const base = Math.round(franchise.thresholds.baseCents / 100).toLocaleString('fr-FR');
      if (franchise.standing === 'over_majored') {
        items.push({
          id: 'tva-franchise',
          label: 'Seuil majoré de franchise DÉPASSÉ : TVA immédiate',
          status: 'todo',
          severity: 'critical',
          help: `Tes recettes encaissées dépassent le seuil majoré (41 250 €) : la TVA est due dès le jour du dépassement — chaque facture émise sans TVA depuis expose à un rappel avec pénalités. Passe au régime réel sans attendre.`,
        });
      } else if (franchise.standing === 'over_base') {
        items.push({
          id: 'tva-franchise',
          label: 'Seuil de franchise dépassé : TVA au 1er janvier',
          status: 'todo',
          severity: 'important',
          help: `Tes recettes encaissées dépassent ${base} € : la franchise tient jusqu'au 31 décembre (tolérance sous 41 250 €), puis TVA obligatoire au 1er janvier. Anticipe tes prix et ta trésorerie.`,
        });
      } else if (franchise.standing === 'approaching') {
        items.push({
          id: 'tva-franchise',
          label: `Franchise en base : ${franchise.ratioPct} % du seuil atteint`,
          status: 'todo',
          severity: 'important',
          help: `Tes recettes encaissées approchent du seuil de ${base} € (art. 293 B). Au rythme actuel, prépare la bascule TVA : devis en cours à ajuster, immatriculation au réel à anticiper.`,
        });
      } else {
        items.push({
          id: 'tva-franchise',
          label: 'Franchise en base : seuils sous contrôle',
          status: 'ok',
          severity: 'info',
          help: `Recettes encaissées à ${franchise.ratioPct} % du seuil de ${base} € (art. 293 B) — Bob surveille en continu et t'alertera à 80 %.`,
        });
      }
    }
  } else {
    items.push({
      id: 'tva-reel',
      label: 'Déclarations de TVA périodiques',
      status: 'ok',
      severity: 'info',
      help: 'Régime réel : déclarations de TVA à échéance régulière. Bob suit la TVA à reverser dans la trésorerie.',
    });
  }

  if (isBtp) {
    items.push({
      id: 'decennale',
      label: 'Assurance décennale (BTP)',
      status: input.hasDecennale ? 'ok' : 'todo',
      severity: 'critical',
      help: 'Les métiers du bâtiment doivent souscrire une assurance décennale et la mentionner sur les devis et factures.',
    });
    if (hasB2b) {
      items.push({
        id: 'autoliquidation',
        label: 'Autoliquidation de la TVA en sous-traitance BTP',
        status: 'ok',
        severity: 'info',
        help: 'En sous-traitance BTP B2B, la TVA est autoliquidée par le donneur d’ordre (mention « Autoliquidation »). Bob l’applique automatiquement.',
      });
    }
  }

  items.push({
    id: 'conservation',
    label: 'Conservation des pièces 10 ans',
    status: 'ok',
    severity: 'info',
    help: 'Les factures et pièces comptables se conservent 10 ans. Le coffre-fort de Bob les archive et les retrouve.',
  });

  const score = scoreFrom(items);
  return { country: 'FR', supported: true, score, band: band(score), items, calendar: FR_CALENDAR };
}

export function runDiagnostic(input: DiagnosticInput): DiagnosticResult {
  if (input.country === 'FR') return diagnoseFrance(input);
  return {
    country: input.country,
    supported: false,
    score: 0,
    band: 'orange',
    items: [
      {
        id: 'country-soon',
        label: 'Pays bientôt couvert',
        status: 'na',
        severity: 'info',
        help: 'Bob déploie progressivement la conformité par pays. La France est entièrement couverte ; ce pays arrive bientôt.',
      },
    ],
    calendar: [],
  };
}
