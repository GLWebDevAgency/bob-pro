import { type Company } from '../company/company';
import { type Customer } from '../customer/customer';
import { type LineCategory } from '../billing/shared/line-item';
import { type VatRate } from '../billing/shared/vat-rate';

export type OperationNature = 'biens' | 'services' | 'mixte';

const NATURE_LABEL: Record<OperationNature, string> = {
  biens: 'Livraison de biens',
  services: 'Prestation de services',
  mixte: 'Opérations mixtes (livraison de biens et prestation de services)',
};

/** Nature des opérations à partir des catégories de lignes (mention obligatoire réforme 2026/2027). */
export function operationNatureOf(lines: readonly { category: LineCategory }[]): OperationNature {
  // Les débours (remboursement de frais avancés, hors base TVA) ne pilotent ni « biens » ni « services ».
  const taxable = lines.filter((l) => l.category !== 'disbursement');
  const hasBiens = taxable.some((l) => l.category === 'supply');
  const hasServices = taxable.some((l) => l.category !== 'supply');
  return hasBiens && hasServices ? 'mixte' : hasBiens ? 'biens' : 'services';
}

/**
 * Éligibilité aux taux réduits travaux (P11) — les MÊMES booléens que suggestVatRate
 * (context.housingOlderThan2y / context.energyRenovation), déjà saisis à la création de la pièce.
 */
export interface ReducedVatEligibility {
  /** Immeuble achevé depuis plus de deux ans, affecté à l'habitation (justifie le 10 %, art. 279-0 bis CGI). */
  housingOlderThan2y: boolean;
  /** Travaux de rénovation énergétique (justifie le 5,5 %, art. 278-0 bis A CGI). */
  energyRenovation: boolean;
}

export interface BuildMentionsInput {
  company: Company;
  customer: Customer;
  kind: 'quote' | 'invoice';
  asOf: string;
  validUntilDays?: number;
  /** Nature des opérations (obligatoire sur facture dès la réforme). */
  operationNature?: OperationNature;
  /**
   * Taux de TVA portés par les lignes de la pièce — déclenchent la mention certifiée taux réduits
   * (P11, art. 41 LF 2025 : remplace l'attestation Cerfa depuis le 16/2/2025).
   */
  lineVatRates?: readonly VatRate[];
  /**
   * Booléens d'éligibilité quand ils sont CONNUS au point d'appel : ils gatent la mention.
   * Omis (ex. émission de facture — le contexte de création n'est pas persisté) : une ligne à taux
   * réduit vaut éligibilité actée, car suggestVatRate est le seul chemin d'attribution d'un taux
   * réduit (10 % via housingOlderThan2y, 5,5 % via energyRenovation, ou choix explicite équivalent)
   * — et NE PAS imprimer la mention ferait perdre le taux réduit en contrôle (l'objet même de P11).
   */
  reducedVatEligibility?: ReducedVatEligibility;
}

