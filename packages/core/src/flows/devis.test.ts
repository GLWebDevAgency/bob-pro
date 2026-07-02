import { describe, it, expect } from 'vitest';
import { startDevis, devisEdit, devisNext, devisBack, DEVIS_STEPS, type DevisFlowState } from './devis';
import { CreateQuote } from '../application/billing/create-quote';
import { SendQuote } from '../application/billing/send-quote';
import { SignQuote } from '../application/billing/sign-quote';
import { GenerateInvoiceFromQuote } from '../application/billing/generate-invoice-from-quote';
import { makeEnv } from '../application/billing/in-memory-env';

function expectOk<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`attendu ok, reçu ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('flows/devis (C21 — 6 étapes, projection des use-cases)', () => {
  it('déroule les 6 étapes avec gardes, puis la facture porte parentQuoteId et acompte net 488,40', async () => {
    const env = makeEnv();
    let s: DevisFlowState = startDevis();
    expect(s.step).toBe('client');
    expect(s.draft.depositPct).toBe(30); // acompte proto par défaut

    // Étape 1 — client : on ne passe pas sans client.
    expect(devisNext(s).ok).toBe(false);
    s = devisEdit(s, { customerId: env.customer.id });
    s = expectOk(devisNext(s));
    expect(s.step).toBe('lignes');

    // Étape 2 — lignes : au moins une prestation.
    expect(devisNext(s).ok).toBe(false);
    s = devisEdit(s, {
      lines: [
        { label: 'Chauffe-eau 200 L', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
        { label: "Main d'oeuvre", category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
      ],
      tvaContext: { housingOlderThan2y: true },
    });
    s = expectOk(devisNext(s));
    expect(s.step).toBe('tvaMentions');

    // Étape 3 — TVA/mentions (décidées par les use-cases) puis étape 4 — signature.
    s = expectOk(devisNext(s));
    expect(s.step).toBe('signature');
    expect(devisNext(s).ok).toBe(false); // pas de signature, pas d'avance
    s = devisEdit(s, { signerName: 'M. Martin' });
    s = expectOk(devisNext(s));
    expect(s.step).toBe('acompte');

    // Étape 5 → 6 : acompte 30 % (défaut proto) → facture.
    s = expectOk(devisNext(s));
    expect(s.step).toBe('facture');
    expect(devisNext(s).ok).toBe(false); // terminal
    expect(devisBack(s).ok).toBe(false); // la facture générée ne se « dé-génère » pas

    // Exécution réelle — le flow n'a RIEN calculé : les use-cases font foi.
    const created = expectOk(
      await new CreateQuote({
        quotes: env.quoteRepo,
        companies: env.companyRepo,
        customers: env.customerRepo,
        ids: env.ids,
        clock: env.clock,
      }).execute({
        companyId: env.company.id,
        customerId: s.draft.customerId!,
        lines: s.draft.lines,
        depositPct: s.draft.depositPct,
        ...(s.draft.tvaContext !== null ? { context: s.draft.tvaContext } : {}),
      }),
    );
    expectOk(
      await new SendQuote({ quotes: env.quoteRepo, counters: env.counters, uow: env.uow, clock: env.clock }).execute({
        quoteId: created.quoteId,
      }),
    );
    expectOk(
      await new SignQuote({ quotes: env.quoteRepo, uow: env.uow, clock: env.clock }).execute({
        quoteId: created.quoteId,
        signerName: s.draft.signerName!,
      }),
    );
    const gen = expectOk(
      await new GenerateInvoiceFromQuote({ quotes: env.quoteRepo, invoices: env.invoiceRepo, ids: env.ids }).execute({
        quoteId: created.quoteId,
      }),
    );

    const invoice = await env.invoiceRepo.findById(gen.invoiceId);
    expect(invoice?.kind).toBe('deposit');
    expect(invoice?.parentQuoteId).toBe(created.quoteId); // nav croisée devis ↔ facture
    expect(invoice?.totals().netToPay).toBe(48840); // acompte 30 % de 1 628,00 € TTC = 488,40 €
  });

  it('permet la correction en arrière mais jamais de sauter une étape', () => {
    let s = startDevis();
    s = devisEdit(s, { customerId: 'c1' });
    s = expectOk(devisNext(s)); // lignes
    const back = expectOk(devisBack(s));
    expect(back.step).toBe('client');
    expect(DEVIS_STEPS.indexOf('facture')).toBe(DEVIS_STEPS.length - 1);
  });
});
