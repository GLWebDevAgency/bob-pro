import { describe, expect, it } from 'vitest';
import { DuplicateQuote, buildQuoteDuplicationInput } from './duplicate-quote';
import { makeEnv } from './in-memory-env';
import { Quote, type QuoteSnapshot } from '../../domain/billing/quote/quote';
import { Company } from '../../domain/company/company';

/** Devis source COMPLET : tous les faits légaux/temporels posés — la duplication doit tout
 * laisser derrière elle sauf la matière commerciale. */
function signedSourceSnapshot(companyId: string, overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    id: 'quote-source',
    companyId,
    customerId: 'cust-bernard', // b2c (fixtures billing)
    status: 'signed',
    lines: [
      {
        id: 'line-1',
        label: 'Entretien fontaine',
        category: 'labor',
        qty: 2,
        unit: 'passage',
        unitPriceHT: 40_000,
        vatRate: 20,
        discount: { type: 'percent', value: 10 },
      },
      { id: 'line-2', label: 'Cartouche filtrante', category: 'supply', qty: 3, unitPriceHT: 4_500, vatRate: 20 },
    ],
    number: 'D-2026-0042',
    depositPct: 30,
    validUntil: '2026-05-31',
    issuedAt: '2026-04-02',
    signature: {
      signerName: 'M. Bernard',
      signedAt: '2026-04-03T09:00:00.000Z',
      method: 'onsite_draw',
      accepted: true,
    },
    retractedAt: null,
    urgentRepair: { requestedAt: '2026-04-01T08:00:00.000Z' },
    purchaseOrder: { number: '4500123', receivedAt: null, documentId: null },
    globalDiscount: { type: 'amount', cents: 5_000 },
    retenueGarantiePct: 3,
    chantierId: 'chantier-bastille',
    revision: 2,
    ...overrides,
  };
}

function deps(env: ReturnType<typeof makeEnv>, tenantChantiers: readonly string[] = ['chantier-bastille']) {
  return {
    quotes: env.quoteRepo,
    companies: env.companyRepo,
    customers: env.customerRepo,
    ids: env.ids,
    clock: env.clock,
    chantierTargets: {
      exists: async (target: { companyId: string; linkedEntityId: string }) =>
        target.companyId === env.company.id && tenantChantiers.includes(target.linkedEntityId),
    },
  };
}

