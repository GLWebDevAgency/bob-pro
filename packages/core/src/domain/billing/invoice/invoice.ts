import { AggregateRoot } from '../../../shared-kernel/aggregate';
import { type DomainResult, ok, err } from '../../../shared-kernel/result';
import { type Instant, type DateOnly, isValidDateOnly } from '../../../shared-kernel/time';
import { hasBillingControlCharacter } from '../shared/line-item';
import { Percentage } from '../../../shared-kernel/percentage';
import { type PaymentTerms } from '../../../shared-kernel/payment-terms';
import { DocNumber } from '../shared/doc-number';
import { type QuoteLine } from '../shared/line';
import { type Totals } from '../shared/totals';
import {
  type PurchaseOrderRef,
  purchaseOrderRefEquals,
  clonePurchaseOrderRef,
} from '../shared/purchase-order-ref';
import {
  type Discount,
  cloneDiscount,
  validateDiscount,
  validateLineDiscount,
} from '../shared/discount';
import { isVatRate } from '../shared/vat-rate';
import { Quantity } from '../shared/quantity';
import {
  allocateByLargestRemainder,
  computeLineBases,
  computeTotals,
  discountableNetHtCents,
} from '../../services/compute-totals';
import { retenueGarantieCents } from '../../services/retenue-garantie';
import { assertTransition, type InvoiceStatus, INVOICE_TRANSITIONS } from '../shared/state-machines';
import { type Quote } from '../quote/quote';
import { type UrgentRepairRequest } from '../../compliance/retractation';
import {
  isFrenchBillingMode,
  type FrenchBillingMode,
} from '../../compliance/french-billing-mode';

export type InvoiceKind = 'final' | 'deposit' | 'credit_note' | 'situation';
export type CreditedInvoiceKind = Exclude<InvoiceKind, 'credit_note'>;

export interface CreditNoteSourceSnapshot {
  invoiceId: string;
  kind: CreditedInvoiceKind;
  number: string;
  issuedAt: DateOnly;
}

export interface PrecedingInvoiceSnapshot {
  invoiceId: string;
  kind: 'deposit' | 'situation';
  number: string;
  issuedAt: DateOnly;
}

/**
 * A7 — Date/période de la prestation ou de la vente quand elle diffère de la date d'émission
 * (art. 242 nonies A, I-8° annexe II CGI et art. L441-9 code de commerce : « la date de la vente
 * ou de la prestation de services » est une mention obligatoire de la facture). `end` null =
 * prestation ponctuelle d'un seul jour ; une période s'étend de `start` à `end` inclus.
 */
export interface ServicePeriod {
  start: DateOnly;
  end: DateOnly | null;
}

const DELIVERY_ADDRESS_MAX = 500;

/**
 * Suivi MANUEL de transmission d'une facture émise vers le canal de facturation du client
 * (Chorus Pro / portail fournisseur) : dates DÉCLARÉES par l'artisan (jamais un accusé de
 * plateforme inventé — le raccordement PA réel est l'item B8, hors V1). Additif : null =
 * jamais suivi ; `acceptedAt` suppose un dépôt antérieur ou simultané (jamais une acceptation
 * sans dépôt). Mutable APRÈS émission : c'est un suivi opérationnel, pas un fait de la pièce.
 */
export interface InvoiceTransmissionStatus {
  depositedAt: DateOnly | null;
  acceptedAt: DateOnly | null;
}

export interface InvoicePaymentAllocation {
  ordinaryReceivableCents: number;
  retentionReceivableCents: number;
}

/**
 * A4 — régime de TVA de la pièce, FIGÉ à l'émission (fait fiscal de la pièce, plus jamais
 * recalculé depuis l'état MUTABLE de la fiche client/société) :
 *  • `franchise` : TVA non applicable, art. 293 B CGI (catégorie E du XML Factur-X) ;
 *  • `autoliquidation` : sous-traitance BTP, art. 283, 2 nonies CGI (catégorie AE) — la
 *    franchise PRIME quand les deux s'appliquent (BOI-TVA-DECLA-10-10-20) ;
 *  • `standard` : TVA facturée aux taux des lignes (catégories S/Z).
 */
export type VatTreatment = 'standard' | 'franchise' | 'autoliquidation';

export interface IssueInvoiceArgs {
  mentions: string[];
  terms: PaymentTerms;
  issuedAt: DateOnly;
  at: Instant;
  /** A7 — date de la prestation si distincte de l'émission ; null/absent = non renseignée
   *  (l'émission reste légale : la date de la pièce vaut alors date d'opération). */
  servicePeriod?: ServicePeriod | null;
  /** A7 — adresse de chantier/livraison si DISTINCTE de l'adresse de facturation du client
   *  (art. 242 nonies A CGI, donnée renforcée par la réforme e-invoicing 2026). Texte libre,
   *  même forme que Chantier.address ; null/absent = adresse de facturation. */
  deliveryAddress?: string | null;
  /** A4 — régime de TVA constaté PAR LE USE CASE à l'émission (company + customer relus dans la
   *  même transaction), FIGÉ ici. Absent = appelant antérieur : la pièce reste sans fait figé
   *  (le rendu Factur-X retombe sur la dérivation dynamique, honnêtement). */
  vatTreatment?: VatTreatment | null;
  /** BT-23 France — code réglementaire résolu AVANT numérotation puis figé. */
  frenchBillingMode: FrenchBillingMode;
}

/**
 * Agrégat Invoice — cycle commercial de la facture.
 * Numéro immuable assigné à la 1re sortie de draft ; totaux + mentions FIGÉS à l'émission.
 */
