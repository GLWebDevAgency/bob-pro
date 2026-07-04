import { describe, it, expect } from 'vitest';
import { ok, type FiscalDeadline } from '@bob/core';
import { buildBobTools } from './registry';
import { type BobActions } from '../agent/actions';
import { isSafetyFloor, requiresConfirmation, riskTierOf } from '../agent/autonomy';

/** Surface d'actions minimale (hôte legacy type apps/api) : AUCUNE capacité optionnelle. */
const baseActions: BobActions = {
  computePayout: async () => ok({ payoutCents: 1000, availableCents: 2000 }),
  draftRelance: async () => ok({ subject: 's', body: 'b' }),
  listPayableInvoices: async () => ok([]),
  listSendableQuotes: async () => ok([]),
  listIssuableInvoices: async () => ok([]),
  listDocuments: async () => ok([]),
  registerPayment: async () => ok({ status: 'paid' }),
  sendQuote: async () => ok({ number: 'D-1' }),
  issueInvoice: async () => ok({ number: 'F-1' }),
};

/** Hôte complet (mobile / LocalBobClient) : toutes les capacités optionnelles C20 + C40. */
function fullActions(calls: Record<string, unknown[]>): BobActions {
  const track = (name: string, input: unknown) => {
    calls[name] = [...(calls[name] ?? []), input];
  };
  return {
    ...baseActions,
    createQuote: async (input) => (track('createQuote', input), ok({ quoteId: 'q-1' })),
    recordExpense: async (input) => (track('recordExpense', input), ok({ id: 'exp-1' })),
    generateInvoice: async (input) => (track('generateInvoice', input), ok({ invoiceId: 'inv-9' })),
    exportFec: async (input) => (
      track('exportFec', input),
      ok({ filename: '732829320FEC20261231.txt', entryCount: 2, rowCount: 5, warnings: [] })
    ),
    createCustomer: async (input) => (track('createCustomer', input), ok({ id: 'cust-9' })),
  };
}

function tool(actions: BobActions, name: string) {
  return buildBobTools(actions).find((t) => t.name === name);
}

