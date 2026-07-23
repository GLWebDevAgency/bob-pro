import { type Result, ok, err } from '../../shared-kernel/result';
import type { DateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { computeLineBases } from '../../domain/services/compute-totals';
import {
  billedTtcCents,
  quoteBillingEngagement,
  validateSituationVatClosure,
} from '../../domain/services/quote-billing-engagement';
import { internationalProEmissionGuard } from '../../domain/services/international-emission-guard';
import { professionalAdvanceRecoveryGuard } from '../../domain/compliance/professional-advance-recovery';
import {
  deriveRetractation,
  offPremisesEmbargoOverrideRisk,
  offPremisesPaymentEmbargo,
  offPremisesPaymentEmbargoMessage,
  retractationFreeze,
  retractationFreezeMessage,
} from '../../domain/compliance/retractation';
import {
  type QuoteRepository,
  type InvoiceRepository,
  type CustomerRepository,
} from '../ports/repositories';
import {
  type ClockPort,
  type EmbargoOverrideAuditPort,
  type IdGeneratorPort,
} from '../ports/services';

export interface GenerateInvoiceDeps {
  quotes: QuoteRepository;
  invoices: InvoiceRepository;
  /** A3 — le type du client (b2c) et la signature décident du gel de rétractation. */
  customers: Pick<CustomerRepository, 'findById'>;
  ids: IdGeneratorPort;
  /** A3 — « maintenant » du gel : le délai est comparé à l'horloge injectée, jamais Date.now(). */
  clock: ClockPort;
  /**
   * Journal de l'override L221-10 — FAIL-CLOSED : sans port câblé, `embargoOverride` est
   * refusé comme un embargo ordinaire (jamais d'override sans trace écrite).
   */
  audit?: EmbargoOverrideAuditPort;
}

/** B2 — montant d'une situation : avancement en % du marché, OU montant HT en centimes. */
export type SituationAmountInput = { percent: number } | { amountHtCents: number };

export interface GenerateInvoiceInput {
  quoteId: string;
  mode: 'deposit' | 'final' | 'situation';
  /**
   * B2 — REQUIS quand mode = 'situation' (interdit sinon) : l'avancement facturé, en % du
   * marché ({ percent }) ou en montant HT centimes ({ amountHtCents }) — la pratique des
   * marchés privés stipule les situations en HT, la TVA en découle par taux. Le montant est
   * TOUJOURS le choix de l'artisan (proposeSituationFromChantier ne fait que proposer).
   */
  situation?: SituationAmountInput;
  /**
   * Override RESPONSABILISÉ de l'embargo L221-10 — flag EXPLICITE uniquement (`true` strict,
   * jamais implicite) : l'artisan a vu le risque concret (contrat annulable, remboursement
   * exigible) et l'a confirmé dans la feuille dédiée. L'événement payment.embargo_overridden
   * est journalisé AVANT de produire la pièce. Ne lève JAMAIS le gel de rétractation de la
   * facture finale (protection du CLIENT, non contournable) ni un devis rétracté.
   */
  embargoOverride?: boolean;
}

/** Génère la facture (acompte, situation d'avancement B2, ou finale) depuis un devis signé. */
export class GenerateInvoiceFromQuote {
  constructor(private readonly deps: GenerateInvoiceDeps) {}

  async execute(input: GenerateInvoiceInput): Promise<Result<{ invoiceId: string }, AppError>> {
    const quote = await this.deps.quotes.findById(input.quoteId);
    if (!quote) return err(appNotFound('quote', input.quoteId));

    const mode = input.mode;
    const kind: 'deposit' | 'final' | 'situation' = mode;
    // B2 — le montant de situation accompagne SON mode, jamais un autre (frontière stricte).
    if (mode === 'situation' && input.situation === undefined)
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'situation',
          message: 'Montant de situation requis (% du marché ou montant HT en centimes).',
        }),
      );
    if (mode !== 'situation' && input.situation !== undefined)
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'situation',
          message: 'Le montant de situation ne concerne que le mode situation.',
        }),
      );
    if (quote.status !== 'signed')
      return err(appDomain({ code: 'VALIDATION', field: 'quote', message: 'Le devis doit etre signe.' }));

    // Idempotence par (devis, kind) pour acompte et finale — les SITUATIONS sont par nature
    // multiples sur un même devis : chaque appel en crée une nouvelle (n° d'ordre suivant).
    if (mode !== 'situation') {
      const existing = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, kind);
      if (existing) return ok({ invoiceId: existing.id });
    }

    // A3 — un contrat RÉTRACTÉ (fonctionnalité en ligne, art. L221-21 c. conso) ne produit plus
    // aucune pièce : ni acompte ni finale (le remboursement relève de l'avoir, flux dédié).
    if (quote.retractedAt !== null) {
      return err(
        appDomain({
          code: 'QUOTE_RETRACTED',
          quoteId: quote.id,
          message:
            'Le client a exercé son droit de rétractation sur ce devis (art. L221-18 s. du code ' +
            'de la consommation) : aucune facture ne peut en être générée.',
        }),
      );
    }

    // La qualité du client à la CONCLUSION (Signature.customerType, figée par SignQuote) et la
    // signature décident des deux gardes légales ci-dessous. Fail-closed : sans client prouvé
    // dans le tenant, impossible de connaître le régime — on refuse au lieu de facturer dans le
    // doute (le type courant reste le fallback des signatures antérieures au figeage).
    const customer = await this.deps.customers.findById(quote.customerId);
    if (!customer || customer.companyId !== quote.companyId)
      return err(appNotFound('customer', quote.customerId));
    const now = this.deps.clock.now();

    // B6 — client PROFESSIONNEL établi hors de France : aucune pièce n'est produite (la TVA
    // intracom/export n'est pas encore gérée — une TVA française serait fiscalement fausse).
    // Fail-closed, pas d'override : protège l'intégrité fiscale de l'artisan.
    const international = internationalProEmissionGuard(customer);
    if (!international.ok) return err(appDomain(international.error));

    // L221-10 — contrat HORS ÉTABLISSEMENT (signature `onsite_draw` chez le client, ou
    // `legacy_declared` fail-closed) avec un CONSOMMATEUR : AUCUN paiement ne peut être reçu
    // pendant 7 jours à compter de la conclusion — l'ACOMPTE COMPRIS (« aucun paiement ou
    // aucune contrepartie, sous quelque forme que ce soit »). Émettre une pièce exigible,
    // c'est demander un paiement : acompte ET finale sont bloqués pendant la fenêtre. Le
    // contrat À DISTANCE (`remote_link`) n'est pas visé par L221-10 (aucun embargo). Sanction
    // du manquement : nullité du contrat (art. L242-1 ; Civ. 1re, 20/12/2023, n° 22-13.014).
    // Exception L221-10, al. 2 : intervention urgente sollicitée et TRACÉE à la création du
    // devis → pas d'embargo. Sans trace : fail-closed, embargo plein.
    const embargo = offPremisesPaymentEmbargo(
      { customerType: customer.type, signature: quote.signature, urgentRepair: quote.urgentRepair },
      now,
    );
    if (embargo.active) {
      if (input.embargoOverride === true && this.deps.audit !== undefined) {
        // Override responsabilisé : l'artisan informé assume — TRACÉ AVANT la pièce (si le
        // journal échoue, l'action échoue : jamais d'override silencieux ; port absent →
        // refus fail-closed dans la branche else).
        await this.deps.audit.embargoOverridden({
          type: 'payment.embargo_overridden',
          quoteId: quote.id,
          companyId: quote.companyId,
          invoiceKind: kind,
          embargoExpiresAt: embargo.expiresAt,
          occurredAt: now,
        });
      } else {
        return err(
          appDomain({
            code: 'OFF_PREMISES_PAYMENT_EMBARGO',
            quoteId: quote.id,
            expiresAt: embargo.expiresAt,
            availableFrom: embargo.availableFrom,
            message: offPremisesPaymentEmbargoMessage(embargo.availableFrom),
            overridable: true,
            overrideRisk: offPremisesEmbargoOverrideRisk(embargo.availableFrom),
          }),
        );
      }
    }

    // A3 — GEL LÉGAL de la FACTURE FINALE (et des SITUATIONS, B2 : une situation demande le
    // paiement de travaux EXÉCUTÉS — non payables sans demande expresse d'exécution anticipée,
    // art. L221-25 c. conso ; lecture prudente, jamais permissive) pendant le délai de
    // rétractation d'un devis B2C signé via l'app (contrat à distance ou hors établissement,
    // art. L221-18 s. c. conso), sauf demande d'exécution anticipée tracée à la signature
    // (art. L221-25). B2B/B2G : rien ne change. L'ACOMPTE reste facturable hors embargo
    // L221-10 ci-dessus (contrat à distance : la loi n'interdit pas l'acompte ; l'app
    // n'invente pas une interdiction non écrite).
    if (mode === 'final' || mode === 'situation') {
      const freeze = retractationFreeze(
        deriveRetractation({ customerType: customer.type, signature: quote.signature }),
        now,
      );
      if (freeze.active) {
        return err(
          appDomain({
            code: 'RETRACTATION_PERIOD_ACTIVE',
            quoteId: quote.id,
            expiresAt: freeze.expiresAt,
            availableFrom: freeze.availableFrom,
            message: retractationFreezeMessage(freeze.availableFrom),
          }),
        );
      }
    }

    // Pièces SŒURS du devis (source UNIQUE quoteBillingEngagement, partagée avec IssueInvoice) :
    // déduction de la finale (A5), garde de cumul des situations (B2) ET garde « marché soldé »
    // ci-dessous — lue pour TOUS les modes (l'acompte aussi est une pièce d'appel).
    const engagement = quoteBillingEngagement(
      await this.deps.invoices.listByCompany(quote.companyId),
      quote.id,
    );
    const alreadyInvoiced = engagement.engaged;

    // INVIOLABLE (P0) — le marché signé ne se refacture jamais au-delà de 100 % : dès qu'une
    // facture FINALE vit sur ce devis, plus AUCUNE pièce d'appel (acompte, situation) n'est
    // générée. Brouillon : la finale appelle déjà le solde (générer une situation la rendrait
    // fausse) ; émise : le marché est soldé — la TVA étant exigible sur chaque pièce émise
    // (art. 283 du CGI), toute pièce supplémentaire serait une facture indue. La même garde
    // est REVÉRIFIÉE à l'émission (IssueInvoice) : un brouillon dormant ne la contourne pas.
    if (mode === 'deposit' || mode === 'situation') {
      const final = engagement.finals[0];
      if (final !== undefined) {
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'invoice',
            message:
              final.status === 'draft'
                ? 'Une facture finale (solde) en brouillon existe déjà sur ce devis : émets-la ' +
                  'ou supprime-la avant de créer une nouvelle pièce — le solde qu’elle appelle ' +
                  'doit rester exact.'
                : 'La facture finale de ce devis est émise : le marché est soldé, aucune ' +
                  'nouvelle pièce ne peut être générée (une rectification passe par un avoir).',
          }),
        );
      }
    }

    // B2 — SITUATION DE TRAVAUX : montant choisi (jamais imposé), n° d'ordre par devis, garde
    // de CUMUL acompte + situations ≤ marché (brouillons de situation INCLUS : une situation
    // créée réserve sa part — lecture prudente, un brouillon supprimé libère la sienne).
    if (mode === 'situation') {
      const situationInput = input.situation!;
      const { netLineBases } = computeLineBases(quote.lines, {
        globalDiscount: quote.globalDiscount,
      });
      const marcheHt = netLineBases.reduce((sum, base) => sum + base, 0);
      let targetHtCents: number;
      if ('percent' in situationInput) {
        const percent = situationInput.percent;
        if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
          return err(
            appDomain({
              code: 'VALIDATION',
              field: 'situation',
              message: "Pourcentage d'avancement invalide (0 < % ≤ 100).",
            }),
          );
        targetHtCents = Math.round((marcheHt * percent) / 100);
      } else {
        targetHtCents = situationInput.amountHtCents;
      }
      // N° d'ordre MONOTONE (max + 1, tout statut — jamais réutilisé, annulées comprises) :
      // l'index unique partiel uniq_invoice_parent_quote_situation_order (backstop base) fait
      // échouer la 2e insertion d'une génération CONCURRENTE — la garde de cumul ci-dessous
      // est un read-then-write, seule la base tranche la course (l'API traduit en conflit).
      const order = engagement.nextSituationOrder;
      const created = Invoice.situationFromSignedQuote(quote, this.deps.ids.newId(), {
        order,
        targetHtCents,
      });
      if (!created.ok) return err(appDomain(created.error));

      const marcheTtc = quote.totals().ttc;
      const engagedTtc = alreadyInvoiced.reduce((sum, i) => sum + billedTtcCents(i), 0);
      const newTtc = created.value.totals().ttc;
      if (engagedTtc + newTtc > marcheTtc) {
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'situation',
            message:
              `Cumul acompte + situations supérieur au marché : déjà engagé ${engagedTtc} c sur ` +
              `${marcheTtc} c TTC — reste facturable ${Math.max(0, marcheTtc - engagedTtc)} c.`,
          }),
        );
      }

      await this.deps.invoices.save(created.value);
      return ok({ invoiceId: created.value.id });
    }

    // Facture FINALE : TOUT ce qui a déjà été facturé sur ce devis (acompte ET situations
    // ÉMISES — situations successives BTP, A5) est déduit du net à payer. Le flow reste
    // corrélé de bout en bout : devis → acompte → situations → solde exact.
    let depositDeduction: { amountCents: number; invoiceId: string | null } | undefined;
    let situationDeductionCents = 0;
    let situationBilledHtCents = 0;
    let advanceDeductionCents = 0;
    let situationBilledByQuoteLineCents: Readonly<Record<string, number>> | undefined;
    let precedingInvoices:
      { invoiceId: string; kind: 'deposit' | 'situation'; number: string; issuedAt: DateOnly }[] = [];
    if (mode === 'final') {
      // Seules les pièces ÉMISES se déduisent (un brouillon de situation n'a pas d'effet fiscal).
      const emitted = alreadyInvoiced.filter((i) => i.status !== 'draft');
      const emittedSituations = emitted.filter((i) => i.kind === 'situation');
      const amountCents = emitted.reduce((sum, i) => sum + billedTtcCents(i), 0);
      situationDeductionCents = emittedSituations.reduce(
        (sum, invoice) => sum + billedTtcCents(invoice),
        0,
      );
      advanceDeductionCents = amountCents - situationDeductionCents;
      situationBilledHtCents = emittedSituations.reduce(
        (sum, invoice) => sum + invoice.totals().ht,
        0,
      );

      // Une finale après situations ne peut pas reposer sur un prorata global : avec plusieurs
      // taux ou postes, cela déplacerait silencieusement du CA/TVA entre les lignes du devis.
      // Chaque ligne de situation V2 porte donc son lien immuable vers le poste contractuel ;
      // un historique sans ce lien reste consultable mais sa finale est bloquée honnêtement.
      if (emittedSituations.length > 0) {
        const quoteLineIds = new Set(quote.lines.map((line) => line.id));
        const billedByQuoteLine: Record<string, number> = {};
        for (const situation of emittedSituations) {
          const bases = computeLineBases(situation.lines, {
            globalDiscount: situation.globalDiscount,
          }).netLineBases;
          const recomputedHt = bases.reduce((sum, amount) => sum + amount, 0);
          if (recomputedHt !== situation.totals().ht) {
            return err(
              appDomain({
                code: 'VALIDATION',
                field: 'situation',
                message:
                  'Une situation antérieure ne retrouve pas sa ventilation HT figée ; le solde ne peut pas être préparé.',
              }),
            );
          }
          for (const [index, line] of situation.lines.entries()) {
            const sourceId = line.sourceQuoteLineId;
            if (sourceId === undefined || !quoteLineIds.has(sourceId)) {
              return err(
                appDomain({
                  code: 'VALIDATION',
                  field: 'situation.sourceQuoteLineId',
                  message:
                    'Une situation antérieure ne référence pas précisément ses lignes de devis ; le solde doit être régularisé avant émission.',
                }),
              );
            }
            billedByQuoteLine[sourceId] =
              (billedByQuoteLine[sourceId] ?? 0) + (bases[index] ?? 0);
          }
        }
        situationBilledByQuoteLineCents = billedByQuoteLine;
      }
      if (amountCents > 0) {
        const incompleteSource = emitted.find(
          (invoice) => invoice.number === null || invoice.issuedAt === null,
        );
        if (incompleteSource) {
          return err(
            appDomain({
              code: 'VALIDATION',
              field: 'invoice',
              message:
                'Une pièce antérieure émise ne possède pas sa référence légale complète ; le solde ne peut pas être préparé.',
            }),
          );
        }
        precedingInvoices = emitted.map((invoice) => ({
          invoiceId: invoice.id,
          kind: invoice.kind as 'deposit' | 'situation',
          number: invoice.number!,
          issuedAt: invoice.issuedAt!,
        }));
        // Réf de nav : la pièce source si UNIQUE — composite (plusieurs pièces) sinon.
        depositDeduction = {
          amountCents,
          invoiceId: emitted.length === 1 ? (emitted[0]?.id ?? null) : null,
        };
      }
    }

    const advancePath = professionalAdvanceRecoveryGuard({
      customerType: customer.type,
      invoiceKind: mode,
      advanceDeductionCents,
    });
    if (!advancePath.ok) return err(appDomain(advancePath.error));

    const created = Invoice.fromSignedQuote(
      quote,
      mode,
      this.deps.ids.newId(),
      depositDeduction
        ? {
            depositDeduction,
            situationDeductionCents,
            situationBilledHtCents,
            ...(situationBilledByQuoteLineCents === undefined
              ? {}
              : { situationBilledByQuoteLineCents }),
            ...(precedingInvoices.length === 0 ? {} : { precedingInvoices }),
          }
        : undefined,
    );
    if (!created.ok) return err(appDomain(created.error));

    if (mode === 'final') {
      const emittedSituations = alreadyInvoiced.filter(
        (invoice) => invoice.kind === 'situation' && invoice.status !== 'draft',
      );
      const vatClosure = validateSituationVatClosure({
        marketTotals: quote.totals(),
        emittedSituations,
        finalInvoice: created.value,
      });
      if (!vatClosure.ok) return err(appDomain(vatClosure.error));
    }

    try {
      await this.deps.invoices.save(created.value);
    } catch (e) {
      const raced = await this.deps.invoices.findByParentQuoteId(quote.companyId, quote.id, kind);
      if (raced) return ok({ invoiceId: raced.id });
      throw e;
    }
    return ok({ invoiceId: created.value.id });
  }
}