export class Invoice extends AggregateRoot<string> {
  private _status: InvoiceStatus = 'draft';
  private _lines: QuoteLine[] = [];
  private _depositDeductionCents = 0;
  /**
   * B2 — part de `_depositDeductionCents` provenant de SITUATIONS émises (le reste vient de
   * l'acompte). Nécessaire à la comptabilité de la finale : les situations ont déjà constaté
   * leur CA (70x), l'acompte est en avances (4191) — la reprise miroir ne porte que sur la
   * part acompte, le CA de la finale est réduit de la part situations (jamais compté deux fois).
   */
  private _situationDeductionCents = 0;
  private _depositInvoiceId: string | null = null;
  /** BG-3 — toutes les pièces antérieures effectivement émises sur le marché, snapshots figés
   * dans la finale. Ordre stable date/numéro/id, jamais une référence reconstruite après coup. */
  private _precedingInvoices: PrecedingInvoiceSnapshot[] = [];
  /** B3 — remise GLOBALE (reprise du devis à la dérivation, ou saisie sur facture directe). */
  private _globalDiscount: Discount | null = null;
  /** B5 — taux de retenue de garantie (loi 71-584), repris du devis (situations + finale). */
  private _retenueGarantiePct: number | null = null;
  /** B2 — n° d'ordre de la situation SUR SON DEVIS (1, 2, 3…) ; null hors kind 'situation'. */
  private _situationOrder: number | null = null;
  /**
   * B1/A3bis — facture DIRECTE B2C : intervention urgente à domicile expressément sollicitée
   * (art. L221-10, al. 2 et L221-28, 8° c. conso), fait posé À LA COMPOSITION, horodaté
   * serveur, IMMUABLE (aucun mutateur). Null = jamais sollicitée — fail-closed : sans cette
   * trace, aucune facture directe à un consommateur (les protections passent par le devis signé).
   */
  private _urgentRepair: UrgentRepairRequest | null = null;
  private _number: DocNumber | null = null;
  private _frozenTotals: Totals | null = null;
  /** V2 : les lignes d'acompte portent déjà leur quote-part réelle ; la créance légale et le
   * payable immédiat sont séparés pour les retenues. Absence = snapshot historique V1. */
  private _settlementSemanticsVersion: 1 | 2 = 1;
  private _mentions: string[] = [];
  private _issuedAt: DateOnly | null = null;
  private _dueAt: DateOnly | null = null;
  /** A7 — figés à l'émission (mêmes garanties d'immuabilité que mentions/totaux). */
  private _servicePeriod: ServicePeriod | null = null;
  private _deliveryAddress: string | null = null;
  /** A4 — régime de TVA figé à l'émission ; null = pièce émise avant le figeage (legacy). */
  private _vatTreatmentAtIssuance: VatTreatment | null = null;
  /** BT-23 — null uniquement pour les pièces historiques antérieures à son figeage. */
  private _frenchBillingModeAtIssuance: FrenchBillingMode | null = null;
  private _paid = 0; // centimes cumulés
  /** Suivi manuel de transmission (canal de facturation) ; null = jamais suivi. */
  private _transmission: InvoiceTransmissionStatus | null = null;
  private _cancelReason: string | null = null;
  /** Bon de commande client (B8) — repris du devis à la dérivation, figé à l'émission. */
  private _purchaseOrder: PurchaseOrderRef | null = null;
  /** Révision optimiste — incrémentée par les mutations de bon de commande. */
  private _revision = 1;

  private constructor(
    id: string,
    readonly companyId: string,
    readonly customerId: string,
    readonly kind: InvoiceKind,
    private readonly _depositPct: Percentage | null,
    readonly parentQuoteId: string | null,
    private readonly _creditNoteSource: CreditNoteSourceSnapshot | null,
  ) {
    super(id);
  }

