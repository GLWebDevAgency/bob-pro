import { afterEach, describe, expect, it, vi } from 'vitest';
import { CabinetApiClient, CabinetApiError, type CabinetDossierWrite } from './api';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function dossierPayload(options: { cabinetId?: string; detail?: boolean; revision?: number } = {}) {
  const analysis = {
    trialBalance: {
      rows: [
        { account: '101', label: 'Capital', debitCents: 0, creditCents: 10_000, balanceCents: -10_000 },
        { account: '512', label: 'Banque', debitCents: 10_000, creditCents: 0, balanceCents: 10_000 },
      ],
      totalDebitCents: 10_000,
      totalCreditCents: 10_000,
      balanced: true,
      resultCents: 0,
      revenueCents: 0,
      chargesCents: 0,
    },
    incomeStatement: {
      exploitationProduitsCents: 0,
      exploitationChargesCents: 0,
      resultatExploitationCents: 0,
      financierProduitsCents: 0,
      financierChargesCents: 0,
      resultatFinancierCents: 0,
      resultatCourantCents: 0,
      exceptionnelProduitsCents: 0,
      exceptionnelChargesCents: 0,
      resultatExceptionnelCents: 0,
      participationCents: 0,
      resultatNetAvantImpotCents: 0,
      impotBeneficesCents: 0,
      resultatNetCents: 0,
    },
    balanceSheet: {
      actif: {
        immobilisationsNettesCents: 0,
        stocksCents: 0,
        creancesCents: 0,
        disponibilitesCents: 10_000,
        totalCents: 10_000,
      },
      passif: {
        capitauxPropresCents: 10_000,
        resultatNetCents: 0,
        provisionsCents: 0,
        empruntsCents: 0,
        dettesCents: 0,
        decouvertCents: 0,
        totalCents: 10_000,
      },
      balanced: true,
      ecartCents: 0,
    },
    turnoverCents: 0,
    unbalancedEntries: [],
    checks: {
      entriesBalanced: true,
      trialBalanceBalanced: true,
      balanceSheetBalanced: true,
      resultConsistent: true,
      allPassed: true,
    },
  };
  return {
    id: 'dossier-1',
    cabinetId: options.cabinetId ?? 'cabinet-1',
    siren: '552100554',
    clientName: 'Atelier Martin',
    sourceFileName: '552100554FEC20251231.txt',
    entryCount: 1,
    rowCount: 2,
    period: { from: '2025-01-01', to: '2025-12-31' },
    financial: {
      turnoverCents: 0,
      resultCents: 0,
      totalDebitCents: 10_000,
      totalCreditCents: 10_000,
      trialBalanceBalanced: true,
      balanceSheetBalanced: true,
      statementsConsistent: true,
      balanceSheetDifferenceCents: 0,
    },
    review: { verdict: 'ready', okCount: 4, attentionCount: 0, anomalyCount: 0, infoCount: 1 },
    fiscal: {
      legalForm: 'SASU',
      vatRegime: 'reel_normal',
      incomeTaxRegime: 'IS',
      fiscalYearEnd: '12-31',
      urssafPeriodicity: 'monthly',
      dateCreation: '2020-03-12',
    },
    lastImportedAt: '2026-07-17T08:30:00.000Z',
    revision: options.revision ?? 1,
    createdAt: '2026-07-17T08:30:00.000Z',
    updatedAt: '2026-07-17T08:30:00.000Z',
    ...(options.detail ? { analysis, analysisSha256: 'a'.repeat(64) } : {}),
  };
}