describe('DuplicateQuote — « Refaire ce devis » (PR-14)', () => {
  it('duplication propre : matière commerciale copiée, faits légaux/temporels JAMAIS copiés', async () => {
    const env = makeEnv();
    await env.quoteRepo.save(Quote.rehydrate(signedSourceSnapshot(env.company.id)));

    const duplicated = await new DuplicateQuote(deps(env)).execute({
      companyId: env.company.id,
      quoteId: 'quote-source',
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.value.quoteId).not.toBe('quote-source');
    expect(duplicated.value.vatAdjustments).toEqual([]);

    const copy = await env.quoteRepo.findById(duplicated.value.quoteId);
    expect(copy).not.toBeNull();
    const snapshot = copy!.toSnapshot();

    // Copié : la matière commerciale, revalidée par CreateQuote.
    expect(snapshot.customerId).toBe('cust-bernard');
    expect(snapshot.lines.map(({ id: _id, ...line }) => line)).toEqual([
      {
        label: 'Entretien fontaine',
        category: 'labor',
        qty: 2,
        unit: 'passage',
        unitPriceHT: 40_000,
        vatRate: 20,
        discount: { type: 'percent', value: 10 },
      },
      { label: 'Cartouche filtrante', category: 'supply', qty: 3, unitPriceHT: 4_500, vatRate: 20 },
    ]);
    expect(snapshot.depositPct).toBe(30);
    expect(snapshot.globalDiscount).toEqual({ type: 'amount', cents: 5_000 });
    expect(snapshot.retenueGarantiePct).toBe(3);
    expect(snapshot.chantierId).toBe('chantier-bastille');

    // JAMAIS copié : le nouveau devis naît brouillon, sans aucun fait hérité.
    expect(snapshot.status).toBe('draft');
    expect(snapshot.number).toBeNull();
    expect(snapshot.signature).toBeNull();
    expect(snapshot.issuedAt).toBeNull();
    expect(snapshot.retractedAt).toBeNull();
    expect(snapshot.urgentRepair).toBeNull();
    expect(snapshot.purchaseOrder).toBeNull();
    expect(snapshot.validUntil).toBeNull();

    // Le devis source est resté intact (lecture seule).
    const source = (await env.quoteRepo.findById('quote-source'))!.toSnapshot();
    expect(source.status).toBe('signed');
    expect(source.number).toBe('D-2026-0042');
    expect(source.urgentRepair).toEqual({ requestedAt: '2026-04-01T08:00:00.000Z' });
  });

  it('TVA re-suggérée : société passée en franchise 293 B → lignes ramenées à 0, ajustement tracé', async () => {
    const env = makeEnv();
    const franchise = Company.of({ ...env.company.toProps(), vatRegime: 'franchise' });
    if (!franchise.ok) throw new Error('société franchise attendue');
    await env.quoteRepo.save(Quote.rehydrate(signedSourceSnapshot(env.company.id)));

    const duplicated = await new DuplicateQuote({
      ...deps(env),
      companies: {
        ...env.companyRepo,
        findById: async (id: string) => (id === env.company.id ? franchise.value : null),
      },
    }).execute({ companyId: env.company.id, quoteId: 'quote-source' });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.value.vatAdjustments).toEqual([
      { label: 'Entretien fontaine', from: 20, to: 0, reason: 'regime' },
      { label: 'Cartouche filtrante', from: 20, to: 0, reason: 'regime' },
    ]);
    const copy = (await env.quoteRepo.findById(duplicated.value.quoteId))!.toSnapshot();
    expect(copy.lines.every((line) => line.vatRate === 0)).toBe(true);
  });

  it('taux réduit travaux : éligibilité RE-DEMANDÉE — sans re-déclaration, refus actionnable', async () => {
    const env = makeEnv();
    await env.quoteRepo.save(
      Quote.rehydrate(
        signedSourceSnapshot(env.company.id, {
          lines: [{ id: 'line-1', label: 'Remplacement ballon', category: 'labor', qty: 1, unitPriceHT: 90_000, vatRate: 10 }],
        }),
      ),
    );

    const refused = await new DuplicateQuote(deps(env)).execute({
      companyId: env.company.id,
      quoteId: 'quote-source',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== 'domain') throw new Error('refus domaine attendu');
    expect(refused.error.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', rate: 10 });

    // Éligibilité re-déclarée : le taux réduit revit sur la NOUVELLE pièce.
    const eligible = await new DuplicateQuote(deps(env)).execute({
      companyId: env.company.id,
      quoteId: 'quote-source',
      context: { housingOlderThan2y: true },
    });
    expect(eligible.ok).toBe(true);
    if (!eligible.ok) return;
    expect(eligible.value.vatAdjustments).toEqual([]);
    expect((await env.quoteRepo.findById(eligible.value.quoteId))!.toSnapshot().lines[0]?.vatRate).toBe(10);

    // Choix EXPLICITE « Non — TVA 20 % » : repasse au taux normal, tracé.
    const standard = await new DuplicateQuote(deps(env)).execute({
      companyId: env.company.id,
      quoteId: 'quote-source',
      standardRateForReducedLines: true,
    });
    expect(standard.ok).toBe(true);
    if (!standard.ok) return;
    expect(standard.value.vatAdjustments).toEqual([
      { label: 'Remplacement ballon', from: 10, to: 20, reason: 'standard_rate_choice' },
    ]);
    expect((await env.quoteRepo.findById(standard.value.quoteId))!.toSnapshot().lines[0]?.vatRate).toBe(20);
  });

  it('taux 0 hérité d’une franchise quittée : AUCUN taux unique légal → refus honnête, jamais un choix silencieux', async () => {
    const env = makeEnv(); // société au réel normal
    await env.quoteRepo.save(
      Quote.rehydrate(
        signedSourceSnapshot(env.company.id, {
          lines: [{ id: 'line-1', label: 'Entretien fontaine', category: 'labor', qty: 1, unitPriceHT: 40_000, vatRate: 0 }],
        }),
      ),
    );
    const refused = await new DuplicateQuote(deps(env)).execute({
      companyId: env.company.id,
      quoteId: 'quote-source',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== 'domain') throw new Error('refus domaine attendu');
    expect(refused.error.error).toMatchObject({ code: 'VAT_RATE_NOT_APPLICABLE', rate: 0, reason: 'unknown' });
  });

  it('anti-IDOR : un devis d’un autre tenant est introuvable, rien n’est créé', async () => {
    const env = makeEnv();
    await env.quoteRepo.save(Quote.rehydrate(signedSourceSnapshot('company-autre-tenant')));
    const refused = await new DuplicateQuote(deps(env)).execute({
      companyId: env.company.id,
      quoteId: 'quote-source',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.kind).toBe('not_found');
    expect(await env.quoteRepo.listByCompany(env.company.id)).toHaveLength(0);
  });

  it('le site est RE-PROUVÉ par CreateQuote : chantier disparu/hors tenant → refus, rien n’est créé', async () => {
    const env = makeEnv();
    await env.quoteRepo.save(Quote.rehydrate(signedSourceSnapshot(env.company.id)));
    const refused = await new DuplicateQuote(deps(env, [])).execute({
      companyId: env.company.id,
      quoteId: 'quote-source',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({ kind: 'not_found', entity: 'chantier' });
    expect(await env.quoteRepo.listByCompany(env.company.id)).toHaveLength(1); // seul le source
  });

  it('buildQuoteDuplicationInput refuse un client incohérent avec la pièce (garde pure)', () => {
    const env = makeEnv();
    const source = Quote.rehydrate(signedSourceSnapshot(env.company.id));
    const mismatch = buildQuoteDuplicationInput({
      source,
      company: env.company,
      customer: env.customer.id === 'cust-bernard' ? env.customer : env.customer,
    });
    // env.customer EST cust-bernard (fixtures billing) : la garde passe ; on prouve le refus
    // avec un client d'un autre id.
    expect(mismatch.ok).toBe(true);
    const other = buildQuoteDuplicationInput({
      source: Quote.rehydrate(signedSourceSnapshot(env.company.id, { customerId: 'cust-martin' })),
      company: env.company,
      customer: env.customer,
    });
    expect(other.ok).toBe(false);
  });
});
