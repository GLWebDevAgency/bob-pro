import { describe, it, expect } from 'vitest';
import {
  startDevis,
  devisEdit,
  devisNext,
  devisBack,
  DEVIS_STEPS,
  type DevisFlowState,
} from './devis';
import { CreateQuote } from '../application/billing/create-quote';
import { SendQuote } from '../application/billing/send-quote';
import { SignQuote } from '../application/billing/sign-quote';
import { makeEnv } from '../application/billing/in-memory-env';

function expectOk<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`attendu ok, reçu ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('flows/devis (C21 redécoupe — le wizard s’ARRÊTE au devis, jamais de facture enchaînée)', () => {
  it('déroule client → lignes → TVA → acompte(config) → signature(sur place) → recap, puis le devis signé porte le net d’acompte 488,40 — AUCUNE facture n’est créée par ce flow', async () => {
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
      tvaContext: { housingOlderThan2y: true, energyRenovation: false },
      vatRate: 10,
    });
    s = expectOk(devisNext(s));
    expect(s.step).toBe('tvaMentions');

    // Étape 3 — TVA/mentions, puis étape 4 — ACOMPTE : le % contractuel, décidé AVANT la
    // signature (une clause du devis, pas une facture).
    s = expectOk(devisNext(s));
    expect(s.step).toBe('acompte');
    s = expectOk(devisNext(s)); // 30 % par défaut, aucune saisie requise
    expect(s.step).toBe('signature');

    // Étape 5 — signature : sans mode choisi, pas d'avance ; « sur place » exige aussi le nom.
    expect(devisNext(s).ok).toBe(false);
    s = devisEdit(s, { signMode: 'onsite' });
    expect(devisNext(s).ok).toBe(false); // signerName manquant
    s = devisEdit(s, { signerName: 'M. Bernard' });
    s = expectOk(devisNext(s));
    expect(s.step).toBe('recap');
    expect(devisNext(s).ok).toBe(false); // terminal
    expect(devisBack(s).ok).toBe(false); // le devis envoyé/signé ne se « dé-crée » pas

    // Exécution réelle — le flow n'a RIEN calculé : les use-cases font foi. La chaîne
    // s'ARRÊTE à SignQuote : aucun GenerateInvoiceFromQuote/IssueInvoice n'est appelé ici,
    // c'est précisément le redécoupe (la facture vit sur son chemin officiel post-signature).
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
      await new SendQuote({
        companies: env.companyRepo,
        quotes: env.quoteRepo,
        counters: env.counters,
        uow: env.uow,
        clock: env.clock,
      }).execute({
        quoteId: created.quoteId,
      }),
    );
    expectOk(
      await new SignQuote({
        companies: env.companyRepo,
        customers: env.customerRepo,
        quotes: env.quoteRepo,
        publicAccessTokens: env.publicAccessTokens,
        uow: env.uow,
        clock: env.clock,
      }).execute({
        quoteId: created.quoteId,
        signerName: s.draft.signerName!,
      }),
    );

    const quote = await env.quoteRepo.findById(created.quoteId);
    expect(quote?.status).toBe('signed');
    expect(quote?.depositPct).toBe(30);
    expect(quote?.totals().netToPay).toBe(48840); // acompte 30 % de 1 628,00 € TTC = 488,40 €
    expect(await env.invoiceRepo.listByCompany(env.company.id)).toHaveLength(0); // aucune facture, jamais
  });

  it('signature à distance : « envoyer » n’exige ni pad ni nom — le devis reste à signer, jamais proposé à la facturation par ce flow', () => {
    let s = startDevis();
    s = devisEdit(s, {
      customerId: 'c1',
      lines: [{ label: 'X', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 }],
      tvaContext: { housingOlderThan2y: false, energyRenovation: false },
      vatRate: 20,
    });
    s = expectOk(devisNext(s)); // client -> lignes
    s = expectOk(devisNext(s)); // lignes -> tvaMentions
    s = expectOk(devisNext(s)); // tvaMentions -> acompte
    s = expectOk(devisNext(s)); // acompte -> signature
    s = devisEdit(s, { signMode: 'remote' });
    s = expectOk(devisNext(s)); // signature -> recap, sans signerName
    expect(s.step).toBe('recap');
    expect(s.draft.signerName).toBeNull();
  });

  it('permet la correction en arrière mais jamais de sauter une étape', () => {
    let s = startDevis();
    s = devisEdit(s, { customerId: 'c1' });
    s = expectOk(devisNext(s)); // lignes
    const back = expectOk(devisBack(s));
    expect(back.step).toBe('client');
    expect(DEVIS_STEPS.indexOf('recap')).toBe(DEVIS_STEPS.length - 1);
    expect(DEVIS_STEPS.indexOf('acompte')).toBeLessThan(DEVIS_STEPS.indexOf('signature')); // acompte AVANT signature
  });

  it('refuse de quitter l’étape TVA tant qu’aucun taux n’a été confirmé', () => {
    let s = startDevis();
    s = devisEdit(s, {
      customerId: 'c1',
      lines: [{ label: 'X', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 }],
    });
    s = expectOk(devisNext(s));
    s = expectOk(devisNext(s));
    const blocked = devisNext(s);
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'vatRate' },
    });
  });

  it('ne confond jamais contexte fiscal et taux confirmé', () => {
    let s = startDevis();
    s = devisEdit(s, {
      customerId: 'c1',
      lines: [{ label: 'X', category: 'labor', qty: 1, unitPriceHT: 10000, vatRate: 20 }],
      tvaContext: { housingOlderThan2y: false, energyRenovation: false },
      vatRate: null,
    });
    s = expectOk(devisNext(s));
    s = expectOk(devisNext(s));
    expect(devisNext(s)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'vatRate' },
    });
  });
});
