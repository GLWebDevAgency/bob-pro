import { describe, expect, it } from 'vitest';
import {
  deriveQuoteInvoiceCtaState,
  mergeLinkedInvoices,
  reconcileLinkedInvoicesEcho,
  type QuoteInvoiceLinksState,
} from './quote-invoice-actions.logic';

const NONE: QuoteInvoiceLinksState = {
  hasDepositInvoice: false,
  hasFinalInvoice: false,
  depositStatus: null,
  finalStatus: null,
};

const FINAL_ECHO: QuoteInvoiceLinksState = {
  ...NONE,
  hasFinalInvoice: true,
  finalStatus: 'draft',
};

describe('mergeLinkedInvoices', () => {
  it('la source durable prime, l’écho ne comble que ce que le serveur n’a pas encore vu', () => {
    expect(mergeLinkedInvoices(NONE, FINAL_ECHO)).toEqual(FINAL_ECHO);
    const durable: QuoteInvoiceLinksState = {
      ...NONE,
      hasFinalInvoice: true,
      finalStatus: 'issued',
    };
    expect(mergeLinkedInvoices(durable, FINAL_ECHO)).toEqual(durable);
  });
});

describe('reconcileLinkedInvoicesEcho', () => {
  it('rend l’écho INTACT (même référence) tant que le serveur n’a pas confirmé', () => {
    expect(reconcileLinkedInvoicesEcho(FINAL_ECHO, NONE)).toBe(FINAL_ECHO);
    expect(reconcileLinkedInvoicesEcho(NONE, NONE)).toBe(NONE);
  });

  it('efface l’écho d’une pièce dès que la source durable la confirme', () => {
    const durable: QuoteInvoiceLinksState = {
      ...NONE,
      hasFinalInvoice: true,
      finalStatus: 'draft',
    };
    expect(reconcileLinkedInvoicesEcho(FINAL_ECHO, durable)).toEqual(NONE);
  });

  it('n’efface que la pièce confirmée — l’écho de l’autre pièce survit', () => {
    const echo: QuoteInvoiceLinksState = {
      hasDepositInvoice: true,
      depositStatus: 'draft',
      hasFinalInvoice: true,
      finalStatus: 'draft',
    };
    const durable: QuoteInvoiceLinksState = {
      ...NONE,
      hasDepositInvoice: true,
      depositStatus: 'draft',
    };
    expect(reconcileLinkedInvoicesEcho(echo, durable)).toEqual(FINAL_ECHO);
  });

  it('badge fantôme (terrain) : générer → confirmation serveur → suppression du brouillon = CTA revenu au choix initial', () => {
    // 1. Génération : écho local immédiat, serveur encore muet — le CTA affiche le brouillon.
    let echo = FINAL_ECHO;
    let durable = NONE;
    expect(deriveQuoteInvoiceCtaState(mergeLinkedInvoices(durable, echo))).toBe(
      'final_draft_pending',
    );
    // 2. Le refetch confirme la pièce : l'écho s'efface, l'affichage ne change pas.
    durable = { ...NONE, hasFinalInvoice: true, finalStatus: 'draft' };
    echo = reconcileLinkedInvoicesEcho(echo, durable);
    expect(deriveQuoteInvoiceCtaState(mergeLinkedInvoices(durable, echo))).toBe(
      'final_draft_pending',
    );
    // 3. Suppression du brouillon (refetch attendu par useDeleteDraftInvoice) : plus de pièce
    //    liée — le CTA REDEVIENT « Générer la facture », plus jamais de badge fantôme.
    durable = NONE;
    echo = reconcileLinkedInvoicesEcho(echo, durable);
    expect(deriveQuoteInvoiceCtaState(mergeLinkedInvoices(durable, echo))).toBe(
      'choose_first_invoice',
    );
  });
});
