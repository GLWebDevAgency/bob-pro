import { AggregateRoot } from '../../../shared-kernel/aggregate';
import { type DomainResult, ok, err } from '../../../shared-kernel/result';
import { type Instant, type DateOnly, parisDateOnly } from '../../../shared-kernel/time';
import { Percentage } from '../../../shared-kernel/percentage';
import { DocNumber } from '../shared/doc-number';
import { type QuoteLine } from '../shared/line';
import {
  hasBillingControlCharacter,
  MAX_BILLING_AMOUNT_CENTS,
  type LineInput,
} from '../shared/line-item';
import { type Totals } from '../shared/totals';
import { type Signature } from '../shared/signature';
import {
  type PurchaseOrderRef,
  purchaseOrderRefEquals,
  clonePurchaseOrderRef,
} from '../shared/purchase-order-ref';
import {
  type Discount,
  cloneDiscount,
  discountEquals,
  validateDiscount,
  validateLineDiscount,
} from '../shared/discount';
import { isVatRate } from '../shared/vat-rate';
import { Quantity } from '../shared/quantity';
import { computeTotals, discountableNetHtCents } from '../../services/compute-totals';
import { validateRetenueGarantiePct } from '../../services/retenue-garantie';
import { assertTransition, type QuoteStatus, QUOTE_TRANSITIONS } from '../shared/state-machines';
import { type UrgentRepairRequest } from '../../compliance/retractation';

const MAX_QUOTE_QTY = 1_000_000;

export interface ComposeQuoteInput {
  id: string;
  companyId: string;
  customerId: string;
  at: Instant;
  validUntil?: DateOnly;
  /**
   * Exception dépannage urgent (art. L221-10, al. 2 et L221-28, 8° c. conso) : intervention
   * urgente expressément sollicitée par le client B2C, posée À LA CRÉATION du devis (question
   * du wizard), horodatée serveur — JAMAIS rétroactive (aucun mutateur : le fait naît avec le
   * devis ou n'existe pas).
   */
  urgentRepair?: UrgentRepairRequest | null;
  /**
   * PR-08 — site/chantier de rattachement de la pièce (même sémantique nullable
   * qu'`Expense.chantierId`) : null = pièce hors site. L'appartenance du chantier au tenant
   * est PROUVÉE par le use case (anti-IDOR fail-closed), jamais ici.
   */
  chantierId?: string | null;
}

/**
 * Agrégat Quote — cycle commercial du devis (draft -> sent -> viewed -> signed/refused/expired).
 * Invariants structurels uniquement : édition en draft, taux valide, numéro immuable, transitions légales.
 * Les règles cross-agrégat (franchise/autoliquidation) sont appliquées par le use case via suggestVatRate.
 */
export class Quote extends AggregateRoot<string> {
  private _status: QuoteStatus = 'draft';
  private _lines: QuoteLine[] = [];
  private _number: DocNumber | null = null;
  private _depositPct: Percentage | null = null;
  private _signature: Signature | null = null;
  /** Bon de commande client (B8) — null par défaut : compat ascendante totale. */
  private _purchaseOrder: PurchaseOrderRef | null = null;
  /** B3 — remise GLOBALE du devis (% ou montant HT), null par défaut : compat ascendante. */
  private _globalDiscount: Discount | null = null;
  /**
   * B5 — taux de retenue de garantie du devis-chantier (marché privé de travaux, loi 71-584),
   * OPTIONNEL et jamais imposé : null = aucune retenue. Reprise par les situations et la finale.
   */
  private _retenueGarantiePct: number | null = null;
  /** A1 — date d'établissement du devis, dérivée à l'envoi (jour métier Paris). */
  private _issuedAt: DateOnly | null = null;
  /**
   * A3 — rétractation du CONSOMMATEUR exercée via la fonctionnalité en ligne (art. L221-21
   * dernier al. c. conso). Fait ADDITIF horodaté serveur, jamais déduit : null = jamais
   * exercée. Le devis signé reste le contrat archivé (immutabilité des pièces) — la
   * rétractation est un événement postérieur qui gèle toute facturation dérivée.
   */
  private _retractedAt: Instant | null = null;
  /**
   * Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°) — fait posé à la composition,
   * horodaté serveur, IMMUABLE ensuite (aucun mutateur) : null = jamais sollicité.
   */
  private _urgentRepair: UrgentRepairRequest | null = null;
  /** PR-08 — site/chantier de rattachement (null = hors site), posé à la composition. */
  private _chantierId: string | null = null;
  /** Révision optimiste — incrémentée par les mutations post-signature (bon de commande). */
  private _revision = 1;