describe('registre par capacités — C40 TODO ⑤⑥ + creer_client', () => {
  it("n'expose PAS les outils optionnels si l'hôte ne fournit pas l'action (rétro-compat apps/api)", () => {
    const names = buildBobTools(baseActions).map((t) => t.name);
    expect(names).not.toContain('generer_facture');
    expect(names).not.toContain('export_fec');
    expect(names).not.toContain('creer_client');
    expect(names).not.toContain('creer_devis');
    expect(names).not.toContain('scan_depense');
  });

  it("expose les outils optionnels quand l'hôte fournit les actions (C20 + C40)", () => {
    const names = buildBobTools(fullActions({})).map((t) => t.name);
    for (const n of ['creer_devis', 'scan_depense', 'generer_facture', 'export_fec', 'creer_client']) {
      expect(names).toContain(n);
    }
  });

  it('generer_facture : palier FISCAL (plancher — confirmation même en auto), deposit/final validés', async () => {
    const calls: Record<string, unknown[]> = {};
    const t = tool(fullActions(calls), 'generer_facture')!;
    expect(riskTierOf(t)).toBe('fiscal');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    expect(t.parse({}).ok).toBe(false); // quoteId manquant
    expect(t.parse({ quoteId: 'q-1', mode: 'partial' }).ok).toBe(false); // mode inconnu
    const parsed = t.parse({ quoteId: 'q-1', mode: 'deposit' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toEqual({ invoiceId: 'inv-9' });
    expect(calls.generateInvoice).toEqual([{ quoteId: 'q-1', mode: 'deposit' }]);
  });

  it('generer_facture : le mode est optionnel (défaut du use case, jamais inventé ici)', () => {
    const t = tool(fullActions({}), 'generer_facture')!;
    const parsed = t.parse({ quoteId: 'q-1' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ quoteId: 'q-1' });
  });

  it('export_fec : lecture réglementée (accounting, non mutante), période stricte YYYY-MM-DD ordonnée', async () => {
    const calls: Record<string, unknown[]> = {};
    const t = tool(fullActions(calls), 'export_fec')!;
    expect(t.mutating).toBe(false);
    expect(riskTierOf(t)).toBe('accounting');
    expect(requiresConfirmation(t, 'confirm_all')).toBe(false); // lecture : jamais de confirmation

    expect(t.parse({ from: '2026-1-1', to: '2026-12-31' }).ok).toBe(false);
    expect(t.parse({ from: '2026-12-31', to: '2026-01-01' }).ok).toBe(false); // période inversée
    const parsed = t.parse({ from: '2026-01-01', to: '2026-12-31' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toMatchObject({ filename: '732829320FEC20261231.txt', entryCount: 2 });
    expect(calls.exportFec).toEqual([{ from: '2026-01-01', to: '2026-12-31' }]);
  });

  it('creer_client : brouillon de carnet (draft, pas de plancher), nom + type stricts', async () => {
    const calls: Record<string, unknown[]> = {};
    const t = tool(fullActions(calls), 'creer_client')!;
    expect(riskTierOf(t)).toBe('draft');
    expect(isSafetyFloor(t)).toBe(false);
    expect(requiresConfirmation(t, 'confirm_outbound')).toBe(false); // interne réversible : direct
    expect(requiresConfirmation(t, 'confirm_all')).toBe(true);

    expect(t.parse({ name: '  ', type: 'b2c' }).ok).toBe(false);
    expect(t.parse({ name: 'Mme Durand', type: 'b2x' }).ok).toBe(false);
    const parsed = t.parse({ name: '  Mme Durand ', type: 'b2c' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toEqual({ id: 'cust-9' });
    expect(calls.createCustomer).toEqual([{ name: 'Mme Durand', type: 'b2c' }]);
  });
});

describe('relance_brouillon ciblable — C25 (TODO ① audit parité C15)', () => {
  function relanceTool(calls: unknown[]) {
    const actions: BobActions = {
      ...baseActions,
      draftRelance: async (input) => {
        calls.push(input);
        return ok({ subject: 's', body: 'b' });
      },
    };
    return tool(actions, 'relance_brouillon')!;
  }

  it('lecture non mutante, cible optionnelle validée strictement (anti-hallucination)', () => {
    const t = relanceTool([]);
    expect(t.mutating).toBe(false);
    expect(riskTierOf(t)).toBe('read');
    expect(requiresConfirmation(t, 'confirm_all')).toBe(false); // lecture : jamais de confirmation

    expect(t.parse({ invoiceId: '' }).ok).toBe(false);
    expect(t.parse({ invoiceId: 42 }).ok).toBe(false);
    expect(t.parse({ customerId: '' }).ok).toBe(false);
    const untargeted = t.parse({});
    expect(untargeted.ok && untargeted.value).toEqual({}); // sans cible : défaut de l'hôte
  });

  it("transmet la cible à l'hôte telle quelle (invoiceId / customerId)", async () => {
    const calls: unknown[] = [];
    const t = relanceTool(calls);
    const byInvoice = t.parse({ invoiceId: 'inv-1' });
    const byCustomer = t.parse({ customerId: 'cust-2' });
    expect(byInvoice.ok && byCustomer.ok).toBe(true);
    if (!byInvoice.ok || !byCustomer.ok) return;
    await t.run(byInvoice.value);
    await t.run(byCustomer.value);
    expect(calls).toEqual([{ invoiceId: 'inv-1' }, { customerId: 'cust-2' }]);
  });
});

describe('echeances_fiscales — C-EXP5b (lecture du calendrier fiscal, capacité optionnelle)', () => {
  const deadlines: FiscalDeadline[] = [
    {
      id: 'cfe-acompte-2026',
      date: '2026-06-15',
      label: 'CFE : acompte (si CFE N-1 ≥ 3 000 €)',
      kind: 'cfe',
      amountHint: null,
      legalRef: 'art. 1679 quinquies CGI',
      confidence: 'assumed',
      explain: "Un acompte de 50 % de CFE n'est dû à cette date que si ta CFE de l'an dernier a atteint 3 000 €.",
    },
  ];

  it("absent sans l'action hôte (pas de capacité fantôme — rétro-compat hôtes existants)", () => {
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain('echeances_fiscales');
  });

  it('lecture pure (read, non mutante, jamais de confirmation) qui DÉLÈGUE au use case de l’hôte', async () => {
    let calls = 0;
    const actions: BobActions = {
      ...baseActions,
      listFiscalDeadlines: async () => {
        calls += 1;
        return ok(deadlines);
      },
    };
    const t = tool(actions, 'echeances_fiscales')!;
    expect(t.mutating).toBe(false);
    expect(t.outbound).toBe(false);
    expect(riskTierOf(t)).toBe('read');
    expect(isSafetyFloor(t)).toBe(false);
    expect(requiresConfirmation(t, 'confirm_all')).toBe(false); // lecture : jamais de confirmation

    const parsed = t.parse({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const run = await t.run(parsed.value);
    // Les échéances passent TELLES QUELLES (aucune logique fiscale dans ai/ — parité humain↔Bob).
    expect(run.ok && run.value).toEqual(deadlines);
    expect(calls).toBe(1);
  });
});

describe('envoyer_relance — C25 ② (envoi réel, capacité optionnelle)', () => {
  it("absent sans l'action hôte (pas de capacité fantôme)", () => {
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain('envoyer_relance');
  });

  it('sortant + PLANCHER (mise en demeure possible : toujours confirmer, même en auto), invoiceId strict', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      sendRelance: async (input) => {
        calls.push(input);
        return ok({ jobId: 'job-1', status: 'done', tone: 'ferme' });
      },
    };
    const t = tool(actions, 'envoyer_relance')!;
    expect(t.mutating).toBe(true);
    expect(t.outbound).toBe(true);
    expect(riskTierOf(t)).toBe('outbound');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true); // « jamais envoyée sans ta validation »

    expect(t.parse({}).ok).toBe(false);
    expect(t.parse({ invoiceId: '' }).ok).toBe(false);
    const parsed = t.parse({ invoiceId: 'inv-1' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toEqual({ jobId: 'job-1', status: 'done', tone: 'ferme' });
    expect(calls).toEqual([{ invoiceId: 'inv-1' }]);
  });
});