  static fromSignedQuote(
    quote: Quote,
    mode: 'deposit' | 'final',
    id: string,
    opts?: {
      /** DÉJÀ FACTURÉ sur ce devis (acompte, situations émises) : la finale le déduit —
       *  jamais de double facturation. invoiceId = la pièce source si UNIQUE, null si la
       *  déduction est composite (acompte + situations, A5). */
      depositDeduction?: { amountCents: number; invoiceId: string | null };
      /** B2 — part de la déduction provenant des SITUATIONS émises (≤ amountCents) : pilote la
       *  comptabilité de la finale (CA des situations jamais compté deux fois). */
      situationDeductionCents?: number;
      /** HT déjà facturé par les situations. En V2, les lignes de la finale sont les travaux
       * RESTANTS ; cette valeur pilote leur proration déterministe, sans faux BT-113. */
      situationBilledHtCents?: number;
      situationBilledByQuoteLineCents?: Readonly<Record<string, number>>;
      precedingInvoices?: readonly PrecedingInvoiceSnapshot[];
    },
  ): DomainResult<Invoice> {
    if (quote.status !== 'signed')
      return err({ code: 'VALIDATION', field: 'quote', message: 'Le devis doit etre signe.' });
    let dep: Percentage | null = null;
    if (mode === 'deposit') {
      if (quote.depositPct === null)
        return err({
          code: 'VALIDATION',
          field: 'depositPct',
          message: 'Le devis doit définir un pourcentage d’acompte avant de créer la facture.',
        });
      const p = Percentage.of(quote.depositPct);
      if (!p.ok) return p;
      dep = p.value;
    }
    const kind: InvoiceKind = mode === 'deposit' ? 'deposit' : 'final';
    const inv = new Invoice(id, quote.companyId, quote.customerId, kind, dep, quote.id, null);
    if (mode === 'deposit') {
      // Une facture d'acompte facture réellement une quote-part du marché : ses lignes et ses
      // totaux portent cette quote-part. L'ancien modèle copiait 100 % du marché puis réduisait
      // seulement le net à payer, ce qui transformait le reliquat en faux BT-113 « déjà payé ».
      const { netLineBases } = computeLineBases(quote.lines, {
        globalDiscount: quote.globalDiscount,
      });
      const netHt = netLineBases.reduce((sum, amount) => sum + amount, 0);
      const targetHt = Math.round((netHt * dep!.value) / 100);
      const allocated = allocateByLargestRemainder(netLineBases, targetHt);
      for (const [index, line] of quote.lines.entries()) {
        const portion = allocated[index] ?? 0;
        if (portion <= 0) continue;
        inv._lines.push({
          id: line.id,
          label: `Acompte ${dep!.value} % — ${line.label}`,
          category: line.category,
          qty: 1,
          unitPriceHT: portion,
          vatRate: line.vatRate,
          sourceQuoteLineId: line.sourceQuoteLineId ?? line.id,
        });
      }
      if (inv._lines.length === 0)
        return err({
          code: 'VALIDATION',
          field: 'depositPct',
          message: 'Le montant de l’acompte est trop faible pour produire une ligne facturable.',
        });
      inv._settlementSemanticsVersion = 2;
    } else {
      const situationBilledHtCents = opts?.situationBilledHtCents ?? 0;
      const situationDeductionCents = opts?.situationDeductionCents ?? 0;
      if (!Number.isSafeInteger(situationBilledHtCents) || situationBilledHtCents < 0)
        return err({
          code: 'VALIDATION',
          field: 'situationBilledHtCents',
          message: 'Montant HT déjà facturé par situations invalide.',
        });
      if ((situationBilledHtCents === 0) !== (situationDeductionCents === 0))
        return err({
          code: 'VALIDATION',
          field: 'situationBilledHtCents',
          message:
            'Les montants HT et TTC des situations antérieures doivent être fournis ensemble.',
        });
      if (situationBilledHtCents > 0) {
        const { netLineBases } = computeLineBases(quote.lines, {
          globalDiscount: quote.globalDiscount,
        });
        const marketHt = netLineBases.reduce((sum, amount) => sum + amount, 0);
        if (situationBilledHtCents >= marketHt)
          return err({
            code: 'VALIDATION',
            field: 'situationBilledHtCents',
            message:
              'Les situations ont déjà facturé la totalité du marché : aucune nouvelle facture finale positive ne doit être créée.',
          });
        const billedByLine = opts?.situationBilledByQuoteLineCents;
        if (billedByLine === undefined)
          return err({
            code: 'VALIDATION',
            field: 'situationBilledByQuoteLineCents',
            message: 'La répartition des situations par ligne du devis est requise.',
          });
        const quoteLineIds = new Set(quote.lines.map((line) => line.id));
        for (const [sourceId, billed] of Object.entries(billedByLine)) {
          if (!quoteLineIds.has(sourceId) || !Number.isSafeInteger(billed) || billed < 0)
            return err({
              code: 'VALIDATION',
              field: 'situationBilledByQuoteLineCents',
              message: 'Répartition des situations par ligne invalide.',
            });
        }
        const allocatedTotal = Object.values(billedByLine).reduce((sum, amount) => sum + amount, 0);
        if (allocatedTotal !== situationBilledHtCents)
          return err({
            code: 'VALIDATION',
            field: 'situationBilledByQuoteLineCents',
            message: 'La somme par ligne ne correspond pas au HT déjà facturé par situations.',
          });
        for (const [index, line] of quote.lines.entries()) {
          const original = netLineBases[index] ?? 0;
          const billed = billedByLine[line.id] ?? 0;
          if (billed > original)
            return err({
              code: 'VALIDATION',
              field: 'situationBilledByQuoteLineCents',
              message: `La ligne ${line.id} a été facturée au-delà de sa base contractuelle.`,
            });
          const portion = original - billed;
          if (portion <= 0) continue;
          inv._lines.push({
            id: line.id,
            label: line.label,
            category: line.category,
            qty: 1,
            unitPriceHT: portion,
            vatRate: line.vatRate,
            sourceQuoteLineId: line.id,
          });
        }
      } else {
        for (const line of quote.lines) {
          inv._lines.push({
            ...line,
            // Même une finale sans situation conserve la provenance contractuelle. La base
            // vérifiera ainsi le lien devis → ligne sans snapshot artificiel de test.
            sourceQuoteLineId: line.sourceQuoteLineId ?? line.id,
          });
        }
      }
      inv._settlementSemanticsVersion = 2;
    }
    // B8 — REPRISE AUTOMATIQUE : le bon de commande du devis (source unique, saisi une fois)
    // suit la facture dérivée — le numéro d'engagement figurera sur la facture émise.
    const po = quote.purchaseOrder;
    inv._purchaseOrder = po ? clonePurchaseOrderRef(po) : null;
    // B3 — la remise globale NÉGOCIÉE au devis suit la pièce dérivée (source unique du marché).
    const discount = quote.globalDiscount;
    // L'acompte V2 porte déjà les bases nettes proratisées : recopier la remise la déduirait
    // une seconde fois. Les autres pièces conservent la remise négociée au devis.
    inv._globalDiscount =
      mode === 'deposit' || (opts?.situationBilledHtCents ?? 0) > 0
        ? null
        : discount
          ? cloneDiscount(discount)
          : null;
    // B5 — la retenue de garantie stipulée au devis s'applique aux situations et à la FINALE,
    // jamais à l'acompte (il précède l'exécution que la retenue garantit).
    if (mode === 'final') inv._retenueGarantiePct = quote.retenueGarantiePct;
    if (mode === 'final' && opts?.depositDeduction) {
      const { amountCents, invoiceId } = opts.depositDeduction;
      if (!Number.isSafeInteger(amountCents) || amountCents < 0)
        return err({ code: 'VALIDATION', field: 'depositDeduction', message: 'Déduction d’acompte invalide (centimes entiers ≥ 0 requis).' });
      const situationCents = opts.situationDeductionCents ?? 0;
      if (!Number.isSafeInteger(situationCents) || situationCents < 0 || situationCents > amountCents)
        return err({
          code: 'VALIDATION',
          field: 'situationDeductionCents',
          message: 'Part des situations invalide (centimes entiers, 0 ≤ part ≤ déduction totale).',
        });
      // `amountCents` contient l'historique acompte + situations pour la traçabilité/PDF ; en
      // V2 les situations sont déjà retirées des lignes, seule la part acompte est déduite du
      // total de cette nouvelle pièce.
      const advanceCents = amountCents - situationCents;
      const ttc = inv.totals().ttc;
      if (advanceCents > ttc)
        return err({ code: 'VALIDATION', field: 'depositDeduction', message: 'Reprise d’acompte supérieure au TTC restant du chantier.' });
      inv._depositDeductionCents = amountCents;
      inv._situationDeductionCents = situationCents;
      inv._depositInvoiceId = invoiceId;
      const preceding = opts.precedingInvoices ?? [];
      if (amountCents > 0 && preceding.length === 0)
        return err({
          code: 'VALIDATION',
          field: 'precedingInvoices',
          message:
            'Toute déduction de pièce antérieure doit conserver ses références légales.',
        });
      const ids = new Set<string>();
      for (const source of preceding) {
        if (
          !source.invoiceId.trim()
          || !source.number.trim()
          || !isValidDateOnly(source.issuedAt)
          || (source.kind !== 'deposit' && source.kind !== 'situation')
          || ids.has(source.invoiceId)
        )
          return err({
            code: 'VALIDATION',
            field: 'precedingInvoices',
            message: 'Référence de facture antérieure invalide ou dupliquée.',
          });
        ids.add(source.invoiceId);
      }
      inv._precedingInvoices = [...preceding]
        .map((source) => ({ ...source }))
        .sort((left, right) =>
          left.issuedAt.localeCompare(right.issuedAt)
          || left.number.localeCompare(right.number)
          || left.invoiceId.localeCompare(right.invoiceId));
    }
    return ok(inv);
  }