  private constructor(
    id: string,
    readonly companyId: string,
    readonly customerId: string,
    private readonly _validUntil: DateOnly | null,
  ) {
    super(id);
  }

  static compose(input: ComposeQuoteInput): DomainResult<Quote> {
    // PR-08 — identifiant canonique du site quand présent (même hygiène qu'Expense.chantierId).
    const rawChantierId = input.chantierId ?? null;
    let chantierId: string | null = null;
    if (rawChantierId !== null) {
      chantierId = rawChantierId.trim();
      if (!chantierId)
        return err({ code: 'VALIDATION', field: 'chantierId', message: 'Chantier de rattachement invalide.' });
    }
    const q = new Quote(input.id, input.companyId, input.customerId, input.validUntil ?? null);
    q._chantierId = chantierId;
    // Trace de l'urgence : événement DÉDIÉ (en plus du champ horodaté) — le fait légal qui
    // lève l'embargo L221-10 est journalisé à sa naissance, jamais ajouté après coup.
    q._urgentRepair = input.urgentRepair ? { requestedAt: input.urgentRepair.requestedAt } : null;
    q.record({ type: 'QuoteComposed', occurredAt: input.at, version: 1 });
    if (q._urgentRepair)
      q.record({ type: 'QuoteUrgentRepairDeclared', occurredAt: input.at, version: 1 });
    return ok(q);
  }

  get status(): QuoteStatus {
    return this._status;
  }
  get lines(): readonly QuoteLine[] {
    return this._lines;
  }
  get number(): string | null {
    return this._number?.value ?? null;
  }
  get depositPct(): number | null {
    return this._depositPct?.value ?? null;
  }
  get validUntil(): DateOnly | null {
    return this._validUntil;
  }
  /**
   * A1 — date d'établissement du devis (arrêté du 24 janvier 2017 relatif à la publicité des
   * prix des prestations de dépannage/réparation/entretien : le devis porte sa date
   * d'établissement ; exigence générale d'ordre probatoire pour tout devis signé).
   * Null = brouillon jamais envoyé, ou devis legacy envoyé avant l'ajout du champ — JAMAIS
   * rétro-daté : on n'invente pas une date d'établissement a posteriori.
   */
  get issuedAt(): DateOnly | null {
    return this._issuedAt;
  }
  get signature(): Signature | null {
    return this._signature;
  }
  /** A3 — instant de la rétractation en ligne du consommateur (null = jamais exercée). */
  get retractedAt(): Instant | null {
    return this._retractedAt;
  }
  /** Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°) — null = jamais sollicitée. */
  get urgentRepair(): UrgentRepairRequest | null {
    return this._urgentRepair;
  }
  /** PR-08 — site/chantier de rattachement de la pièce ; null = pièce hors site. */
  get chantierId(): string | null {
    return this._chantierId;
  }
  get purchaseOrder(): PurchaseOrderRef | null {
    return this._purchaseOrder;
  }
  /** B3 — remise globale du devis (copie défensive) ; null = aucune. */
  get globalDiscount(): Discount | null {
    return this._globalDiscount ? cloneDiscount(this._globalDiscount) : null;
  }
  /** B5 — taux de retenue de garantie (loi 71-584) ; null = aucune retenue stipulée. */
  get retenueGarantiePct(): number | null {
    return this._retenueGarantiePct;
  }
  get revision(): number {
    return this._revision;
  }

