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