  /**
   * B2 — SITUATION DE TRAVAUX n° `order` d'un devis signé : facture intermédiaire d'avancement.
   * Les lignes de la situation SONT l'avancement — chaque poste du devis est proraté (bases HT
   * NETTES après remises B3, réparties au plus fort reste pour totaliser EXACTEMENT
   * `targetHtCents`) : la TVA est due par taux sur l'avancement facturé, la compta crédite les
   * mêmes comptes 70x que les postes d'origine, et le TTC de la pièce est le montant de la
   * situation. La retenue de garantie du devis (B5) s'y applique. La garde de CUMUL
   * (acompte + situations ≤ marché) appartient au use case — elle lit les pièces sœurs.
   */
  static situationFromSignedQuote(
    quote: Quote,
    id: string,
    input: { order: number; targetHtCents: number },
  ): DomainResult<Invoice> {
    if (quote.status !== 'signed')
      return err({ code: 'VALIDATION', field: 'quote', message: 'Le devis doit etre signe.' });
    if (!Number.isSafeInteger(input.order) || input.order < 1)
      return err({ code: 'VALIDATION', field: 'order', message: 'Numéro d’ordre de situation invalide (entier ≥ 1).' });
    if (!Number.isSafeInteger(input.targetHtCents) || input.targetHtCents <= 0)
      return err({
        code: 'VALIDATION',
        field: 'situation',
        message: 'Montant HT de situation invalide (centimes entiers > 0 requis).',
      });
    const { netLineBases } = computeLineBases(quote.lines, { globalDiscount: quote.globalDiscount });
    const netHt = netLineBases.reduce((sum, base) => sum + base, 0);
    if (input.targetHtCents > netHt)
      return err({
        code: 'VALIDATION',
        field: 'situation',
        message: 'Montant de situation supérieur au montant HT du marché.',
      });
    const inv = new Invoice(id, quote.companyId, quote.customerId, 'situation', null, quote.id, null);
    const allocated = allocateByLargestRemainder(netLineBases, input.targetHtCents);
    for (const [i, line] of quote.lines.entries()) {
      const portion = allocated[i] ?? 0;
      if (portion <= 0) continue; // poste sans avancement facturé : jamais de ligne à zéro.
      // Ligne d'avancement : même identifiant/poste/catégorie/taux que le devis (traçabilité),
      // base HT = quote-part NETTE (remises déjà imputées — la ligne n'en reporte aucune).
      inv._lines.push({
        id: line.id,
        label: line.label,
        category: line.category,
        qty: 1,
        unitPriceHT: portion,
        vatRate: line.vatRate,
        sourceQuoteLineId: line.sourceQuoteLineId ?? line.id,
      });
    }
    if (inv._lines.length === 0)
      return err({
        code: 'VALIDATION',
        field: 'situation',
        message: 'Montant de situation trop faible : aucun poste à facturer.',
      });
    inv._situationOrder = input.order;
    const po = quote.purchaseOrder;
    inv._purchaseOrder = po ? clonePurchaseOrderRef(po) : null;
    inv._retenueGarantiePct = quote.retenueGarantiePct;
    return ok(inv);
  }

  /**
   * B1 — FACTURE DIRECTE sans devis signé (dépannage urgent facturé sur place, régie TJM×jours,
   * syndics/B2B). `urgentRepair` : qualification A3bis d'une facture directe à un CONSOMMATEUR —
   * intervention urgente à domicile expressément sollicitée (exception L221-10, al. 2 et
   * L221-28, 8° c. conso), horodatée serveur À LA COMPOSITION, immuable, événement dédié.
   */
  static composeStandalone(input: {
    id: string;
    companyId: string;
    customerId: string;
    urgentRepair?: UrgentRepairRequest | null;
  }): DomainResult<Invoice> {
    const inv = new Invoice(input.id, input.companyId, input.customerId, 'final', null, null, null);
    if (input.urgentRepair) {
      inv._urgentRepair = { requestedAt: input.urgentRepair.requestedAt };
      // Même doctrine que Quote.compose : le fait légal qui fonde l'exception est journalisé
      // à sa naissance, jamais ajouté après coup.
      inv.record({
        type: 'InvoiceUrgentRepairDeclared',
        occurredAt: input.urgentRepair.requestedAt,
        version: 1,
      });
    }
    return ok(inv);
  }

  /**
   * Avoir TOTAL sur une facture émise (A6) : mêmes lignes et mêmes totaux légaux que la
   * pièce précise créditée. Le lien ne repose jamais sur le seul devis parent : l'identité,
   * le type, le numéro et la date d'émission de la source sont figés dans l'avoir.
   *
   * L'avoir naît BROUILLON mais son contenu monétaire est déjà immuable : ce n'est pas une
   * nouvelle facture éditable. Son émission lui alloue ensuite un numéro A- et poste le miroir
   * comptable exact de la source (acompte et reprise d'acompte compris).
   */
  static creditNoteFor(source: Invoice, id: string): DomainResult<Invoice> {
    if (source.kind === 'credit_note')
      return err({ code: 'VALIDATION', field: 'invoice', message: 'Un avoir ne se crée pas sur un avoir.' });
    if (!['issued', 'partially_paid', 'paid', 'late'].includes(source.status))
      return err({
        code: 'VALIDATION',
        field: 'invoice',
        message: 'Un avoir ne se crée que sur une facture émise (un brouillon se corrige ou s’annule).',
      });
    if (source.number === null || source.issuedAt === null || source._frozenTotals === null)
      return err({
        code: 'VALIDATION',
        field: 'invoice',
        message: 'La facture source ne possède pas de trace légale complète (numéro, date et totaux figés).',
      });
    if (
      source._vatTreatmentAtIssuance === null
      || source._frenchBillingModeAtIssuance === null
    )
      return err({
        code: 'VALIDATION',
        field: 'invoice',
        message:
          'La facture source historique ne possède pas ses faits fiscaux figés. ' +
          'Sa régularisation doit être qualifiée avant de créer un avoir.',
      });
    const creditNote = new Invoice(
      id,
      source.companyId,
      source.customerId,
      'credit_note',
      source._depositPct,
      source.parentQuoteId,
      {
        invoiceId: source.id,
        kind: source.kind,
        number: source.number,
        issuedAt: source.issuedAt,
      },
    );
    for (const line of source.lines) creditNote._lines.push({ ...line });
    creditNote._depositDeductionCents = source._depositDeductionCents;
    creditNote._situationDeductionCents = source._situationDeductionCents;
    creditNote._depositInvoiceId = source._depositInvoiceId;
    // B3/B5/B2 — l'avoir rectifie la MÊME opération : remise globale, retenue de garantie et
    // n° d'ordre de situation sont REPRIS de la pièce annulée (miroir exact, jamais recalculés).
    creditNote._globalDiscount = source._globalDiscount ? cloneDiscount(source._globalDiscount) : null;
    creditNote._retenueGarantiePct = source._retenueGarantiePct;
    creditNote._situationOrder = source._situationOrder;
    creditNote._frozenTotals = cloneTotals(source._frozenTotals);
    creditNote._settlementSemanticsVersion = source._settlementSemanticsVersion;
    // A7 : l'avoir rectifie la MÊME opération — il reprend la période de prestation et l'adresse
    // de chantier de la pièce annulée (art. 242 nonies A CGI : la pièce rectificative fait
    // référence aux éléments de la facture initiale), jamais des valeurs nouvelles.
    creditNote._servicePeriod = source._servicePeriod ? { ...source._servicePeriod } : null;
    creditNote._deliveryAddress = source._deliveryAddress;
    // A4 : l'avoir rectifie la MÊME opération sous le MÊME régime de TVA (art. 272 CGI — la
    // TVA récupérée est celle de la facture initiale) : le fait figé est REPRIS de la source,
    // jamais recalculé depuis l'état courant du client/de la société.
    creditNote._vatTreatmentAtIssuance = source._vatTreatmentAtIssuance;
    // BT-23 : l'avoir rectifie la même opération et reprend le cadre exact de sa source.
    creditNote._frenchBillingModeAtIssuance = source._frenchBillingModeAtIssuance;
    // B8 : l'avoir cite le même numéro d'engagement que la pièce annulée (compta client grands comptes).
    creditNote._purchaseOrder = source._purchaseOrder
      ? clonePurchaseOrderRef(source._purchaseOrder)
      : null;
    return ok(creditNote);
  }

