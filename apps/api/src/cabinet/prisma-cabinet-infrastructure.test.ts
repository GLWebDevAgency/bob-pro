import { describe, expect, it } from 'vitest';
import { cabinetMemberRowChanged } from './prisma-cabinet-infrastructure';

const AT = '2026-07-12T09:00:00.000Z';

describe('cabinetMemberRowChanged — parité ligne Prisma / snapshot domaine', () => {
  it('ne marque pas modifiée une membership active identique (piège undefined vs null)', () => {
    // Régression auditée : `row.suspendedAt?.toISOString()` vaut undefined quand la colonne est
    // NULL, alors que le snapshot porte null. Sans normalisation, TOUTE membership active était
    // « changed » : UPDATE parasite de la ligne du fondateur filtré par cabinet_member_update
    // (accept/mutation manager → 409) ou rejeté par le trigger sur une ligne revoked (→ 500).
    expect(
      cabinetMemberRowChanged(
        { role: 'admin', status: 'active', suspendedAt: null, revokedAt: null },
        { role: 'admin', status: 'active', suspendedAt: null, revokedAt: null },
      ),
    ).toBe(false);
  });

  it('ne marque pas modifiée une membership revoked identique', () => {
    expect(
      cabinetMemberRowChanged(
        { role: 'collaborator', status: 'revoked', suspendedAt: null, revokedAt: new Date(AT) },
        { role: 'collaborator', status: 'revoked', suspendedAt: null, revokedAt: AT },
      ),
    ).toBe(false);
  });

  it('ne marque pas modifiée une membership suspendue identique', () => {
    expect(
      cabinetMemberRowChanged(
        { role: 'manager', status: 'suspended', suspendedAt: new Date(AT), revokedAt: null },
        { role: 'manager', status: 'suspended', suspendedAt: AT, revokedAt: null },
      ),
    ).toBe(false);
  });

  it('détecte les vraies transitions', () => {
    expect(
      cabinetMemberRowChanged(
        { role: 'collaborator', status: 'active', suspendedAt: null, revokedAt: null },
        { role: 'manager', status: 'active', suspendedAt: null, revokedAt: null },
      ),
    ).toBe(true);
    expect(
      cabinetMemberRowChanged(
        { role: 'collaborator', status: 'active', suspendedAt: null, revokedAt: null },
        { role: 'collaborator', status: 'suspended', suspendedAt: AT, revokedAt: null },
      ),
    ).toBe(true);
    expect(
      cabinetMemberRowChanged(
        { role: 'collaborator', status: 'suspended', suspendedAt: new Date(AT), revokedAt: null },
        { role: 'collaborator', status: 'revoked', suspendedAt: AT, revokedAt: AT },
      ),
    ).toBe(true);
  });
});