describe('CabinetApiClient', () => {
  it('normalise le contrat liste et transmet le JWT Supabase uniquement en Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      items: [{
        id: 'cabinet-1',
        name: 'Cabinet Martin',
        membership: { id: 'member-1', role: 'admin', status: 'active' },
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new CabinetApiClient('https://api.bob.test/', 'jwt-secret-value');
    await expect(client.listCabinets()).resolves.toEqual([{ id: 'cabinet-1', name: 'Cabinet Martin', role: 'admin' }]);
    expect(fetchMock).toHaveBeenCalledWith('https://api.bob.test/cabinet/v1/cabinets', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer jwt-secret-value' }),
    }));
  });

  it('supporte actorRole pour les vues API domaine directes ou enveloppées', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      items: [{ cabinet: { id: 'cabinet-2', name: 'Cabinet Actor' }, actorRole: 'manager' }],
    })));
    const client = new CabinetApiClient('https://api.bob.test', 'token');
    await expect(client.listCabinets()).resolves.toEqual([{ id: 'cabinet-2', name: 'Cabinet Actor', role: 'manager' }]);
  });

  it('expose les invitations en attente sans jamais recevoir leur jeton brut', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [
        { id: 'i-2', email: 'future@cabinet.fr', role: 'collaborator', status: 'pending', expiresAt: '2026-07-13T00:00:00.000Z' },
        { id: 'i-old', email: 'old@cabinet.fr', role: 'collaborator', status: 'accepted', expiresAt: '2026-07-12T00:00:00.000Z' },
      ], nextCursor: 'i-2', hasMore: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'token');
    await expect(client.listInvitations('cabinet-1')).resolves.toEqual({
      items: [{
        id: 'i-2', email: 'future@cabinet.fr', role: 'collaborator', status: 'pending', expiresAt: '2026-07-13T00:00:00.000Z',
      }],
      nextCursor: 'i-2',
      hasMore: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.bob.test/cabinet/v1/cabinets/cabinet-1/invitations?limit=50');
    await expect(client.revokeInvitation('cabinet-1', 'i/2')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.bob.test/cabinet/v1/cabinets/cabinet-1/invitations/i%2F2');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('envoie le jeton d’invitation dans le corps et jamais dans l’URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ cabinet: {}, membership: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'access-token');

    await client.acceptInvitation('invitation-secret');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.bob.test/cabinet/v1/invitations/accept');
    expect(url).not.toContain('invitation-secret');
    expect(init.body).toBe(JSON.stringify({ token: 'invitation-secret' }));
  });

  it('normalise membres et invitation, puis conserve le code métier des erreurs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'm-1', userId: 'u-1', email: 'membre@cabinet.fr', role: 'collaborator', status: 'active', joinedAt: null, updatedAt: '2026-07-12T00:00:00.000Z' }], nextCursor: null, hasMore: false }))
      .mockResolvedValueOnce(jsonResponse({ data: { invitation: { id: 'i-1', email: 'pro@cabinet.fr', role: 'collaborator', status: 'pending', expiresAt: '2026-07-14T00:00:00.000Z' } } }, 201))
      .mockResolvedValueOnce(jsonResponse({ code: 'CABINET_LAST_ADMIN_REQUIRED' }, 422));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'access-token');

    await expect(client.listMembers('cabinet/1')).resolves.toEqual({
      items: [expect.objectContaining({ id: 'm-1', email: 'membre@cabinet.fr' })],
      nextCursor: null,
      hasMore: false,
    });
    await expect(client.inviteMember('cabinet/1', { email: 'pro@cabinet.fr', role: 'collaborator' })).resolves.toMatchObject({ id: 'i-1' });
    await expect(client.updateMember('cabinet/1', 'm-1', { status: 'revoked' })).rejects.toMatchObject({
      status: 422,
      code: 'CABINET_LAST_ADMIN_REQUIRED',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain('cabinet%2F1');
  });

  it('refuse une origine HTTP distante avant toute requête', () => {
    expect(() => new CabinetApiClient('http://api.example.com', 'token')).toThrow(CabinetApiError);
  });

  it('rejette les listes 200 malformées au lieu de les transformer en état vide', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'cabinet-1', name: 'Valide', actorRole: 'admin' }, {}] }))
      .mockResolvedValueOnce(jsonResponse({ unexpected: [] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'member-broken' }], nextCursor: null, hasMore: false }))
      .mockResolvedValueOnce(jsonResponse({ items: [
        { id: 'i-pending', email: 'ok@cabinet.fr', role: 'collaborator', status: 'pending', expiresAt: '2026-07-13T00:00:00.000Z' },
        { id: 'i-broken', status: 'accepted' },
      ], nextCursor: null, hasMore: false }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'token');

    await expect(client.listCabinets()).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
    await expect(client.listCabinets()).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
    await expect(client.listMembers('cabinet-1')).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
    await expect(client.listInvitations('cabinet-1')).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('rejette les dates non ISO ou non représentables avant le rendu', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          id: 'm-1', userId: 'u-1', role: 'collaborator', status: 'active',
          joinedAt: 'date-invalide', updatedAt: '2026-07-12T00:00:00.000Z',
        }],
        nextCursor: null,
        hasMore: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          id: 'i-1', email: 'pro@cabinet.fr', role: 'collaborator', status: 'pending',
          expiresAt: '2026-99-99T00:00:00.000Z',
        }],
        nextCursor: null,
        hasMore: false,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'token');

    await expect(client.listMembers('cabinet-1')).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
    await expect(client.listInvitations('cabinet-1')).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('encode le curseur et rejette une pagination d’invitations incohérente', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null, hasMore: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'token');

    await expect(client.listInvitations('cabinet-1', 'invite/50')).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.bob.test/cabinet/v1/cabinets/cabinet-1/invitations?limit=50&cursor=invite%2F50',
    );
  });

  it('charge les dossiers depuis le cabinet demandé et rejette toute réponse cross-tenant', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [dossierPayload()], nextCursor: null, hasMore: false }))
      .mockResolvedValueOnce(jsonResponse({ items: [dossierPayload({ cabinetId: 'cabinet-b' })], nextCursor: null, hasMore: false }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'token');

    await expect(client.listDossiers('cabinet-1')).resolves.toMatchObject({
      items: [{ id: 'dossier-1', cabinetId: 'cabinet-1', siren: '552100554', revision: 1 }],
      hasMore: false,
    });
    await expect(client.listDossiers('cabinet-1')).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.bob.test/cabinet/v1/cabinets/cabinet-1/dossiers?limit=50',
    );
  });

  it('valide la fiche détaillée et refuse une synthèse comptable incohérente', async () => {
    const invalid = dossierPayload({ detail: true });
    invalid.financial.totalDebitCents = 10_001;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(dossierPayload({ detail: true })))
      .mockResolvedValueOnce(jsonResponse(invalid));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'token');

    await expect(client.getDossier('cabinet-1', '552100554')).resolves.toMatchObject({
      analysisSha256: 'a'.repeat(64),
      financial: { totalDebitCents: 10_000 },
    });
    await expect(client.getDossier('cabinet-1', '552100554')).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
    });
  });

  it('porte le CAS dans If-None-Match / If-Match pour créer, remplacer et supprimer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(dossierPayload({ detail: true })))
      .mockResolvedValueOnce(jsonResponse(dossierPayload({ detail: true, revision: 2 })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CabinetApiClient('https://api.bob.test', 'token');
    const detail = dossierPayload({ detail: true });
    const write: CabinetDossierWrite = {
      siren: detail.siren,
      clientName: detail.clientName,
      sourceFileName: detail.sourceFileName,
      entryCount: detail.entryCount,
      rowCount: detail.rowCount,
      period: detail.period,
      analysis: detail.analysis!,
      review: { verdict: 'ready', okCount: 4, attentionCount: 0, anomalyCount: 0, infoCount: 1 },
      fiscal: {
        legalForm: 'SASU',
        vatRegime: 'reel_normal',
        incomeTaxRegime: 'IS',
        fiscalYearEnd: '12-31',
        urssafPeriodicity: 'monthly',
        dateCreation: '2020-03-12',
      },
      expectedRevision: null,
    };

    await client.saveDossier('cabinet-1', write);
    await client.saveDossier('cabinet-1', { ...write, expectedRevision: 1 });
    await client.deleteDossier('cabinet-1', write.siren, 2);

    const [, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const [, deleteInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(createInit).toMatchObject({ method: 'PUT', headers: { 'If-None-Match': '*' } });
    expect(updateInit).toMatchObject({ method: 'PUT', headers: { 'If-Match': '"1"' } });
    expect(deleteInit).toMatchObject({ method: 'DELETE', headers: { 'If-Match': '"2"' } });
    expect(JSON.parse(String(createInit.body))).not.toHaveProperty('expectedRevision');
  });
});