  get status(): InvoiceStatus {
    return this._status;
  }
  get lines(): readonly QuoteLine[] {
    return this._lines;
  }
  get number(): string | null {
    return this._number?.value ?? null;
  }
  get mentions(): readonly string[] {
    return this._mentions;
  }
  get issuedAt(): DateOnly | null {
    return this._issuedAt;
  }
  get dueAt(): DateOnly | null {
    return this._dueAt;
  }
  /** A7 — date/période de la prestation figée à l'émission ; null = non renseignée. */
  get servicePeriod(): ServicePeriod | null {
    return this._servicePeriod ? { ...this._servicePeriod } : null;
  }
  /** A7 — adresse de chantier/livraison figée à l'émission ; null = adresse de facturation. */
  get deliveryAddress(): string | null {
    return this._deliveryAddress;
  }
  /** A4 — régime de TVA figé à l'émission ; null = pièce émise avant le figeage (legacy). */
  get vatTreatmentAtIssuance(): VatTreatment | null {
    return this._vatTreatmentAtIssuance;
  }
  get frenchBillingModeAtIssuance(): FrenchBillingMode | null {
    return this._frenchBillingModeAtIssuance;
  }
  get paid(): number {
    return this._paid;
  }
  /** Acompte déjà facturé, déduit du net à payer de la finale (0 = aucun). */
  get depositDeductionCents(): number {
    return this._depositDeductionCents;
  }
  /** B2 — part de la déduction provenant des situations émises (0 = aucune). */
  get situationDeductionCents(): number {
    return this._situationDeductionCents;
  }
  /** Facture d'acompte déduite (traçabilité + nav croisée). */
  get depositInvoiceId(): string | null {
    return this._depositInvoiceId;
  }
  get precedingInvoices(): readonly PrecedingInvoiceSnapshot[] {
    return this._precedingInvoices.map((source) => ({ ...source }));
  }
  /** Version de calcul figée avec la pièce : 1 = historique, 2 = lignes fiscales résiduelles. */
  get settlementSemanticsVersion(): 1 | 2 {
    return this._settlementSemanticsVersion;
  }
  /** Part réellement reprise comme avance ; les situations V2 sont déjà retirées des lignes. */
  get advanceDeductionCents(): number {
    return this._settlementSemanticsVersion === 2
      ? Math.max(0, this._depositDeductionCents - this._situationDeductionCents)
      : this._depositDeductionCents;
  }
  /** B3 — remise globale de la pièce (copie défensive) ; null = aucune. */
  get globalDiscount(): Discount | null {
    return this._globalDiscount ? cloneDiscount(this._globalDiscount) : null;
  }
  /** B5 — taux de retenue de garantie applicable à cette pièce ; null = aucune. */
  get retenueGarantiePct(): number | null {
    return this._retenueGarantiePct;
  }
  /** B2 — n° d'ordre de la situation sur son devis ; null hors kind 'situation'. */
  get situationOrder(): number | null {
    return this._situationOrder;
  }
  /** B1/A3bis — intervention urgente tracée à la composition (facture directe B2C) ; null sinon. */
  get urgentRepair(): UrgentRepairRequest | null {
    return this._urgentRepair ? { ...this._urgentRepair } : null;
  }
  /** Suivi manuel de transmission (copie défensive) ; null = jamais suivi. */
  get transmission(): InvoiceTransmissionStatus | null {
    return this._transmission ? { ...this._transmission } : null;
  }
  /** Identité légale immuable de la facture annulée par cet avoir total. */
  get creditNoteSource(): CreditNoteSourceSnapshot | null {
    return this._creditNoteSource ? { ...this._creditNoteSource } : null;
  }
  get purchaseOrder(): PurchaseOrderRef | null {
    return this._purchaseOrder;
  }
  get revision(): number {
    return this._revision;
  }

