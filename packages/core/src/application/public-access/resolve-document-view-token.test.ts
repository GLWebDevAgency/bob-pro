import { describe, expect, it } from 'vitest';
import { ResolveDocumentViewToken } from './resolve-document-view-token';
import { type PublicAccessGrant, type PublicAccessTokenRepository } from '../ports/public-access-token';

const clock = { now: () => '2026-06-30T00:00:00.000Z', today: () => '2026-06-30' };

function repoReturning(grant: PublicAccessGrant | null): PublicAccessTokenRepository {
  return {
    create: async () => ({ id: 'x', token: 'x' }),
    findActive: async () => grant,
    markUsed: async () => undefined,
    revoke: async () => undefined,
    revokeActiveFor: async () => undefined,
    revokeAllForCompany: async () => undefined,
  };
}

describe('ResolveDocumentViewToken', () => {
  it('résout un jeton document_view actif (devis)', async () => {
    const grant: PublicAccessGrant = {
      id: 'grant-1',
      companyId: 'co-1',
      resourceType: 'quote',
      resourceId: 'quote-1',
      scope: 'document_view',
      expiresAt: '2026-07-30T00:00:00.000Z',
      revokedAt: null,
    };
    const r = await new ResolveDocumentViewToken({ publicAccessTokens: repoReturning(grant), clock }).execute({
      token: 'pdv_abc',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        grantId: 'grant-1',
        companyId: 'co-1',
        kind: 'quote',
        documentId: 'quote-1',
      });
    }
  });

  it('résout un jeton document_view actif (facture)', async () => {
    const grant: PublicAccessGrant = {
      id: 'grant-2',
      companyId: 'co-9',
      resourceType: 'invoice',
      resourceId: 'invoice-9',
      scope: 'document_view',
      expiresAt: '2026-07-30T00:00:00.000Z',
      revokedAt: null,
    };
    const r = await new ResolveDocumentViewToken({ publicAccessTokens: repoReturning(grant), clock }).execute({
      token: 'pdv_xyz',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ grantId: 'grant-2', companyId: 'co-9', kind: 'invoice', documentId: 'invoice-9' });
  });

  it('rejette un jeton inconnu/expiré/révoqué (findActive → null)', async () => {
    const r = await new ResolveDocumentViewToken({ publicAccessTokens: repoReturning(null), clock }).execute({
      token: 'unknown',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('rejette un jeton d’un AUTRE scope (ex. quote_signature) — jamais mélanger les canaux publics', async () => {
    const grant: PublicAccessGrant = {
      id: 'grant-3',
      companyId: 'co-1',
      resourceType: 'quote',
      resourceId: 'quote-1',
      scope: 'quote_signature',
      expiresAt: '2026-07-30T00:00:00.000Z',
      revokedAt: null,
    };
    const r = await new ResolveDocumentViewToken({ publicAccessTokens: repoReturning(grant), clock }).execute({
      token: 'pst_abc',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });

  it('cross-tenant : le companyId résolu est EXACTEMENT celui du grant, jamais un autre tenant', async () => {
    // Deux jetons distincts, deux tenants distincts : chaque résolution doit rester étanche —
    // aucune fuite de companyId/documentId d'un tenant vers l'autre selon le jeton fourni.
    const grantA: PublicAccessGrant = {
      id: 'grant-a',
      companyId: 'co-A',
      resourceType: 'invoice',
      resourceId: 'invoice-A',
      scope: 'document_view',
      expiresAt: '2026-07-30T00:00:00.000Z',
      revokedAt: null,
    };
    const grantB: PublicAccessGrant = {
      id: 'grant-b',
      companyId: 'co-B',
      resourceType: 'invoice',
      resourceId: 'invoice-B',
      scope: 'document_view',
      expiresAt: '2026-07-30T00:00:00.000Z',
      revokedAt: null,
    };
    const repo: PublicAccessTokenRepository = {
      create: async () => ({ id: 'x', token: 'x' }),
      findActive: async (token) => (token === 'token-a' ? grantA : token === 'token-b' ? grantB : null),
      markUsed: async () => undefined,
      revoke: async () => undefined,
      revokeActiveFor: async () => undefined,
      revokeAllForCompany: async () => undefined,
    };
    const useCase = new ResolveDocumentViewToken({ publicAccessTokens: repo, clock });
    const rA = await useCase.execute({ token: 'token-a' });
    const rB = await useCase.execute({ token: 'token-b' });
    expect(rA.ok && rA.value.companyId).toBe('co-A');
    expect(rA.ok && rA.value.documentId).toBe('invoice-A');
    expect(rB.ok && rB.value.companyId).toBe('co-B');
    expect(rB.ok && rB.value.documentId).toBe('invoice-B');
  });
});