export function buildMentions(input: BuildMentionsInput): string[] {
  const { company, customer, kind } = input;
  const m: string[] = [];
  m.push(`${company.name} — ${company.address.line1}, ${company.address.zip} ${company.address.city}`);
  if (company.rcsOrRm) m.push(company.rcsOrRm);

  // Réforme 2026/2027 : le SIREN du client (assujetti) devient une mention obligatoire en B2B/B2G.
  if (customer.type !== 'b2c' && customer.siren) m.push(`Client — SIREN ${customer.siren}`);
  // Nature des opérations (livraison de biens / prestation de services) — obligatoire sur facture.
  if (kind === 'invoice' && input.operationNature) m.push(`Nature de l'opération : ${NATURE_LABEL[input.operationNature]}`);

  if (company.isVatFranchise()) {
    // Réforme : à compter du 1er sept. 2026, la franchise en base relève du CIBS (Code des impositions
    // sur les biens et services) ; mention « art. 293 B du CGI » tolérée jusqu'au 31/12/2027.
    // NB : l'article CIBS exact est à confirmer sur le décret définitif avant mise en prod.
    const cibs = input.asOf >= '2026-09-01';
    m.push(cibs ? 'TVA non applicable — franchise en base (CIBS)' : 'TVA non applicable, art. 293 B du CGI');
  }
  if (company.requiresAutoliquidation({ type: customer.type, isSubcontractingBtp: customer.isSubcontractingBtp })) {
    m.push('Autoliquidation de la TVA (sous-traitance BTP, art. 283-2 nonies du CGI)');
  }

  // P11 — mention certifiée taux réduits travaux (art. 41, loi 2025-127 : remplace l'attestation
  // Cerfa depuis le 16/2/2025 ; BOI-TVA-LIQ-30-20-90-40). La signature « Bon pour accord » du devis
  // vaut certification PAR LE PRENEUR (c'est lui qu'elle engage) ; reprise sur la facture.
  // 10 % = art. 279-0 bis CGI ; 5,5 % rénovation énergétique = art. 278-0 bis A CGI.
  const rates = new Set<VatRate>(input.lineVatRates ?? []);
  const eligibility = input.reducedVatEligibility;
  if (rates.has(10) && (eligibility?.housingOlderThan2y ?? true)) {
    m.push(
      "Taux réduit de TVA 10 % — le client atteste que les travaux portent sur des locaux d'habitation achevés depuis plus de deux ans et qu'ils ne conduisent pas, sur une période de deux ans, à une surélévation du bâtiment ni à la production d'un immeuble neuf (art. 279-0 bis du CGI).",
    );
  }
  if (rates.has(5.5) && (eligibility?.energyRenovation ?? true)) {
    m.push(
      "Taux réduit de TVA 5,5 % — le client atteste que les travaux de rénovation énergétique portent sur des locaux d'habitation achevés depuis plus de deux ans et qu'ils ne conduisent pas, sur une période de deux ans, à une surélévation du bâtiment ni à la production d'un immeuble neuf (art. 278-0 bis A du CGI).",
    );
  }

  // P14 — mentions L441-9/L441-10 : ventes entre PROFESSIONNELS uniquement (le régime consommateur
  // est différent : rien de tout cela ne s'imprime pour un particulier). Escompte : mention
  // OBLIGATOIRE (L441-9) — aucun champ taux d'escompte au modèle, défaut légal « néant ».
  // Pénalités : la stipulation « taux légal » était IRRÉGULIÈRE (plancher L441-10 II = 3× le taux
  // légal) → on stipule le défaut légal BCE + 10 points, JAMAIS de taux chiffré en dur (il change
  // chaque semestre). B2G : régime propre du code de la commande publique (BCE + 8 points).
  if (customer.isProfessional()) {
    m.push('Escompte pour paiement anticipé : néant.');
    m.push(
      customer.type === 'b2g'
        ? 'Intérêts moratoires : taux BCE + 8 points. Indemnité forfaitaire de recouvrement : 40 € (art. L2192-12 et L2192-13 du code de la commande publique).'
        : 'Pénalités de retard : taux BCE + 10 points (art. L441-10 du code de commerce). Indemnité forfaitaire de recouvrement : 40 € (art. D441-5 du code de commerce).',
    );
  }

  if (company.isBtp() && company.decennale) {
    const d = company.decennale;
    m.push(`Assurance decennale : ${d.insurer}, police n°${d.policyNo}, couverture ${d.coverage}.`);
  }

  // À COMPLÉTER (réforme) quand les champs existeront au modèle : adresse de livraison si distincte de
  // la facturation, et option « TVA sur les débits » si l'entreprise l'a exercée. Conservation légale
  // des factures émises/reçues = 10 ans (règle d'archivage, hors mention imprimée).

  if (kind === 'quote') {
    m.push('Devis gratuit.');
    if (input.validUntilDays) m.push(`Devis valable ${input.validUntilDays} jours.`);
    m.push('Bon pour accord (date + signature) :');
  }
  return m;
}