  /**
   * B8 : attache (ou remplace) le bon de commande — BROUILLON uniquement : un PO se fixe
   * AVANT émission (le numéro d'engagement doit figurer sur la pièce légale figée).
   * Idempotent si la référence est identique. Un avoir hérite du PO de sa source : figé.
   */
  attachPurchaseOrder(ref: PurchaseOrderRef, at: Instant): DomainResult<void> {
    if (this.kind === 'credit_note')
      return err({
        code: 'VALIDATION',
        field: 'purchaseOrder',
        message: 'Le bon de commande d’un avoir est figé depuis la facture source.',
      });
    if (this._status !== 'draft')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message: 'Le bon de commande se fixe avant émission — cette facture est déjà émise.',
      });
    if (purchaseOrderRefEquals(this._purchaseOrder, ref)) return ok(undefined);
    this._purchaseOrder = clonePurchaseOrderRef(ref);
    this._revision += 1;
    this.record({ type: 'InvoicePurchaseOrderAttached', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  /** B8 : retrait EXPLICITE du bon de commande — brouillon uniquement (mêmes gardes que l'attache). */
  detachPurchaseOrder(at: Instant): DomainResult<void> {
    if (this.kind === 'credit_note')
      return err({
        code: 'VALIDATION',
        field: 'purchaseOrder',
        message: 'Le bon de commande d’un avoir est figé depuis la facture source.',
      });
    if (this._status !== 'draft')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message: 'Le bon de commande se fixe avant émission — cette facture est déjà émise.',
      });
    if (this._purchaseOrder === null)
      return err({
        code: 'VALIDATION',
        field: 'purchaseOrder',
        message: 'Aucun bon de commande attaché à cette facture.',
      });
    this._purchaseOrder = null;
    this._revision += 1;
    this.record({ type: 'InvoicePurchaseOrderDetached', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  addLine(line: QuoteLine): DomainResult<void> {
    if (this._status !== 'draft')
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'draft' });
    if (this.kind === 'credit_note')
      return err({
        code: 'VALIDATION',
        field: 'lines',
        message: 'Les lignes d’un avoir total sont figées depuis la facture source.',
      });
    // B2 — les lignes d'une situation SONT l'avancement proraté du devis : figées à la création.
    if (this._situationOrder !== null)
      return err({
        code: 'VALIDATION',
        field: 'lines',
        message: 'Les lignes d’une situation sont dérivées du devis — elles ne s’éditent pas.',
      });
    const q = Quantity.of(line.qty);
    if (!q.ok) return q;
    if (!isVatRate(line.vatRate))
      return err({ code: 'VALIDATION', field: 'vatRate', message: 'Taux TVA non autorise.' });
    // B3 — remise de ligne validée contre SA base HT (structure + plafond, jamais négative) ;
    // B9 — refusée sur un débours (art. 267, II-2° CGI : remboursement à l'euro près).
    if (line.discount !== undefined) {
      const discount = validateLineDiscount(
        line.discount,
        Math.round(line.qty * line.unitPriceHT),
        line.category,
      );
      if (!discount.ok) return discount;
    }
    this._lines.push(line);
    return ok(undefined);
  }

  /**
   * B3 — remise GLOBALE d'une facture DIRECTE (composeStandalone) uniquement, en brouillon :
   * les pièces dérivées d'un devis reprennent la remise NÉGOCIÉE au devis (source unique du
   * marché — la modifier sur la facture ferait diverger la pièce du contrat signé), un avoir
   * est figé, une situation est déjà nette de remises.
   */
  setGlobalDiscount(discount: Discount | null): DomainResult<void> {
    if (this._status !== 'draft')
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'draft' });
    if (this.kind === 'credit_note' || this.parentQuoteId !== null)
      return err({
        code: 'VALIDATION',
        field: 'globalDiscount',
        message:
          'La remise globale se saisit sur une facture directe uniquement — une pièce dérivée reprend celle du devis.',
      });
    if (discount === null) {
      this._globalDiscount = null;
      return ok(undefined);
    }
    const structural = validateDiscount(discount, 'globalDiscount');
    if (!structural.ok) return structural;
    if (discount.type === 'amount') {
      // B9 — plafond sur le HT REMISABLE : les débours (art. 267, II-2° CGI) sont hors remise.
      const netHt = discountableNetHtCents(this._lines);
      if (discount.cents > netHt)
        return err({
          code: 'VALIDATION',
          field: 'globalDiscount',
          message:
            'Remise globale supérieure au HT remisable de la facture (après remises de ligne, hors débours).',
        });
    }
    this._globalDiscount = cloneDiscount(discount);
    return ok(undefined);
  }

  totals(): Totals {
    if (this._frozenTotals) return this._frozenTotals;
    const base = computeTotals([...this._lines], {
      ...(this._depositPct && this._settlementSemanticsVersion === 1
        ? { depositPct: this._depositPct.value }
        : {}),
      ...(this._globalDiscount ? { globalDiscount: this._globalDiscount } : {}),
    });
    // B2 — situation : les lignes SONT l'avancement (ttc = montant de la situation) ; la
    // retenue de garantie (B5) se déduit du NET À PAYER, jamais de la TVA due (la TVA est
    // facturée sur l'avancement plein, seul l'encaissement de la retenue est différé).
    if (this.kind === 'situation') {
      const retenue = retenueGarantieCents(base.ttc, this._retenueGarantiePct);
      return {
        ...base,
        ...(retenue > 0 ? { retenueGarantieCents: retenue } : {}),
        duePayableCents: base.ttc,
        netToPay: base.ttc - retenue,
      };
    }
    if (this._depositDeductionCents > 0 || (this.kind === 'final' && this._retenueGarantiePct !== null)) {
      // Facture finale : le net à payer est LE SOLDE (ttc − déjà facturé), amputé de la
      // retenue de garantie stipulée au devis (B5, assise sur le solde effectivement appelé).
      const advanceCents = this._settlementSemanticsVersion === 2
        ? Math.max(0, this._depositDeductionCents - this._situationDeductionCents)
        : this._depositDeductionCents;
      const solde = Math.max(0, base.ttc - advanceCents);
      // La retenue porte sur les travaux positifs facturés par CETTE pièce, avant reprise de
      // l'acompte ; l'avance n'est pas une réduction de l'assiette des travaux garantis.
      const retentionBasis = this._settlementSemanticsVersion === 2 ? base.ttc : solde;
      const retenue = this.kind === 'final'
        ? retenueGarantieCents(retentionBasis, this._retenueGarantiePct)
        : 0;
      return {
        ...base,
        ...(retenue > 0 ? { retenueGarantieCents: retenue } : {}),
        duePayableCents: solde,
        netToPay: Math.max(0, solde - retenue),
      };
    }
    return { ...base, duePayableCents: base.netToPay };
  }

  assignNumber(n: DocNumber, at: Instant): DomainResult<void> {
    if (this._number) return err({ code: 'VALIDATION', field: 'number', message: 'Numero deja attribue.' });
    this._number = n;
    this.record({ type: 'DocumentNumbered', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  issue(args: IssueInvoiceArgs): DomainResult<void> {
    const t = assertTransition(INVOICE_TRANSITIONS, this._status, 'issued');
    if (!t.ok) return t;
    if (!this._number) return err({ code: 'VALIDATION', field: 'number', message: 'Numero requis avant emission.' });
    if (this._lines.length === 0)
      return err({ code: 'VALIDATION', field: 'lines', message: 'Au moins une ligne requise.' });
    if (
      this.kind === 'credit_note'
      && (
        this._vatTreatmentAtIssuance === null
        || this._frenchBillingModeAtIssuance === null
      )
    )
      return err({
        code: 'VALIDATION',
        field: 'invoice',
        message:
          'Un avoir ne peut être émis sans les faits fiscaux figés de sa facture source.',
      });
    if (
      this.kind === 'credit_note'
      && this._frenchBillingModeAtIssuance !== null
      && this._frenchBillingModeAtIssuance !== args.frenchBillingMode
    )
      return err({
        code: 'VALIDATION',
        field: 'frenchBillingMode',
        message: 'Le cadre de facturation de l’avoir doit rester celui de la facture source.',
      });
    // A7 : un avoir total rectifie la MÊME opération — sa période de prestation et son adresse
    // de chantier sont REPRISES de la pièce annulée à la création (creditNoteFor) et ne se
    // saisissent jamais à son émission (miroir exact exigé aussi par le trigger SQL).
    if (this.kind === 'credit_note' && (args.servicePeriod != null || args.deliveryAddress != null))
      return err({
        code: 'VALIDATION',
        field: 'servicePeriod',
        message: 'La période de prestation et l’adresse d’un avoir sont figées depuis la facture source.',
      });
    // A7 : validation AVANT toute mutation — un rejet laisse la facture intacte (le use case
    // annule alors la transaction, aucun numéro consommé).
    const servicePeriod = args.servicePeriod ?? null;
    if (servicePeriod !== null) {
      if (!isValidDateOnly(servicePeriod.start))
        return err({ code: 'VALIDATION', field: 'servicePeriod', message: 'Date de prestation invalide (AAAA-MM-JJ requis).' });
      if (servicePeriod.end !== null) {
        if (!isValidDateOnly(servicePeriod.end))
          return err({ code: 'VALIDATION', field: 'servicePeriod', message: 'Fin de période de prestation invalide (AAAA-MM-JJ requis).' });
        if (servicePeriod.end < servicePeriod.start)
          return err({ code: 'VALIDATION', field: 'servicePeriod', message: 'La fin de la période de prestation précède son début.' });
      }
    }
    const deliveryAddressRaw = args.deliveryAddress ?? null;
    const deliveryAddress = deliveryAddressRaw === null ? null : deliveryAddressRaw.trim();
    if (deliveryAddress !== null) {
      if (
        deliveryAddress.length === 0
        || deliveryAddress.length > DELIVERY_ADDRESS_MAX
        || hasBillingControlCharacter(deliveryAddress)
      )
        return err({ code: 'VALIDATION', field: 'deliveryAddress', message: 'Adresse de chantier/livraison invalide (500 caractères max).' });
    }
    // B3 — garde AUTORITAIRE au figeage : une remise globale en montant ne peut excéder le HT
    // REMISABLE (les lignes d'une facture directe ont pu bouger depuis la saisie ; B9 — les
    // débours, art. 267, II-2° CGI, restent hors remise).
    if (this.kind !== 'credit_note' && this._globalDiscount?.type === 'amount') {
      const netHt = discountableNetHtCents(this._lines);
      if (this._globalDiscount.cents > netHt)
        return err({
          code: 'VALIDATION',
          field: 'globalDiscount',
          message:
            'Remise globale supérieure au HT remisable de la facture (après remises de ligne, hors débours).',
        });
    }
    this._frozenTotals = this.totals();
    this._mentions = [...args.mentions];
    this._issuedAt = args.issuedAt;
    this._dueAt = args.terms.dueDateFrom(args.issuedAt);
    // A4 — le régime de TVA constaté à l'émission devient un fait de la pièce (jamais réécrit).
    // Un AVOIR conserve le régime REPRIS de sa facture source (creditNoteFor, art. 272 CGI) —
    // l'émission ne le réécrit pas depuis l'état courant.
    if (this.kind !== 'credit_note') this._vatTreatmentAtIssuance = args.vatTreatment ?? null;
    if (this.kind !== 'credit_note') this._frenchBillingModeAtIssuance = args.frenchBillingMode;
    // Un avoir CONSERVE la période/adresse reprises de sa source (jamais réécrites ici).
    if (this.kind !== 'credit_note') {
      this._servicePeriod = servicePeriod === null ? null : { ...servicePeriod };
      this._deliveryAddress = deliveryAddress;
    }
    this._status = 'issued';
    this.record({ type: 'InvoiceIssued', occurredAt: args.at, version: 1 });
    return ok(undefined);
  }

  /**
   * Suivi MANUEL de transmission d'une pièce ÉMISE (canal de facturation du client) :
   * l'artisan déclare la date de dépôt (Chorus/portail) puis la date d'acceptation. Honnêteté
   * structurelle : jamais d'acceptation sans dépôt, jamais d'acceptation antérieure au dépôt.
   * Corrigeable (suivi opérationnel déclaratif, pas un fait légal de la pièce) ; `null` efface.
   */
  recordTransmission(status: InvoiceTransmissionStatus, at: Instant): DomainResult<void> {
    if (this._status === 'draft' || this._status === 'cancelled')
      return err({
        code: 'VALIDATION',
        field: 'transmission',
        message: 'Le suivi de transmission ne concerne qu’une pièce émise.',
      });
    const depositedAt = status.depositedAt ?? null;
    const acceptedAt = status.acceptedAt ?? null;
    if (depositedAt !== null && !isValidDateOnly(depositedAt))
      return err({ code: 'VALIDATION', field: 'transmission.depositedAt', message: 'Date de dépôt invalide (AAAA-MM-JJ).' });
    if (acceptedAt !== null && !isValidDateOnly(acceptedAt))
      return err({ code: 'VALIDATION', field: 'transmission.acceptedAt', message: 'Date d’acceptation invalide (AAAA-MM-JJ).' });
    if (acceptedAt !== null && depositedAt === null)
      return err({
        code: 'VALIDATION',
        field: 'transmission.acceptedAt',
        message: 'Une acceptation suppose un dépôt : renseigne d’abord la date de dépôt.',
      });
    if (acceptedAt !== null && depositedAt !== null && acceptedAt < depositedAt)
      return err({
        code: 'VALIDATION',
        field: 'transmission.acceptedAt',
        message: 'La date d’acceptation précède la date de dépôt.',
      });
    this._transmission = depositedAt === null && acceptedAt === null ? null : { depositedAt, acceptedAt };
    this.record({ type: 'InvoiceTransmissionRecorded', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  registerPayment(amountCents: number, at: Instant): DomainResult<InvoicePaymentAllocation> {
    if (this._status !== 'issued' && this._status !== 'partially_paid' && this._status !== 'late')
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'partially_paid' });
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
      return err({ code: 'VALIDATION', field: 'amount', message: 'Montant > 0 requis en centimes entiers.' });
    const totals = this._frozenTotals ?? this.totals();
    const due = totals.duePayableCents ?? totals.netToPay;
    const remaining = due - this._paid;
    // Pas de trop-perçu silencieux : un paiement supérieur au reste dû est rejeté (avoir/remboursement = flux dédié).
    if (amountCents > remaining)
      return err({ code: 'VALIDATION', field: 'amount', message: `Paiement supérieur au reste dû (${remaining} c).` });
    const ordinaryRemaining = Math.max(0, totals.netToPay - this._paid);
    const ordinaryReceivableCents = Math.min(amountCents, ordinaryRemaining);
    const retentionReceivableCents = amountCents - ordinaryReceivableCents;
    this._paid += amountCents;
    if (this._paid >= due) {
      this._status = 'paid';
      this.record({ type: 'PaymentReceived', occurredAt: at, version: 1 });
    } else {
      this._status = 'partially_paid';
      this.record({ type: 'InvoicePartiallyPaid', occurredAt: at, version: 1 });
    }
    return ok({ ordinaryReceivableCents, retentionReceivableCents });
  }

  markLate(at: Instant): DomainResult<void> {
    const t = assertTransition(INVOICE_TRANSITIONS, this._status, 'late');
    if (!t.ok) return t;
    this._status = 'late';
    this.record({ type: 'InvoiceLate', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  cancel(reason: string, at: Instant): DomainResult<void> {
    const t = assertTransition(INVOICE_TRANSITIONS, this._status, 'cancelled');
    if (!t.ok) return t;
    this._status = 'cancelled';
    this._cancelReason = reason;
    this.record({ type: 'InvoiceCancelled', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  // ——— Persistance ———
  toSnapshot(): InvoiceSnapshot {
    return {
      id: this.id,
      companyId: this.companyId,
      customerId: this.customerId,
      kind: this.kind,
      status: this._status,
      lines: this._lines.map((l) => ({ ...l })),
      number: this._number?.value ?? null,
      frozenTotals: this._frozenTotals,
      settlementSemanticsVersion: this._settlementSemanticsVersion,
      mentions: [...this._mentions],
      issuedAt: this._issuedAt,
      dueAt: this._dueAt,
      servicePeriod: this._servicePeriod ? { ...this._servicePeriod } : null,
      deliveryAddress: this._deliveryAddress,
      vatTreatmentAtIssuance: this._vatTreatmentAtIssuance,
      frenchBillingModeAtIssuance: this._frenchBillingModeAtIssuance,
      paid: this._paid,
      depositPct: this._depositPct?.value ?? null,
      parentQuoteId: this.parentQuoteId,
      depositDeductionCents: this._depositDeductionCents,
      situationDeductionCents: this._situationDeductionCents,
      depositInvoiceId: this._depositInvoiceId,
      precedingInvoices: this._precedingInvoices.map((source) => ({ ...source })),
      globalDiscount: this._globalDiscount ? cloneDiscount(this._globalDiscount) : null,
      retenueGarantiePct: this._retenueGarantiePct,
      situationOrder: this._situationOrder,
      urgentRepair: this._urgentRepair ? { ...this._urgentRepair } : null,
      transmission: this._transmission ? { ...this._transmission } : null,
      sourceInvoiceId: this._creditNoteSource?.invoiceId ?? null,
      sourceInvoiceKind: this._creditNoteSource?.kind ?? null,
      sourceInvoiceNumber: this._creditNoteSource?.number ?? null,
      sourceInvoiceIssuedAt: this._creditNoteSource?.issuedAt ?? null,
      purchaseOrder: this._purchaseOrder ? clonePurchaseOrderRef(this._purchaseOrder) : null,
      revision: this._revision,
    };
  }

  static rehydrate(s: InvoiceSnapshot): Invoice {
    let dep: Percentage | null = null;
    if (s.depositPct !== null) {
      const p = Percentage.of(s.depositPct);
      if (p.ok) dep = p.value;
    }
    const source =
      s.sourceInvoiceId && s.sourceInvoiceKind && s.sourceInvoiceNumber && s.sourceInvoiceIssuedAt
        ? {
            invoiceId: s.sourceInvoiceId,
            kind: s.sourceInvoiceKind,
            number: s.sourceInvoiceNumber,
            issuedAt: s.sourceInvoiceIssuedAt,
          }
        : null;
    const inv = new Invoice(s.id, s.companyId, s.customerId, s.kind, dep, s.parentQuoteId, source);
    inv._status = s.status;
    inv._lines = s.lines.map((l) => ({ ...l }));
    if (s.number) {
      const n = DocNumber.of(s.number);
      if (n.ok) inv._number = n.value;
    }
    inv._frozenTotals = s.frozenTotals;
    inv._settlementSemanticsVersion = s.settlementSemanticsVersion === 2 ? 2 : 1;
    inv._mentions = [...s.mentions];
    inv._issuedAt = s.issuedAt;
    inv._dueAt = s.dueAt;
    // Compat ascendante A7 : snapshots antérieurs sans période de prestation ni adresse de
    // livraison — jamais rétro-remplis (la pièce émise reste exactement ce qu'elle était).
    inv._servicePeriod = s.servicePeriod ? { ...s.servicePeriod } : null;
    inv._deliveryAddress = s.deliveryAddress ?? null;
    // Compat ascendante A4 : pièces émises avant le figeage du régime de TVA (null honnête).
    inv._vatTreatmentAtIssuance = s.vatTreatmentAtIssuance ?? null;
    inv._frenchBillingModeAtIssuance = isFrenchBillingMode(s.frenchBillingModeAtIssuance)
      ? s.frenchBillingModeAtIssuance
      : null;
    inv._paid = s.paid;
    inv._depositDeductionCents = s.depositDeductionCents ?? 0;
    inv._depositInvoiceId = s.depositInvoiceId ?? null;
    inv._precedingInvoices = (s.precedingInvoices ?? []).map((source) => ({ ...source }));
    // Compat ascendante B2/B3/B5 : snapshots antérieurs sans situations, remises ni retenue.
    inv._situationDeductionCents = s.situationDeductionCents ?? 0;
    inv._globalDiscount = s.globalDiscount ? cloneDiscount(s.globalDiscount) : null;
    inv._retenueGarantiePct = s.retenueGarantiePct ?? null;
    inv._situationOrder = s.situationOrder ?? null;
    // Compat ascendante B1/A3bis : facture directe antérieure sans qualification (null honnête —
    // fail-closed : jamais une urgence inventée).
    inv._urgentRepair = s.urgentRepair ? { requestedAt: s.urgentRepair.requestedAt } : null;
    // Compat ascendante transmission : suivi absent des snapshots antérieurs (null honnête).
    inv._transmission = s.transmission ? { ...s.transmission } : null;
    // Compat ascendante B8 : snapshots antérieurs sans bon de commande ni révision.
    inv._purchaseOrder = s.purchaseOrder ? clonePurchaseOrderRef(s.purchaseOrder) : null;
    inv._revision = s.revision ?? 1;
    return inv;
  }
}

export interface InvoiceSnapshot {
  id: string;
  companyId: string;
  customerId: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  lines: QuoteLine[];
  number: string | null;
  frozenTotals: Totals | null;
  /** Optionnel pour relire sans invention les pièces antérieures à la sémantique V2. */
  settlementSemanticsVersion?: 1 | 2;
  mentions: string[];
  issuedAt: DateOnly | null;
  dueAt: DateOnly | null;
  /** A7 — optionnels : les snapshots antérieurs restent lisibles (compat ascendante). */
  servicePeriod?: ServicePeriod | null;
  deliveryAddress?: string | null;
  /** A4 — optionnel : régime de TVA figé absent des snapshots antérieurs (jamais rétro-déduit). */
  vatTreatmentAtIssuance?: VatTreatment | null;
  /** BT-23 — optionnel pour relire les pièces historiques sans inventer leur cadre. */
  frenchBillingModeAtIssuance?: FrenchBillingMode | null;
  paid: number;
  depositPct: number | null;
  parentQuoteId: string | null;
  /** Acompte déjà facturé déduit de la finale — optionnels : snapshots antérieurs compatibles. */
  depositDeductionCents?: number;
  /** B2 — part de la déduction provenant des situations émises (compat ascendante). */
  situationDeductionCents?: number;
  depositInvoiceId?: string | null;
  precedingInvoices?: PrecedingInvoiceSnapshot[];
  /** B3 — optionnel : remise globale absente des snapshots antérieurs (compat ascendante). */
  globalDiscount?: Discount | null;
  /** B5 — optionnel : taux de retenue de garantie absent des snapshots antérieurs. */
  retenueGarantiePct?: number | null;
  /** B2 — optionnel : n° d'ordre de situation absent des snapshots antérieurs. */
  situationOrder?: number | null;
  /** B1/A3bis — optionnel : qualification urgence absente des snapshots antérieurs (jamais inventée). */
  urgentRepair?: UrgentRepairRequest | null;
  /** Optionnel : suivi manuel de transmission absent des snapshots antérieurs (null honnête). */
  transmission?: InvoiceTransmissionStatus | null;
  /** Trace légale de la facture exacte annulée. Optionnelle pour relire les snapshots legacy. */
  sourceInvoiceId?: string | null;
  sourceInvoiceKind?: CreditedInvoiceKind | null;
  sourceInvoiceNumber?: string | null;
  sourceInvoiceIssuedAt?: DateOnly | null;
  /** B8 — optionnels : les snapshots antérieurs restent lisibles (compat ascendante). */
  purchaseOrder?: PurchaseOrderRef | null;
  revision?: number;
}

function cloneTotals(totals: Totals): Totals {
  return { ...totals, vatByRate: { ...totals.vatByRate } };
}