  private assertDraft(): DomainResult<void> {
    if (this._status !== 'draft')
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'draft' });
    return ok(undefined);
  }

  addLine(line: QuoteLine): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
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

  removeLine(lineId: string): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    if (!this._lines.some((l) => l.id === lineId))
      return err({ code: 'VALIDATION', field: 'lineId', message: 'Ligne introuvable.' });
    this._lines = this._lines.filter((l) => l.id !== lineId);
    return ok(undefined);
  }

  /**
   * R6 : édition d'une ligne EXISTANTE (label/qty/unitPriceHT/vatRate/discount), draft
   * uniquement — un devis signé est un contrat (assertDraft, même garde qu'addLine/removeLine).
   * Patch partiel : seuls les champs fournis sont revalidés/remplacés, les autres restent
   * inchangés. B3 : `discount: null` RETIRE la remise de ligne ; absent = inchangée.
   */
  updateLine(
    lineId: string,
    patch: Partial<Pick<LineInput, 'label' | 'qty' | 'unitPriceHT' | 'vatRate'>> & {
      discount?: Discount | null;
    },
  ): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    const index = this._lines.findIndex((l) => l.id === lineId);
    const current = index === -1 ? undefined : this._lines[index];
    if (index === -1 || current === undefined)
      return err({ code: 'VALIDATION', field: 'lineId', message: 'Ligne introuvable.' });
    const allowed = new Set(['label', 'qty', 'unitPriceHT', 'vatRate', 'discount']);
    if (Object.keys(patch).length === 0 || Object.keys(patch).some((key) => !allowed.has(key)))
      return err({
        code: 'VALIDATION',
        field: 'patch',
        message: 'Modification de ligne invalide.',
      });
    if (patch.qty !== undefined) {
      const q = Quantity.of(patch.qty);
      if (!q.ok) return q;
      if (patch.qty > MAX_QUOTE_QTY)
        return err({ code: 'VALIDATION', field: 'qty', message: 'Quantite hors limite.' });
    }
    if (patch.vatRate !== undefined && !isVatRate(patch.vatRate))
      return err({ code: 'VALIDATION', field: 'vatRate', message: 'Taux TVA non autorise.' });
    if (
      patch.unitPriceHT !== undefined &&
      (!Number.isSafeInteger(patch.unitPriceHT) ||
        patch.unitPriceHT < 0 ||
        patch.unitPriceHT > MAX_BILLING_AMOUNT_CENTS)
    )
      return err({ code: 'VALIDATION', field: 'unitPriceHT', message: 'Prix unitaire invalide.' });
    if (
      patch.label !== undefined &&
      (typeof patch.label !== 'string' ||
        patch.label.trim().length === 0 ||
        patch.label.length > 500 ||
        hasBillingControlCharacter(patch.label))
    )
      return err({ code: 'VALIDATION', field: 'label', message: 'Libelle invalide.' });
    const candidate: QuoteLine = {
      id: current.id,
      label: patch.label !== undefined ? patch.label.trim() : current.label,
      category: current.category,
      qty: patch.qty !== undefined ? patch.qty : current.qty,
      ...(current.unit !== undefined ? { unit: current.unit } : {}),
      unitPriceHT: patch.unitPriceHT !== undefined ? patch.unitPriceHT : current.unitPriceHT,
      vatRate: patch.vatRate !== undefined ? patch.vatRate : current.vatRate,
      ...(patch.discount === undefined
        ? current.discount !== undefined
          ? { discount: current.discount }
          : {}
        : patch.discount === null
          ? {}
          : { discount: patch.discount }),
    };
    // B3 — la remise (nouvelle OU conservée) est revalidée contre la base HT RÉSULTANTE de la
    // ligne : baisser qty/prix ne laisse jamais une remise en montant dépasser la nouvelle base.
    // B9 — toujours refusée sur un débours (art. 267, II-2° CGI).
    if (candidate.discount !== undefined) {
      const discount = validateLineDiscount(
        candidate.discount,
        Math.round(candidate.qty * candidate.unitPriceHT),
        candidate.category,
      );
      if (!discount.ok) return discount;
    }
    const nextLines = this._lines.map((line, lineIndex) =>
      lineIndex === index ? candidate : line,
    );
    const totalHtCents = nextLines.reduce(
      (total, line) => total + Math.round(line.qty * line.unitPriceHT),
      0,
    );
    if (!Number.isSafeInteger(totalHtCents) || totalHtCents > MAX_BILLING_AMOUNT_CENTS)
      return err({
        code: 'VALIDATION',
        field: 'lines',
        message: 'Montant total HT du devis hors limite.',
      });
    this._lines[index] = candidate;
    return ok(undefined);
  }

  setDeposit(pct: number | null): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    if (pct === null) {
      this._depositPct = null;
      return ok(undefined);
    }
    const p = Percentage.of(pct);
    if (!p.ok) return p;
    this._depositPct = p.value;
    return ok(undefined);
  }

  /**
   * B3 — remise GLOBALE du devis (% du HT net de lignes, ou montant HT en centimes), draft
   * uniquement (un devis signé est un contrat). `null` retire la remise. Une remise en montant
   * est validée contre le HT net COURANT ; la garde est revérifiée à l'envoi (les lignes
   * peuvent encore bouger en draft — fail-closed au moment où la pièce devient réelle).
   */
  setGlobalDiscount(discount: Discount | null): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    if (discount === null) {
      this._globalDiscount = null;
      return ok(undefined);
    }
    const structural = validateDiscount(discount, 'globalDiscount');
    if (!structural.ok) return structural;
    if (discountEquals(this._globalDiscount, discount)) return ok(undefined);
    if (discount.type === 'amount') {
      // B9 — plafond sur le HT REMISABLE : les débours (art. 267, II-2° CGI) sont hors remise.
      const netHt = discountableNetHtCents(this._lines);
      if (discount.cents > netHt)
        return err({
          code: 'VALIDATION',
          field: 'globalDiscount',
          message:
            'Remise globale supérieure au HT remisable du devis (après remises de ligne, hors débours).',
        });
    }
    this._globalDiscount = cloneDiscount(discount);
    return ok(undefined);
  }

  /**
   * B5 — retenue de garantie du devis-chantier (marché privé de travaux, loi n° 71-584 du
   * 16 juillet 1971), OPTIONNELLE et posée en draft : 0 < taux ≤ 5 % (plafond d'ordre public).
   * `null` retire la stipulation. Reprise par les situations et la finale dérivées, jamais par
   * l'acompte (il précède l'exécution que la retenue garantit).
   */
  setRetenueGarantie(pct: number | null): DomainResult<void> {
    const d = this.assertDraft();
    if (!d.ok) return d;
    if (pct === null) {
      this._retenueGarantiePct = null;
      return ok(undefined);
    }
    const validated = validateRetenueGarantiePct(pct);
    if (!validated.ok) return validated;
    this._retenueGarantiePct = validated.value;
    return ok(undefined);
  }

  /** Le bon de commande n'a de sens que sur un devis encore vivant (le PO arrive souvent APRÈS signature). */
  private assertPurchaseOrderEditable(): DomainResult<void> {
    if (this._status === 'refused' || this._status === 'expired')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message: 'Un devis refusé ou expiré ne porte pas de bon de commande.',
      });
    return ok(undefined);
  }

  /**
   * B8 : attache (ou remplace) le bon de commande client. Idempotent si la référence est
   * identique (aucun événement, révision inchangée). La garde cross-agrégat « remplaçable
   * tant que le devis n'est pas facturé » appartient au use case (elle lit les factures).
   */
  attachPurchaseOrder(ref: PurchaseOrderRef, at: Instant): DomainResult<void> {
    const editable = this.assertPurchaseOrderEditable();
    if (!editable.ok) return editable;
    if (purchaseOrderRefEquals(this._purchaseOrder, ref)) return ok(undefined);
    this._purchaseOrder = clonePurchaseOrderRef(ref);
    this._revision += 1;
    this.record({ type: 'QuotePurchaseOrderAttached', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  /** B8 : retrait EXPLICITE du bon de commande (devis non facturé — garde cross-agrégat au use case). */
  detachPurchaseOrder(at: Instant): DomainResult<void> {
    const editable = this.assertPurchaseOrderEditable();
    if (!editable.ok) return editable;
    if (this._purchaseOrder === null)
      return err({
        code: 'VALIDATION',
        field: 'purchaseOrder',
        message: 'Aucun bon de commande attaché à ce devis.',
      });
    this._purchaseOrder = null;
    this._revision += 1;
    this.record({ type: 'QuotePurchaseOrderDetached', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  totals(): Totals {
    return computeTotals([...this._lines], {
      ...(this._depositPct ? { depositPct: this._depositPct.value } : {}),
      ...(this._globalDiscount ? { globalDiscount: this._globalDiscount } : {}),
    });
  }

  /** Pure : valide et fige le numéro alloué par le use case (no-gap garanti côté infra). */
  assignNumber(n: DocNumber, at: Instant): DomainResult<void> {
    if (this._number)
      return err({ code: 'VALIDATION', field: 'number', message: 'Numero deja attribue.' });
    this._number = n;
    this.record({ type: 'DocumentNumbered', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  send(at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'sent');
    if (!t.ok) return t;
    if (!this._number)
      return err({ code: 'VALIDATION', field: 'number', message: 'Numero requis avant envoi.' });
    if (this._lines.length === 0)
      return err({ code: 'VALIDATION', field: 'lines', message: 'Au moins une ligne requise.' });
    // B3 — garde AUTORITAIRE au moment où la pièce devient réelle : une remise globale en
    // montant ne peut excéder le HT REMISABLE (les lignes ont pu bouger depuis la saisie ;
    // B9 — les débours, art. 267, II-2° CGI, restent hors remise).
    if (this._globalDiscount?.type === 'amount') {
      const netHt = discountableNetHtCents(this._lines);
      if (this._globalDiscount.cents > netHt)
        return err({
          code: 'VALIDATION',
          field: 'globalDiscount',
          message:
            'Remise globale supérieure au HT remisable du devis (après remises de ligne, hors débours).',
        });
    }
    this._status = 'sent';
    // A1 : la date d'établissement est DÉRIVÉE de l'instant d'envoi, au jour métier
    // Europe/Paris (même calendrier que l'exercice de numérotation, cf. SendQuote) —
    // jamais saisie librement, jamais réécrite (send n'est atteignable qu'une fois).
    this._issuedAt = parisDateOnly(at);
    this.record({ type: 'QuoteSent', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  markViewed(at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'viewed');
    if (!t.ok) return t;
    this._status = 'viewed';
    this.record({ type: 'QuoteViewed', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  sign(signature: Signature, at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'signed');
    if (!t.ok) return t;
    this._status = 'signed';
    this._signature = signature;
    this.record({ type: 'QuoteSigned', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  /**
   * A3 — enregistre la rétractation du consommateur (fonctionnalité en ligne, L221-21). Ne vaut
   * que pour un devis SIGNÉ (le droit naît de la conclusion du contrat) et une seule fois.
   * La validation du délai (L221-18/L221-19) et de la qualité de consommateur appartient au use
   * case (onlineRetractationAvailability) : l'agrégat n'enregistre qu'un fait déjà validé.
   */
  retract(at: Instant): DomainResult<void> {
    if (this._status !== 'signed' || this._signature === null)
      return err({ code: 'VALIDATION', field: 'status', message: 'Seul un devis signé peut être rétracté.' });
    if (this._retractedAt !== null)
      return err({ code: 'VALIDATION', field: 'retractedAt', message: 'Rétractation déjà enregistrée.' });
    this._retractedAt = at;
    this.record({ type: 'QuoteRetracted', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  refuse(at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'refused');
    if (!t.ok) return t;
    this._status = 'refused';
    this.record({ type: 'QuoteRefused', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  markExpired(at: Instant): DomainResult<void> {
    const t = assertTransition(QUOTE_TRANSITIONS, this._status, 'expired');
    if (!t.ok) return t;
    this._status = 'expired';
    this.record({ type: 'QuoteExpired', occurredAt: at, version: 1 });
    return ok(undefined);
  }

  // ——— Persistance (réhydratation depuis la base, sans rejouer les invariants/events) ———
  toSnapshot(): QuoteSnapshot {
    return {
      id: this.id,
      companyId: this.companyId,
      customerId: this.customerId,
      status: this._status,
      lines: this._lines.map((l) => ({ ...l })),
      number: this._number?.value ?? null,
      depositPct: this._depositPct?.value ?? null,
      validUntil: this._validUntil,
      issuedAt: this._issuedAt,
      signature: this._signature,
      retractedAt: this._retractedAt,
      urgentRepair: this._urgentRepair ? { ...this._urgentRepair } : null,
      purchaseOrder: this._purchaseOrder ? clonePurchaseOrderRef(this._purchaseOrder) : null,
      globalDiscount: this._globalDiscount ? cloneDiscount(this._globalDiscount) : null,
      retenueGarantiePct: this._retenueGarantiePct,
      chantierId: this._chantierId,
      revision: this._revision,
    };
  }

  static rehydrate(s: QuoteSnapshot): Quote {
    const q = new Quote(s.id, s.companyId, s.customerId, s.validUntil);
    q._status = s.status;
    q._lines = s.lines.map((l) => ({ ...l }));
    // Compat ascendante : les snapshots antérieurs à B8 n'ont ni purchaseOrder ni revision.
    q._purchaseOrder = s.purchaseOrder ? clonePurchaseOrderRef(s.purchaseOrder) : null;
    // Compat ascendante B3/B5 : snapshots antérieurs sans remise globale ni retenue (null honnête).
    q._globalDiscount = s.globalDiscount ? cloneDiscount(s.globalDiscount) : null;
    q._retenueGarantiePct = s.retenueGarantiePct ?? null;
    q._revision = s.revision ?? 1;
    // Compat ascendante A1 : un devis envoyé avant l'ajout du champ reste sans date
    // d'établissement (null honnête, jamais rétro-daté depuis createdAt).
    q._issuedAt = s.issuedAt ?? null;
    if (s.number) {
      const n = DocNumber.of(s.number);
      if (n.ok) q._number = n.value;
    }
    if (s.depositPct !== null) {
      const p = Percentage.of(s.depositPct);
      if (p.ok) q._depositPct = p.value;
    }
    q._signature = s.signature;
    // Compat ascendante A3 : snapshots antérieurs sans rétractation en ligne (null honnête).
    q._retractedAt = s.retractedAt ?? null;
    // Compat ascendante : snapshots antérieurs sans exception dépannage urgent (null honnête —
    // fail-closed : l'embargo L221-10 reste plein, jamais une urgence inventée).
    q._urgentRepair = s.urgentRepair ? { requestedAt: s.urgentRepair.requestedAt } : null;
    // Compat ascendante PR-08 : snapshots antérieurs sans site (null honnête, jamais inventé).
    q._chantierId = s.chantierId ?? null;
    return q;
  }
}

export interface QuoteSnapshot {
  id: string;
  companyId: string;
  customerId: string;
  status: QuoteStatus;
  lines: QuoteLine[];
  number: string | null;
  depositPct: number | null;
  validUntil: DateOnly | null;
  signature: Signature | null;
  /** B8 — optionnels : les snapshots antérieurs restent lisibles (compat ascendante). */
  purchaseOrder?: PurchaseOrderRef | null;
  /** B3 — optionnel : remise globale absente des snapshots antérieurs (compat ascendante). */
  globalDiscount?: Discount | null;
  /** B5 — optionnel : taux de retenue de garantie absent des snapshots antérieurs. */
  retenueGarantiePct?: number | null;
  revision?: number;
  /** A1 — optionnel : date d'établissement absente des snapshots antérieurs (jamais rétro-datée). */
  issuedAt?: DateOnly | null;
  /** A3 — optionnel : rétractation en ligne absente des snapshots antérieurs (jamais inventée). */
  retractedAt?: Instant | null;
  /** Optionnel : exception dépannage urgent absente des snapshots antérieurs (jamais inventée). */
  urgentRepair?: UrgentRepairRequest | null;
  /** PR-08 — optionnel : site absent des snapshots antérieurs (null honnête, jamais inventé). */
  chantierId?: string | null;
}
