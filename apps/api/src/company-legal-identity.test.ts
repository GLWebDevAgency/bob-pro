import { describe, expect, it, vi } from 'vitest';
import { Company } from '@bob/core';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

/**
 * CUL-DE-SAC D'ÉMISSION (bug de production, terrain fondateur 20/07).
 *
 * En base de prod, la société du fondateur (SAS) avait `rcsOrRm` VIDE. Or
 * `Company.assertCanIssue()` l'exige avant toute émission (art. R123-237 c. com. : le n° unique
 * d'identification suivi de « RCS » et de la ville du greffe est une mention OBLIGATOIRE des
 * factures). Le blocage est légitime — mais AUCUN endpoint n'écrivait `rcsOrRm` ni l'adresse
 * après l'onboarding : `COMPANY_REGISTRATION_FIELDS` ne sert qu'à POST /onboarding/company,
 * /company/profile ne porte que trade/vatRegime, /company/billing que iban/bic. L'utilisateur
 * était donc DÉFINITIVEMENT empêché d'émettre la moindre facture.
 *
 * Ces tests verrouillent la sortie de secours : PATCH /company/legal écrit désormais les DEUX
 * données qu'exige `assertCanIssue`.
 */

const OWNER: Principal = { userId: 'owner-legal-identity', companyId: MERCIER_PROPS.id };

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'company-legal-identity', principal: OWNER }, run);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async () => new TextEncoder().encode('%PDF-1.7')),
    renderQuote: vi.fn(async () => new TextEncoder().encode('%PDF-1.7')),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async () => ({ id: 'job', status: 'pending' })),
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const logger = {
    audit: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  } as unknown as AppLogger;
  const metrics = {
    aiRequests: { inc: vi.fn() },
    aiDuration: { observe: vi.fn() },
    aiGuardViolations: { inc: vi.fn() },
  } as unknown as Metrics;
  const service = new BackendService(
    persistence,
    {} as PaymentGatewayPort,
    renderer,
    {} as OcrPort,
    { setUserCompanyId: vi.fn(), deleteUser: vi.fn() },
    notificationDelivery,
    metrics,
    logger,
    undefined,
    new InMemoryDocumentStorage(),
  );
  return { persistence, service, logger };
}

/** Rejoue EXACTEMENT la fiche de production : SAS, adresse connue, n° d'immatriculation VIDE. */
async function seedCompanyWithoutRegistration(persistence: InMemoryPersistence): Promise<void> {
  await persistence.seed();
  const { rcsOrRm: _dropped, ...withoutRegistration } = MERCIER_PROPS;
  const company = Company.of({
    ...withoutRegistration,
    name: 'FLY SERVICES',
    legalForm: 'SAS',
    address: { line1: '19 QUAI DE LA SEINE', zip: '75019', city: 'PARIS' },
  });
  if (!company.ok) throw new Error('fixture: Company.of KO');
  persistence.companies.seed(company.value);
}

describe('PATCH /company/legal — sortie du cul-de-sac d’émission', () => {
  it('part bien de l’état bloqué observé en production (assertCanIssue KO)', async () => {
    const { persistence, service } = makeService();
    await seedCompanyWithoutRegistration(persistence);
    await asOwner(async () => {
      const me = await service.getCompanyMe();
      expect(me.ok).toBe(true);
      if (!me.ok) return;
      expect(me.value.rcsOrRm).toBeUndefined();
      const company = Company.of(me.value);
      expect(company.ok).toBe(true);
      if (!company.ok) return;
      const canIssue = company.value.assertCanIssue();
      expect(canIssue.ok).toBe(false);
      if (canIssue.ok) return;
      expect(canIssue.error.field).toBe('rcsOrRm');
    });
  });

  it('écrit le n° d’immatriculation et débloque l’émission', async () => {
    const { persistence, service } = makeService();
    await seedCompanyWithoutRegistration(persistence);
    await asOwner(async () => {
      const updated = await service.updateCompanyLegal({ rcsOrRm: '732 829 320 RCS Paris' });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.rcsOrRm).toBe('732 829 320 RCS Paris');

      // LE critère du chantier : la société peut désormais émettre.
      const company = Company.of(updated.value);
      expect(company.ok).toBe(true);
      if (!company.ok) return;
      expect(company.value.assertCanIssue().ok).toBe(true);

      // Persisté (pas seulement renvoyé) : la relecture voit la même valeur.
      const me = await service.getCompanyMe();
      expect(me.ok && me.value.rcsOrRm).toBe('732 829 320 RCS Paris');
    });
  });

  it('écrit l’adresse du siège — l’AUTRE exigence d’assertCanIssue', async () => {
    const { persistence, service } = makeService();
    await persistence.seed();
    await asOwner(async () => {
      const updated = await service.updateCompanyLegal({
        address: { line1: '19 quai de la Seine', zip: '75019', city: 'Paris' },
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.address).toEqual({
        line1: '19 quai de la Seine',
        zip: '75019',
        city: 'Paris',
      });
    });
  });

  it('reste PARTIEL : un champ omis n’est jamais réinjecté ni effacé par accident', async () => {
    const { persistence, service } = makeService();
    await persistence.seed(); // Mercier : rcsOrRm « RM 92 », adresse Nanterre.
    await asOwner(async () => {
      // Écrit UNIQUEMENT le capital : ni le n° d'immatriculation ni l'adresse ne bougent.
      const updated = await service.updateCompanyLegal({ capitalSocialCents: null });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.rcsOrRm).toBe('RM 92');
      expect(updated.value.address).toEqual(MERCIER_PROPS.address);

      // Écrit UNIQUEMENT l'adresse : le n° d'immatriculation reste intact.
      const moved = await service.updateCompanyLegal({
        address: { line1: '1 rue Neuve', zip: '92000', city: 'Nanterre' },
      });
      expect(moved.ok && moved.value.rcsOrRm).toBe('RM 92');
    });
  });

  it('permet l’effacement EXPLICITE du n° d’immatriculation (null), qui rebloque l’émission', async () => {
    const { persistence, service } = makeService();
    await persistence.seed();
    await asOwner(async () => {
      const erased = await service.updateCompanyLegal({ rcsOrRm: null });
      expect(erased.ok).toBe(true);
      if (!erased.ok) return;
      expect(erased.value.rcsOrRm).toBeUndefined();
      const company = Company.of(erased.value);
      expect(company.ok && company.value.assertCanIssue().ok).toBe(false);
    });
  });

  it('trace le changement dans le journal d’audit (traçabilité des mentions imprimées)', async () => {
    const { persistence, service, logger } = makeService();
    await seedCompanyWithoutRegistration(persistence);
    await asOwner(async () => {
      await service.updateCompanyLegal({
        rcsOrRm: '732 829 320 RCS Paris',
        address: { line1: '19 quai de la Seine', zip: '75019', city: 'Paris' },
      });
    });
    expect(logger.audit).toHaveBeenCalledWith(
      'company.legal_updated',
      expect.objectContaining({ rcsOrRmChanged: true, addressChanged: true }),
    );
  });
});
