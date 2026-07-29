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
    scheduleEmbargoPayment: async (input) => (
      track('scheduleEmbargoPayment', input),
      ok({
        scheduledFor: '2026-06-09T00:00:00.000Z',
        availableFrom: '2026-06-09',
        jobId: 'job-1',
        status: 'pending',
      })
    ),
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

  it('programmer_encaissement_embargo : le DÉFAUT légal L221-10 est exécutable à la voix — jamais le seul chemin risqué', async () => {
    // Hiérarchie doctrine fondateur : le chemin sûr (programmation) doit exister PARTOUT où
    // l'override existe. Hôte legacy sans l'action : l'outil n'apparaît pas (rétro-compat).
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain(
      'programmer_encaissement_embargo',
    );
    const calls: Record<string, unknown[]> = {};
    const t = tool(fullActions(calls), 'programmer_encaissement_embargo')!;
    expect(t).toBeDefined();
    // Sortant DIFFÉRÉ vers le client (email planifié) : plancher de consentement, même en auto.
    expect(t.outbound).toBe(true);
    expect(riskTierOf(t)).toBe('outbound');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    expect(t.parse({}).ok).toBe(false); // quoteId manquant
    const parsed = t.parse({ quoteId: 'q-1' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toMatchObject({ availableFrom: '2026-06-09', status: 'pending' });
    expect(calls.scheduleEmbargoPayment).toEqual([{ quoteId: 'q-1' }]);
    // Projection publique : dates/statut seulement — jamais l'id interne du job outbox.
    expect(t.projectPublicResult?.(run.ok ? run.value : {})).not.toHaveProperty('jobId');
  });

  it('emettre_facture : BT-23 et embargo sont fermés et traversent ensemble jusqu’à l’hôte', async () => {
    const overrides: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      issueInvoice: async (input) => (overrides.push(input), ok({ number: 'F-1' })),
    };
    const t = tool(actions, 'emettre_facture')!;
    expect(t.parse({ invoiceId: 'inv-1', embargoOverride: 'oui' }).ok).toBe(false);
    expect(t.parse({ invoiceId: 'inv-1', operationCategory: 'S1' }).ok).toBe(false);
    expect(t.parse({ invoiceId: 'inv-1', operationCategory: 'hybrid' }).ok).toBe(false);
    const plain = t.parse({ invoiceId: 'inv-1', embargoOverride: false });
    expect(plain.ok && !('embargoOverride' in (plain.value as Record<string, unknown>))).toBe(true);
    const forced = t.parse({
      invoiceId: 'inv-1',
      operationCategory: 'services',
      embargoOverride: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    await t.run(forced.value);
    expect(overrides).toEqual([{
      invoiceId: 'inv-1',
      operationCategory: 'services',
      embargoOverride: true,
    }]);
  });

  it('generer_facture : le mode est obligatoire pour garantir un rejeu déterministe', () => {
    const t = tool(fullActions({}), 'generer_facture')!;
    const parsed = t.parse({ quoteId: 'q-1' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.error.kind === 'validation') expect(parsed.error.issues[0]?.field).toBe('mode');
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

describe('enregistrer_reglement_depense — preuve explicite, jamais un rail bancaire', () => {
  it('n’expose pas l’ancien payExpense incomplet et exige date + moyen + DTO exact', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      // Même si un hôte ancien la conserve, cette capacité dangereuse n'est plus enregistrée.
      payExpense: async () => ok({ status: 'paid' }),
      recordExpensePayment: async (input) => {
        calls.push(input);
        return ok({ status: 'paid', alreadyRecorded: false, paymentEntryId: 'expense:exp-1:paid' });
      },
    };
    const names = buildBobTools(actions).map((candidate) => candidate.name);
    expect(names).not.toContain('payer_depense');
    expect(names).toContain('enregistrer_reglement_depense');
    const t = tool(actions, 'enregistrer_reglement_depense')!;
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);
    expect(t.parse({ expenseId: 'exp-1' }).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1', paidOn: '2026-02-30', method: 'card' }).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1', paidOn: '2026-07-03', method: 'cheque' }).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1', paidOn: '2026-07-03', method: 'cash', surprise: true }).ok).toBe(false);
    expect(t.parse({
      expenseId: 'exp-1',
      paidOn: '2026-07-03',
      method: 'transfer',
      reference: 'x'.repeat(141),
    }).ok).toBe(false);
    expect(t.parse({
      expenseId: 'exp-1',
      paidOn: '2026-07-03',
      method: 'transfer',
      reference: 'VIR\u0000-42',
    }).ok).toBe(false);

    const parsed = t.parse({
      expenseId: 'exp-1',
      paidOn: '2026-07-03',
      method: 'cash',
      reference: '  ESP-42  ',
      proofDocumentId: 'document-1',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        expenseId: 'exp-1',
        paidOn: '2026-07-03',
        method: 'cash',
        reference: 'ESP-42',
        proofDocumentId: 'document-1',
      },
    });
    if (!parsed.ok) return;
    await t.run(parsed.value);
    expect(calls).toEqual([parsed.value]);
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

describe('lier_depense_chantier — M3 (imputation dépense→chantier, capacité optionnelle)', () => {
  it("absent sans l'action hôte (pas de capacité fantôme)", () => {
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain('lier_depense_chantier');
  });

  it('PLANCHER de consentement (jamais liée sans confirmation, même en auto), contrat strict', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      assignExpenseChantier: async (input) => {
        calls.push(input);
        return ok({ chantierId: input.chantierId, changed: true });
      },
    };
    const t = tool(actions, 'lier_depense_chantier')!;
    expect(t.mutating).toBe(true);
    expect(t.outbound).toBe(false);
    expect(riskTierOf(t)).toBe('reversible');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    // Même contrat que PUT /expenses/:id/chantier : clé chantierId REQUISE (null explicite =
    // délier), champ surnuméraire refusé, id canonique (bords/contrôle interdits).
    expect(t.parse({}).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1' }).ok).toBe(false); // clé absente ≠ null
    expect(t.parse({ expenseId: '', chantierId: 'ch-1' }).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1', chantierId: ' ch-1' }).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1', chantierId: '' }).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1', chantierId: 'ch-1\u007f' }).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1', chantierId: 'ch-1', extra: true }).ok).toBe(false);
    expect(t.parse({ expenseId: 'exp-1', chantierId: null }).ok).toBe(true); // délier : geste légitime

    const parsed = t.parse({ expenseId: 'exp-1', chantierId: 'ch-1' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toEqual({ chantierId: 'ch-1', changed: true });
    expect(calls).toEqual([{ expenseId: 'exp-1', chantierId: 'ch-1' }]);
    // Projection publique : imputation + idempotence, jamais le payload métier brut.
    expect(t.projectPublicResult?.({ chantierId: 'ch-1', changed: true })).toEqual({
      chantierId: 'ch-1',
      changed: true,
    });
  });
});

describe('scan_depense — extension M4 (chantierId + règlement déclaré, additive)', () => {
  it('accepte chantierId et payment, refuse les formes non canoniques', () => {
    const calls: Record<string, unknown[]> = {};
    const t = tool(fullActions(calls), 'scan_depense')!;
    // Rétro-compatibilité : l'appel historique sans les nouveaux champs reste valide tel quel.
    const legacy = t.parse({ supplierName: 'Aldi', totalTtcCents: 4500, category: 'repas' });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.value).not.toHaveProperty('chantierId');

    expect(t.parse({ supplierName: 'Aldi', totalTtcCents: 4500, category: 'repas', chantierId: ' ch-1' }).ok).toBe(false);
    expect(t.parse({ supplierName: 'Aldi', totalTtcCents: 4500, category: 'repas', chantierId: '' }).ok).toBe(false);
    expect(t.parse({ supplierName: 'Aldi', totalTtcCents: 4500, category: 'repas', chantierId: 'ch\n1' }).ok).toBe(false);
    expect(
      t.parse({ supplierName: 'Aldi', totalTtcCents: 4500, category: 'repas', payment: { paidOn: 'hier', method: 'card' } }).ok,
    ).toBe(false); // date réelle exigée (YYYY-MM-DD)
    expect(
      t.parse({ supplierName: 'Aldi', totalTtcCents: 4500, category: 'repas', payment: { paidOn: '2026-07-18', method: 'cheque' } }).ok,
    ).toBe(false); // moyen inconnu
    expect(
      t.parse({ supplierName: 'Aldi', totalTtcCents: 4500, category: 'repas', payment: { paidOn: '2026-07-18', method: 'card', extra: 1 } }).ok,
    ).toBe(false); // champ de règlement inconnu

    const full = t.parse({
      supplierName: 'Leroy Merlin',
      totalTtcCents: 8900,
      category: 'materiel',
      documentDate: '2026-07-18',
      chantierId: 'ch-1',
      payment: { paidOn: '2026-07-18', method: 'card' },
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.value).toEqual({
      supplierName: 'Leroy Merlin',
      totalTtcCents: 8900,
      category: 'materiel',
      documentDate: '2026-07-18',
      chantierId: 'ch-1',
      payment: { paidOn: '2026-07-18', method: 'card' },
    });
  });
});

describe('marquer_notifications_lues — lot atomique figé avant consentement', () => {
  it("reste absent si l'hôte ne fournit pas la commande", () => {
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain('marquer_notifications_lues');
  });

  it('valide un cutoff ISO strict, délègue sans le modifier et force la confirmation', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      markNotificationsReadThrough: async (input) => {
        calls.push(input);
        return ok({ updatedCount: 3, readAt: '2026-07-13T10:01:00.000Z' });
      },
    };
    const t = tool(actions, 'marquer_notifications_lues')!;
    expect(t.mutating).toBe(true);
    expect(t.outbound).toBe(false);
    expect(riskTierOf(t)).toBe('reversible');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    expect(t.parse({ throughCreatedAt: '2026-07-13' }).ok).toBe(false);
    expect(t.parse({ throughCreatedAt: '2026-07-13T10:00:00Z' }).ok).toBe(false);
    const parsed = t.parse({ throughCreatedAt: '2026-07-13T10:00:00.000Z' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toMatchObject({ updatedCount: 3 });
    expect(calls).toEqual([{ throughCreatedAt: '2026-07-13T10:00:00.000Z' }]);
    expect(run.ok && t.projectPublicResult?.(run.value)).toEqual({ updatedCount: 3 });
  });
});

describe('valider_document — parité « papa vocal » avec le bouton « Confirmer » (À valider)', () => {
  it("reste absent si l'hôte ne fournit pas l'action (pas de capacité fantôme)", () => {
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain('valider_document');
  });

  it('mutation interne NON sortante, documentId strict, délègue au use case hôte', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      acknowledgeDocument: async (input) => {
        calls.push(input);
        return ok({ documentId: input.documentId, reviewedAt: '2026-07-13T10:00:00.000Z' });
      },
    };
    const t = tool(actions, 'valider_document')!;
    expect(t.mutating).toBe(true);
    expect(t.outbound).toBe(false);
    // Latch sans commande d'annulation : plancher de consentement, même en autonomie 'auto'.
    expect(riskTierOf(t)).toBe('reversible');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    expect(t.parse({}).ok).toBe(false);
    expect(t.parse({ documentId: '' }).ok).toBe(false);
    const parsed = t.parse({ documentId: 'document-1' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toEqual({ documentId: 'document-1', reviewedAt: '2026-07-13T10:00:00.000Z' });
    expect(calls).toEqual([{ documentId: 'document-1' }]);
    expect(run.ok && t.projectPublicResult?.(run.value)).toEqual({
      documentId: 'document-1',
      reviewedAt: '2026-07-13T10:00:00.000Z',
    });
  });
});

describe('classer_document — parité « papa vocal » avec le geste « Classer là » (LOT 5)', () => {
  it("reste absent si l'hôte ne fournit pas l'action (pas de capacité fantôme)", () => {
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain('classer_document');
  });

  it('mutation interne NON sortante au plancher, destination strictement typée, délègue à l’hôte', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      fileDocument: async (input) => {
        calls.push(input);
        return ok({
          documentId: input.documentId,
          folderId: 'folder-achats',
          linkedEntityType: null,
          linkedEntityId: null,
          displayName: 'Ticket Aldi — 23,90 €',
        });
      },
    };
    const t = tool(actions, 'classer_document')!;
    expect(t.mutating).toBe(true);
    expect(t.outbound).toBe(false);
    // Ranger POSE la validation (latch) et un lien métier : plancher, même en autonomie 'auto'.
    expect(riskTierOf(t)).toBe('reversible');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    expect(t.parse({}).ok).toBe(false); // document manquant
    expect(t.parse({ documentId: 'doc-1' }).ok).toBe(false); // destination manquante
    expect(t.parse({ documentId: 'doc-1', destination: { kind: 'autre', folderId: 'f-1' } }).ok).toBe(false);
    expect(t.parse({ documentId: 'doc-1', destination: { kind: 'chantier' } }).ok).toBe(false); // id manquant
    expect(t.parse({ documentId: 'doc-1', destination: { kind: 'folder', folderId: '' } }).ok).toBe(false);
    const parsed = t.parse({ documentId: 'doc-1', destination: { kind: 'folder', folderId: 'folder-achats' } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toMatchObject({ documentId: 'doc-1', folderId: 'folder-achats' });
    expect(calls).toEqual([{ documentId: 'doc-1', destination: { kind: 'folder', folderId: 'folder-achats' } }]);
    // Allowlist de sortie : jamais le payload métier brut.
    expect(run.ok && t.projectPublicResult?.(run.value)).toEqual({
      documentId: 'doc-1',
      folderId: 'folder-achats',
      displayName: 'Ticket Aldi — 23,90 €',
    });
  });
});

describe('renommer_document — RenameDocument, nom humain prioritaire (LOT 5)', () => {
  it("reste absent si l'hôte ne fournit pas l'action", () => {
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain('renommer_document');
  });

  it('mutation interne au plancher, displayName validé par la règle de domaine, délègue à l’hôte', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      renameDocument: async (input) => {
        calls.push(input);
        return ok({ documentId: input.documentId, displayName: input.displayName });
      },
    };
    const t = tool(actions, 'renommer_document')!;
    expect(t.mutating).toBe(true);
    expect(t.outbound).toBe(false);
    expect(riskTierOf(t)).toBe('reversible');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    expect(t.parse({ displayName: 'x' }).ok).toBe(false); // document manquant
    expect(t.parse({ documentId: 'doc-1', displayName: '   ' }).ok).toBe(false); // nom vide
    expect(t.parse({ documentId: 'doc-1', displayName: 'a'.repeat(121) }).ok).toBe(false); // trop long
    const parsed = t.parse({ documentId: 'doc-1', displayName: '  Facture   matériaux salle de bain ' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // La règle de domaine réduit les espaces (même validation que l'écran).
    expect((parsed.value as { displayName: string }).displayName).toBe('Facture matériaux salle de bain');

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toEqual({ documentId: 'doc-1', displayName: 'Facture matériaux salle de bain' });
    expect(calls).toEqual([{ documentId: 'doc-1', displayName: 'Facture matériaux salle de bain' }]);
    expect(run.ok && t.projectPublicResult?.(run.value)).toEqual({
      documentId: 'doc-1',
      displayName: 'Facture matériaux salle de bain',
    });
  });
});

describe('chercher_document — recherche réelle devis & factures, lecture pure (LOT 5)', () => {
  it("reste absent si l'hôte ne fournit pas l'action", () => {
    expect(buildBobTools(baseActions).map((t) => t.name)).not.toContain('chercher_document');
  });

  it('lecture stricte : jamais de confirmation, requête bornée, période ordonnée, délègue à l’hôte', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      searchDocuments: async (input) => {
        calls.push(input);
        return ok({
          hits: [
            {
              source: 'invoice' as const,
              id: 'inv-1',
              number: '2026-014',
              customerName: 'Durand SARL',
              status: 'issued',
              date: '2026-03-12',
              totalTtcCents: 132000,
              matchedLineLabel: 'Radiateur acier',
            },
          ],
          totalCount: 1,
        });
      },
    };
    const t = tool(actions, 'chercher_document')!;
    expect(t.mutating).toBe(false);
    expect(riskTierOf(t)).toBe('read');
    expect(requiresConfirmation(t, 'confirm_all')).toBe(false);

    expect(t.parse({}).ok).toBe(false); // requête manquante
    expect(t.parse({ query: '' }).ok).toBe(false); // vide SANS période : jamais de ratissage
    expect(t.parse({ query: '', from: '2026-03-01', to: '2026-03-31' }).ok).toBe(true); // période seule OK
    expect(t.parse({ query: 'radiateur', from: '2026-04-01', to: '2026-03-01' }).ok).toBe(false); // inversée
    expect(t.parse({ query: 'radiateur', scope: 'archive' }).ok).toBe(false);
    const parsed = t.parse({ query: '  radiateur ', scope: 'invoice', from: '2026-03-01', to: '2026-03-31' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const run = await t.run(parsed.value);
    expect(run.ok && run.value).toMatchObject({ totalCount: 1 });
    expect(calls).toEqual([{ query: 'radiateur', scope: 'invoice', from: '2026-03-01', to: '2026-03-31' }]);
  });
});

describe('facturation terrain B1/B2/B4 — facture_directe, facturer_situation, definir_conditions_paiement', () => {
  const terrainActions = (calls: Record<string, unknown[]>): BobActions => {
    const track = (name: string, input: unknown) => {
      calls[name] = [...(calls[name] ?? []), input];
    };
    return {
      ...baseActions,
      generateInvoice: async (input) => (track('generateInvoice', input), ok({ invoiceId: 'inv-9' })),
      composeStandaloneInvoice: async (input) => (
        track('composeStandaloneInvoice', input),
        ok({ invoiceId: 'inv-10', totalTtcCents: 60000, netToPayCents: 60000 })
      ),
      setCustomerPaymentTerms: async (input) => (
        track('setCustomerPaymentTerms', input),
        ok({ customerId: 'cus-1', customerName: 'Durand SARL', days: input.days, endOfMonth: input.endOfMonth, label: input.label })
      ),
    };
  };

  it('capacités : les trois outils n’existent que si l’hôte fournit leurs actions (rétro-compat)', () => {
    const names = buildBobTools(baseActions).map((t) => t.name);
    expect(names).not.toContain('facture_directe');
    expect(names).not.toContain('facturer_situation');
    expect(names).not.toContain('definir_conditions_paiement');
    const full = buildBobTools(terrainActions({})).map((t) => t.name);
    expect(full).toContain('facture_directe');
    expect(full).toContain('facturer_situation');
    expect(full).toContain('definir_conditions_paiement');
  });

  it('facture_directe : plancher FISCAL (confirmée même en auto), parse strict, remise et urgence bornées', async () => {
    const calls: Record<string, unknown[]> = {};
    const t = tool(terrainActions(calls), 'facture_directe')!;
    expect(riskTierOf(t)).toBe('fiscal');
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    const line = { label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 38000, vatRate: 10 };
    expect(t.parse({ lines: [line] }).ok).toBe(false); // client manquant
    expect(t.parse({ customerId: 'cus-1', lines: [] }).ok).toBe(false); // aucune ligne
    expect(t.parse({ customerId: 'cus-1', lines: [line], extra: true }).ok).toBe(false); // champ inconnu
    // Urgence A3bis : booléen STRICT — jamais par truthiness.
    expect(t.parse({ customerId: 'cus-1', lines: [line], urgentOnSiteRepair: 'oui' }).ok).toBe(false);
    // Remise : structure jugée par le domaine (validateDiscount).
    expect(t.parse({ customerId: 'cus-1', lines: [line], globalDiscount: { type: 'percent', value: 250 } }).ok).toBe(false);
    expect(t.parse({ customerId: 'cus-1', lines: [{ ...line, discount: { type: 'amount', cents: 0 } }] }).ok).toBe(false);

    const parsed = t.parse({
      customerId: 'cus-1',
      lines: [{ ...line, discount: { type: 'amount', cents: 500 } }],
      globalDiscount: { type: 'percent', value: 10 },
      context: { housingOlderThan2y: true },
      urgentOnSiteRepair: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const run = await t.run(parsed.value);
    expect(run.ok).toBe(true);
    expect(calls.composeStandaloneInvoice?.[0]).toMatchObject({
      customerId: 'cus-1',
      urgentOnSiteRepair: true,
      globalDiscount: { type: 'percent', value: 10 },
      lines: [{ label: 'Dépannage', discount: { type: 'amount', cents: 500 } }],
    });
    // Projection publique : totaux du domaine, jamais le payload brut complet.
    expect(t.projectPublicResult?.(run.ok ? run.value : {})).toEqual({
      invoiceId: 'inv-10',
      totalTtcCents: 60000,
      netToPayCents: 60000,
    });
  });

  it('facturer_situation : formes EXCLUSIVES ({percent} XOR {amountHtCents}), délégation au MÊME generateInvoice (mode situation)', async () => {
    const calls: Record<string, unknown[]> = {};
    const t = tool(terrainActions(calls), 'facturer_situation')!;
    expect(riskTierOf(t)).toBe('fiscal');
    expect(requiresConfirmation(t, 'auto')).toBe(true);

    expect(t.parse({ quoteId: 'q-1' }).ok).toBe(false); // montant manquant
    expect(t.parse({ quoteId: 'q-1', situation: {} }).ok).toBe(false);
    expect(t.parse({ quoteId: 'q-1', situation: { percent: 40, amountHtCents: 100 } }).ok).toBe(false); // exclusifs
    expect(t.parse({ quoteId: 'q-1', situation: { percent: 0 } }).ok).toBe(false);
    expect(t.parse({ quoteId: 'q-1', situation: { percent: 101 } }).ok).toBe(false);
    expect(t.parse({ quoteId: 'q-1', situation: { amountHtCents: 12.5 } }).ok).toBe(false);
    expect(t.parse({ quoteId: 'q-1', situation: { percent: 40 }, embargoOverride: 'oui' }).ok).toBe(false);

    const parsed = t.parse({ quoteId: 'q-1', situation: { percent: 40 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await t.run(parsed.value);
    expect(calls.generateInvoice).toEqual([{ quoteId: 'q-1', mode: 'situation', situation: { percent: 40 } }]);
  });

  it('definir_conditions_paiement : PaymentTerms.of (autorité domaine), libellé canonique par défaut, plancher de consentement', async () => {
    const calls: Record<string, unknown[]> = {};
    const t = tool(terrainActions(calls), 'definir_conditions_paiement')!;
    expect(isSafetyFloor(t)).toBe(true);
    expect(requiresConfirmation(t, 'auto')).toBe(true);
    expect(riskTierOf(t)).toBe('reversible');

    expect(t.parse({ days: 45, endOfMonth: true }).ok).toBe(false); // client manquant
    expect(t.parse({ customerId: 'cus-1', days: 45.5, endOfMonth: true }).ok).toBe(false);
    expect(t.parse({ customerId: 'cus-1', days: 400, endOfMonth: false }).ok).toBe(false); // > 365
    expect(t.parse({ customerId: 'cus-1', days: 45, endOfMonth: 'oui' }).ok).toBe(false);
    expect(t.parse({ customerId: 'cus-1', days: 45, endOfMonth: true, autre: 1 }).ok).toBe(false);

    const parsed = t.parse({ customerId: 'cus-1', days: 45, endOfMonth: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // AnyTool : la valeur parsée traverse en unknown — lecture typée locale pour l'assertion.
    expect((parsed.value as { label: string }).label).toBe('45 jours fin de mois');
    const plain = t.parse({ customerId: 'cus-1', days: 30, endOfMonth: false });
    expect(plain.ok && (plain.value as { label: string }).label).toBe('Paiement à 30 jours');
    await t.run(parsed.value);
    expect(calls.setCustomerPaymentTerms).toEqual([
      { customerId: 'cus-1', days: 45, endOfMonth: true, label: '45 jours fin de mois' },
    ]);
  });

  it('creer_devis (B3, additif) : remise globale et remises de ligne dictées traversent vers CreateQuote', async () => {
    const calls: Record<string, unknown[]> = {};
    const actions: BobActions = {
      ...baseActions,
      createQuote: async (input) => {
        calls.createQuote = [...(calls.createQuote ?? []), input];
        return ok({ quoteId: 'q-1' });
      },
    };
    const t = tool(actions, 'creer_devis')!;
    const parsed = t.parse({
      customerId: 'cus-1',
      lines: [
        { label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20, discount: { type: 'percent', value: 5 } },
      ],
      globalDiscount: { type: 'amount', cents: 2000 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await t.run(parsed.value);
    expect(calls.createQuote?.[0]).toMatchObject({
      globalDiscount: { type: 'amount', cents: 2000 },
      lines: [{ discount: { type: 'percent', value: 5 } }],
    });
    // Structure de remise invalide : refusée par l'autorité du domaine (validateDiscount).
    expect(t.parse({ customerId: 'cus-1', lines: [{ label: 'x', category: 'labor', qty: 1, unitPriceHT: 100, vatRate: 20 }], globalDiscount: { type: 'percent', value: 0 } }).ok).toBe(false);
  });

  it('PR-08 — le site dicté (chantierId résolu) traverse creer_devis ET facture_directe, forme canonique exigée', async () => {
    const calls: Record<string, unknown[]> = {};
    const line = { label: 'Entretien', category: 'labor', qty: 1, unitPriceHT: 40000, vatRate: 20 };

    const quoteActions: BobActions = {
      ...baseActions,
      createQuote: async (input) => (calls.createQuote = [...(calls.createQuote ?? []), input], ok({ quoteId: 'q-1' })),
    };
    const creerDevis = tool(quoteActions, 'creer_devis')!;
    // Forme canonique : id trimmé sans caractère de contrôle — jamais un id fantaisiste.
    expect(creerDevis.parse({ customerId: 'cus-1', lines: [line], chantierId: ' site-1 ' }).ok).toBe(false);
    expect(creerDevis.parse({ customerId: 'cus-1', lines: [line], chantierId: '' }).ok).toBe(false);
    const parsedQuote = creerDevis.parse({ customerId: 'cus-1', lines: [line], chantierId: 'site-bastille' });
    expect(parsedQuote.ok).toBe(true);
    if (!parsedQuote.ok) return;
    await creerDevis.run(parsedQuote.value);
    expect(calls.createQuote?.[0]).toMatchObject({ chantierId: 'site-bastille' });
    // Sans site : le champ ne voyage pas (jamais un null parasite dans l'intention).
    const noSite = creerDevis.parse({ customerId: 'cus-1', lines: [line] });
    expect(noSite.ok && 'chantierId' in (noSite.value as Record<string, unknown>)).toBe(false);

    const directe = tool(terrainActions(calls), 'facture_directe')!;
    expect(directe.parse({ customerId: 'cus-1', lines: [line], chantierId: '' }).ok).toBe(false);
    const parsedDirecte = directe.parse({ customerId: 'cus-1', lines: [line], chantierId: 'site-bastille' });
    expect(parsedDirecte.ok).toBe(true);
    if (!parsedDirecte.ok) return;
    await directe.run(parsedDirecte.value);
    expect(calls.composeStandaloneInvoice?.[0]).toMatchObject({ chantierId: 'site-bastille' });
  });
});

describe('vague Encaisser (PR-01/02/05/06) — capacités optionnelles, profils de risque, DTO stricts', () => {
  it("aucun outil fantôme sans l'action hôte (fail-closed, rétro-compat)", () => {
    const names = buildBobTools(baseActions).map((t) => t.name);
    expect(names).not.toContain('relance_devis');
    expect(names).not.toContain('marquer_facture_transmise');
    expect(names).not.toContain('cadence_relances');
    expect(names).not.toContain('regler_relances_auto');
  });

  it('relance_devis : lecture PURE (jamais de confirmation), quoteId strict, délègue à l’hôte', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      draftQuoteRelance: async (input) => {
        calls.push(input);
        return ok({ relanceable: true, palier: 'j15' as const, subject: 's', body: 'b' });
      },
    };
    const t = tool(actions, 'relance_devis')!;
    expect(t.mutating).toBe(false);
    expect(riskTierOf(t)).toBe('read');
    expect(requiresConfirmation(t, 'confirm_all')).toBe(false);
    expect(t.parse({}).ok).toBe(false);
    const parsed = t.parse({ quoteId: 'q-1' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await t.run(parsed.value);
    expect(calls).toEqual([{ quoteId: 'q-1' }]);
  });

  it('marquer_facture_transmise : PLANCHER (fait déclaré), au moins une date, DateOnly ou null strict', async () => {
    const calls: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      recordInvoiceTransmission: async (input) => {
        calls.push(input);
        return ok({ transmission: { depositedAt: '2026-07-26', acceptedAt: null } });
      },
    };
    const t = tool(actions, 'marquer_facture_transmise')!;
    expect(t.mutating).toBe(true);
    expect(t.outbound).toBe(false); // suivi déclaré : rien ne part vers le client
    expect(isSafetyFloor(t)).toBe(true); // confirmation même en 'auto'
    expect(t.parse({ invoiceId: 'inv-1' }).ok).toBe(false); // aucune date = refus
    expect(t.parse({ invoiceId: 'inv-1', depositedAt: 'hier' }).ok).toBe(false); // date libre = refus
    expect(t.parse({ invoiceId: 'inv-1', depositedAt: '2026-07-26', extra: true }).ok).toBe(false);
    const parsed = t.parse({ invoiceId: 'inv-1', depositedAt: '2026-07-26' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await t.run(parsed.value);
    expect(calls).toEqual([{ invoiceId: 'inv-1', depositedAt: '2026-07-26' }]);
    // null EXPLICITE = effacement légitime (contrat du use case).
    expect(t.parse({ invoiceId: 'inv-1', acceptedAt: null }).ok).toBe(true);
  });

  it('cadence_relances (lecture) + regler_relances_auto (plancher, booléen strict)', async () => {
    const set: unknown[] = [];
    const actions: BobActions = {
      ...baseActions,
      getRelanceSettings: async () => ok({ relanceAutoEnabled: true, relancePolicy: null }),
      setRelanceAutoEnabled: async (input) => {
        set.push(input);
        return ok({ relanceAutoEnabled: input.enabled, relancePolicy: null });
      },
    };
    const read = tool(actions, 'cadence_relances')!;
    expect(read.mutating).toBe(false);
    expect(requiresConfirmation(read, 'confirm_all')).toBe(false);
    const toggle = tool(actions, 'regler_relances_auto')!;
    expect(isSafetyFloor(toggle)).toBe(true); // conditionne des emails clients récurrents
    expect(toggle.parse({}).ok).toBe(false);
    expect(toggle.parse({ enabled: 'oui' }).ok).toBe(false); // jamais un truthy
    const parsed = toggle.parse({ enabled: false });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await toggle.run(parsed.value);
    expect(set).toEqual([{ enabled: false }]);
  });

  it('envoyer_facture : sortant (plancher outbound), projection publique bornée au deliveryStatus', async () => {
    const actions: BobActions = {
      ...baseActions,
      sendInvoice: async () =>
        ok({ number: 'F-1', recipient: 'client@exemple.fr', deliveryStatus: 'queued' as const, jobId: 'j-1' }),
    };
    const t = tool(actions, 'envoyer_facture')!;
    expect(t.outbound).toBe(true);
    expect(isSafetyFloor(t)).toBe(true); // outbound = toujours confirmé, même en auto
    expect(t.parse({}).ok).toBe(false);
    const parsed = t.parse({ invoiceId: 'inv-1' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const run = await t.run(parsed.value);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // Le destinataire (PII) ne traverse jamais la projection publique du runtime.
    expect(t.projectPublicResult?.(run.value)).toEqual({ deliveryStatus: 'queued' });
  });

  it('regler_fiche_passage : parité §3.2 — capacité optionnelle, plancher de confirmation', async () => {
    const written: unknown[] = [];
    // Hôte legacy sans la capacité : l'outil n'existe pas (jamais une promesse creuse).
    expect(tool(baseActions, 'regler_fiche_passage')).toBeUndefined();
    expect(tool(baseActions, 'reglages_fiche_passage')).toBeUndefined();

    const actions: BobActions = {
      ...baseActions,
      getInterventionSettings: async () =>
        ok({
          effectiveReportTitle: 'Fiche de passage',
          reportTitle: null,
          templatedKinds: [],
          revision: 0,
        }),
      updateInterventionSettings: async (input) => {
        written.push(input);
        return ok({
          effectiveReportTitle: input.reportTitle ?? 'Fiche de passage',
          reportTitle: input.reportTitle ?? null,
          templatedKinds: Object.keys(input.checklistTemplates ?? {}),
          revision: 1,
        });
      },
    };
    const read = tool(actions, 'reglages_fiche_passage')!;
    expect(read.mutating).toBe(false);
    expect(requiresConfirmation(read, 'confirm_all')).toBe(false);

    const write = tool(actions, 'regler_fiche_passage')!;
    // Le titre devient l'identité d'un document de preuve sortant : jamais en silence.
    expect(isSafetyFloor(write)).toBe(true);
    expect(write.parse({}).ok).toBe(false);
    expect(write.parse({ reportTitle: 42 }).ok).toBe(false);
    expect(write.parse({ checklistTemplates: { 'Visite': 'Détartrage' } }).ok).toBe(false);
    const parsed = write.parse({ reportTitle: 'Certificat sanitaire' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const run = await write.run(parsed.value);
    expect(run.ok).toBe(true);
    expect(written).toEqual([{ reportTitle: 'Certificat sanitaire' }]);
  });
});


describe('§2.7 — outils de CYCLE DE VIE d’un contrat (créer / activer / résilier)', () => {
  const lifecycleActions: BobActions = {
    ...baseActions,
    createMaintenanceContract: async () =>
      ok({
        contractId: 'c-1',
        label: 'Fontaines RATP',
        status: 'draft' as const,
        anniversaryDate: '2026-10-01',
        terminationEffectiveDate: null,
      }),
    activateMaintenanceContract: async () =>
      ok({
        contractId: 'c-1',
        label: 'Fontaines RATP',
        status: 'active' as const,
        anniversaryDate: '2026-10-01',
        terminationEffectiveDate: null,
      }),
    terminateMaintenanceContract: async () =>
      ok({
        contractId: 'c-1',
        label: 'Fontaines RATP',
        status: 'terminated' as const,
        anniversaryDate: '2026-10-01',
        terminationEffectiveDate: '2027-10-01',
      }),
  };

  it('absents de l’hôte legacy, exposés dès que l’hôte fournit les MÊMES use cases que l’écran', () => {
    const legacy = buildBobTools(baseActions).map((t) => t.name);
    for (const name of ['creer_contrat_maintenance', 'activer_contrat', 'resilier_contrat']) {
      expect(legacy).not.toContain(name);
    }
    const names = buildBobTools(lifecycleActions).map((t) => t.name);
    for (const name of ['creer_contrat_maintenance', 'activer_contrat', 'resilier_contrat']) {
      expect(names).toContain(name);
    }
  });

  it('les trois gestes sont au PLANCHER de sécurité : confirmés même en autonomie « auto »', () => {
    for (const name of ['creer_contrat_maintenance', 'activer_contrat', 'resilier_contrat']) {
      const t = tool(lifecycleActions, name)!;
      expect(t.mutating).toBe(true);
      expect(t.outbound).toBe(false);
      expect(isSafetyFloor(t)).toBe(true);
      expect(requiresConfirmation(t, 'auto')).toBe(true);
      expect(riskTierOf(t)).toBe('reversible');
    }
  });

  it('creer_contrat_maintenance : arguments strictement validés (anti-hallucination)', () => {
    const t = tool(lifecycleActions, 'creer_contrat_maintenance')!;
    // Chaque refus doit tomber sur LE défaut qu'il nomme : le libellé est donc toujours
    // irréprochable ici, sinon la garde fail-closed refuserait la première et ces assertions
    // deviendraient vraies sans rien prouver (« X » est un moignon, il refuse à lui seul).
    const OK_LABEL = 'Entretien vitrines';
    expect(t.parse({ label: OK_LABEL, anniversaryDate: '2026-10-01' }).ok).toBe(false);
    expect(t.parse({ customerId: 'c', label: '', anniversaryDate: '2026-10-01' }).ok).toBe(false);
    expect(t.parse({ customerId: 'c', label: OK_LABEL, anniversaryDate: '01/10/2026' }).ok).toBe(false);
    expect(t.parse({ customerId: 'c', label: OK_LABEL, anniversaryDate: '2026-02-31' }).ok).toBe(false);
    expect(
      t.parse({ customerId: 'c', label: OK_LABEL, anniversaryDate: '2026-10-01', visitsPerYear: 99 })
        .ok,
    ).toBe(false);
    expect(
      t.parse({
        customerId: 'c',
        label: OK_LABEL,
        anniversaryDate: '2026-10-01',
        lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 120_000, vatRate: 7 }],
      }).ok,
    ).toBe(false);
    const parsed = t.parse({
      customerId: 'cus-1',
      label: 'Fontaines RATP',
      chantierId: 'site-1',
      anniversaryDate: '2026-10-01',
      visitsPerYear: 2,
      tacitRenewal: false,
      lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 120_000, vatRate: 20 }],
      equipmentIds: ['eq-1'],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      customerId: 'cus-1',
      label: 'Fontaines RATP',
      chantierId: 'site-1',
      anniversaryDate: '2026-10-01',
      visitsPerYear: 2,
      tacitRenewal: false,
      lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 120_000, vatRate: 20 }],
      equipmentIds: ['eq-1'],
    });
  });

  /**
   * CHEMIN DU MODÈLE — la garde fail-closed du libellé (`contract-label-guard.ts`) est posée au
   * POINT DE CONVERGENCE des deux chemins qui peuvent produire un contrat : l'extraction
   * déterministe (l'agent construit ces arguments, cf. `bob-agent-contracts.test.ts`) et CELUI-CI,
   * où un modèle remplit `label` lui-même. Un modèle n'a aucune raison structurelle de séparer le
   * nom des faits : il recopie volontiers la phrase du pro. Ce test prouve que le registre ne lui
   * fait pas confiance — sans lui, la garde ne couvrirait qu'une moitié du problème.
   */
  it('GARDE : le libellé rempli PAR LE MODÈLE traverse la même garde (jamais un fait sur la ligne)', () => {
    const t = tool(lifecycleActions, 'creer_contrat_maintenance')!;
    const base = { customerId: 'cus-1', anniversaryDate: '2026-10-01' };
    // Les formes que quatre revues ont vues échapper à l'extraction — refusées ICI par la garde,
    // quelle que soit la façon dont elles sont arrivées dans l'argument.
    const refuses: readonly string[] = [
      'Entretien vitrines à 1.200 € par an',
      'Entretien vitrines à deux mille euros',
      'Entretien vitrines 12 k€',
      'Entretien vitrines à partir du 01/10/2026',
      'Entretien vitrines le 1er octobre',
      'Entretien vitrines pour le compte de RATP',
      'Entretien vitrines au nom de Carrefour',
      'Entretien vitrines pour la SARL Dupont',
      'Entretien vitrines pour',
      'de la',
    ];
    const passes = refuses.filter((label) => t.parse({ ...base, label }).ok);
    expect(passes.join(' | '), 'libellés qui auraient dû être refusés par la garde').toBe('');
    // Le refus est DIT en français au point de décision, jamais rendu en code technique.
    const refused = t.parse({ ...base, label: 'Entretien vitrines à 1.200 € par an' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // Le refus parle du NOM affiché sur le contrat, jamais de la facture : la ligne de la facture
    // annuelle ne reprend plus ce nom (le domaine compose sa désignation, @bob/core).
    expect(JSON.stringify(refused.error)).toContain('montant');
    expect(JSON.stringify(refused.error)).not.toContain('facture');
    // La LIGNE du contrat passe par la MÊME garde, sans raccourci…
    expect(
      t.parse({
        ...base,
        label: 'Entretien vitrines',
        lines: [
          { label: '1 200 € par an', quantity: 1, unitPriceHtCents: 120_000, vatRate: 20 },
        ],
      }).ok,
    ).toBe(false);
    // …et un nom de contrat parfaitement légitime reste possible (la garde n'est pas un mur).
    expect(
      t.parse({
        ...base,
        label: 'Entretien annuel hall A',
        lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 120_000, vatRate: 20 }],
      }).ok,
    ).toBe(true);
  });

  it('resilier_contrat : le MOTIF est exigé (trace légale) et la date d’effet reste optionnelle', () => {
    const t = tool(lifecycleActions, 'resilier_contrat')!;
    expect(t.parse({ contractId: 'c-1' }).ok).toBe(false);
    expect(t.parse({ contractId: 'c-1', note: '   ' }).ok).toBe(false);
    // Caractère de CONTRÔLE dans le motif : refusé ici comme par le domaine.
    expect(t.parse({ contractId: 'c-1', note: 'motif\u0007' }).ok).toBe(false);
    expect(t.parse({ contractId: 'c-1', note: 'motif', effectiveDate: 'le 1er juin' }).ok).toBe(false);
    const parsed = t.parse({ contractId: 'c-1', note: ' le client déménage ' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Sans date dite, aucune date n’est envoyée : le domaine calcule le prochain anniversaire.
    expect(parsed.value).toEqual({ contractId: 'c-1', note: 'le client déménage' });
  });
});
