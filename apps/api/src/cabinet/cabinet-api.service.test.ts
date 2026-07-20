import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification, NotificationPort } from '@bob/core';
import { CabinetApiService } from './cabinet-api.service';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import { Metrics } from '../observability/metrics';
import { requestContext, type AppLogger, type Principal } from '../observability/logger';
import type { SupabaseAdminPort } from '../auth/supabase-admin';

class CapturingNotifier implements NotificationPort {
  readonly sent: Notification[] = [];
  shouldFail = false;

  async send(notification: Notification): Promise<void> {
    this.sent.push(notification);
    if (this.shouldFail) throw new Error(`provider reflected body: ${notification.body}`);
  }
}

function logger(): AppLogger {
  return {
    audit: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  } as unknown as AppLogger;
}

function asPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'cabinet-test', principal }, fn);
}

function invitationToken(notification: Notification): string {
  const match = notification.body.match(/#invitation=([^\s]+)/);
  if (!match?.[1]) throw new Error('Invitation fragment missing from email.');
  return decodeURIComponent(match[1]);
}

describe('CabinetApiService — vertical Slice 0 in-memory', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('CABINET_RELEASE_ENV', 'development');
    vi.stubEnv('CABINET_INVITATION_WEB_BASE_URL', 'https://cabinet.example.test/cabinet');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setup() {
    const persistence = new InMemoryPersistence();
    const notifier = new CapturingNotifier();
    const verifiedEmailByUserId: Readonly<Partial<Record<string, string>>> = {
      'expert-admin': 'admin@cabinet.test',
      'expert-collab': 'collab@cabinet.test',
      'expert-manager': 'manager@cabinet.test',
      intrus: 'intrus@cabinet.test',
      '79e27b85-d458-445e-a759-e8b1a49e1641': 'worker@cabinet.test',
    };
    const supabaseAdmin = {
      setUserCompanyId: vi.fn(async () => undefined),
      getVerifiedEmail: vi.fn(async (userId: string) => verifiedEmailByUserId[userId] ?? null),
      getUserIdentity: vi.fn(async (userId: string) => ({
        email: verifiedEmailByUserId[userId] ?? null,
        displayName: null,
      })),
      deleteUser: vi.fn(async () => undefined),
    };
    const metrics = new Metrics();
    const service = new CabinetApiService(persistence, notifier, supabaseAdmin, metrics, logger());
    return { persistence, notifier, service, metrics, supabaseAdmin };
  }

  const admin: Principal = {
    userId: 'expert-admin',
    companyId: null,
    email: 'admin@cabinet.test',
    emailVerified: true,
  };

  it('crée le cabinet et son premier admin, puis le relit depuis la membership DB', async () => {
    const { service } = setup();
    const created = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));

    expect(created).toMatchObject({
      name: 'Cabinet Atlas',
      timeZone: 'Europe/Paris',
      actorRole: 'admin',
      membership: { role: 'admin', status: 'active' },
    });
    const listed = await asPrincipal(admin, () => service.listCabinets());
    expect(listed.items).toHaveLength(1);
    expect((await asPrincipal(admin, () => service.listMembers(created.id))).items).toHaveLength(1);
  });

  it('invite, livre sans log/query token, puis accepte atomiquement avec l’email JWT vérifié', async () => {
    const { notifier, service } = setup();
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    const invited = await asPrincipal(admin, () =>
      service.inviteMember(cabinet.id, { email: 'collab@cabinet.test', role: 'collaborator' }),
    );

    expect(invited.delivery.status).toBe('done');
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(notifier.sent[0]?.body).toContain('https://cabinet.example.test/cabinet#invitation=');
    expect(notifier.sent[0]?.body).not.toContain('?token=');

    const collaborator: Principal = {
      userId: 'expert-collab',
      companyId: null,
      email: 'collab@cabinet.test',
      emailVerified: true,
    };
    const accepted = await asPrincipal(collaborator, () =>
      service.acceptInvitation({ token: invitationToken(notifier.sent[0]!) }),
    );
    expect(accepted.membership).toMatchObject({ role: 'collaborator', status: 'active' });
    expect(accepted.cabinet.id).toBe(cabinet.id);
    expect((await asPrincipal(admin, () => service.listMembers(cabinet.id))).items).toHaveLength(2);
  });

  it('refuse email non vérifié/mismatched et protège le dernier admin', async () => {
    const { notifier, service, supabaseAdmin } = setup();
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    const members = await asPrincipal(admin, () => service.listMembers(cabinet.id));

    await expect(
      asPrincipal(admin, () => service.updateMember(cabinet.id, members.items[0]!.id, { status: 'revoked' })),
    ).rejects.toMatchObject({ status: 409 });

    await asPrincipal(admin, () =>
      service.inviteMember(cabinet.id, { email: 'cible@cabinet.test', role: 'collaborator' }),
    );
    const token = invitationToken(notifier.sent[0]!);
    const wrongEmail: Principal = {
      userId: 'intrus',
      companyId: null,
      email: 'intrus@cabinet.test',
      emailVerified: true,
    };
    // Parité RLS : porteur non destinataire d'un jeton VALIDE → réponse strictement identique à
    // un jeton inconnu (404 CABINET_INVITATION_INVALID). Ne jamais confirmer la validité du jeton.
    await expect(asPrincipal(wrongEmail, () => service.acceptInvitation({ token }))).rejects.toMatchObject({
      status: 404,
      response: { code: 'CABINET_INVITATION_INVALID' },
    });
    await expect(
      asPrincipal(wrongEmail, () => service.acceptInvitation({ token: 'jeton-vole-inconnu' })),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'CABINET_INVITATION_INVALID' },
    });
    const unverified = { ...wrongEmail, email: 'cible@cabinet.test', emailVerified: false };
    supabaseAdmin.getVerifiedEmail.mockResolvedValueOnce(null);
    await expect(asPrincipal(unverified, () => service.acceptInvitation({ token }))).rejects.toMatchObject({ status: 403 });
  });

  it('échoue fermé sans vérification Supabase Admin, même si DEMO_MODE est actif', async () => {
    const { persistence, notifier, service, metrics } = setup();
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    await asPrincipal(admin, () =>
      service.inviteMember(cabinet.id, { email: 'collab@cabinet.test', role: 'collaborator' }),
    );
    const unavailableAdmin: SupabaseAdminPort = {
      setUserCompanyId: async () => undefined,
      deleteUser: async () => undefined,
    };
    const failClosed = new CabinetApiService(
      persistence,
      notifier,
      unavailableAdmin,
      metrics,
      logger(),
    );
    const collaborator: Principal = {
      userId: 'expert-collab',
      companyId: null,
      email: 'collab@cabinet.test',
      emailVerified: true,
    };

    await expect(
      asPrincipal(collaborator, () =>
        failClosed.acceptInvitation({ token: invitationToken(notifier.sent[0]!) }),
      ),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'CABINET_IDENTITY_PROVIDER_UNAVAILABLE' },
    });
  });

  it('garde l’invitation dans une outbox failed lorsque le mailer tombe', async () => {
    const { persistence, notifier, service } = setup();
    notifier.shouldFail = true;
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    const invited = await asPrincipal(admin, () =>
      service.inviteMember(cabinet.id, { email: 'retry@cabinet.test', role: 'collaborator' }),
    );

    expect(invited.delivery.status).toBe('failed');
    expect(notifier.sent).toHaveLength(1);
    const rawToken = invitationToken(notifier.sent[0]!);
    expect(JSON.stringify(persistence.cabinet.snapshot?.())).not.toContain(rawToken);
  });

  it('pagine les invitations pending sans troncature silencieuse', async () => {
    const { service } = setup();
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    for (const email of ['a@cabinet.test', 'b@cabinet.test', 'c@cabinet.test']) {
      await asPrincipal(admin, () => service.inviteMember(cabinet.id, { email, role: 'collaborator' }));
    }

    const first = await asPrincipal(admin, () => service.listInvitations(cabinet.id, { limit: 2 }));
    expect(first).toMatchObject({ hasMore: true });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await asPrincipal(admin, () =>
      service.listInvitations(cabinet.id, { limit: 2, cursor: first.nextCursor! }),
    );
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(second.items).toHaveLength(1);
  });

  it('expire via la requête worker bornée et publie les jauges de rétention', async () => {
    const { service, metrics } = setup();
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    await asPrincipal(admin, () =>
      service.inviteMember(cabinet.id, { email: 'expire@cabinet.test', role: 'collaborator' }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 73 * 60 * 60_000));
    try {
      await asPrincipal(admin, () => service.processInvitationDeliveries(cabinet.id, admin.userId, 10));
      expect((await asPrincipal(admin, () => service.listInvitations(cabinet.id))).items).toHaveLength(0);
      const rendered = await metrics.registry.metrics();
      expect(rendered).toContain('cabinet_invitation_worker_last_success_unixtime');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejette un statut runtime inconnu sans le transformer en révocation', async () => {
    const { service } = setup();
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    const before = await asPrincipal(admin, () => service.listMembers(cabinet.id));

    await expect(
      asPrincipal(admin, () =>
        service.updateMember(cabinet.id, before.items[0]!.id, { status: 'banana' as never }),
      ),
    ).rejects.toMatchObject({ status: 422 });

    const after = await asPrincipal(admin, () => service.listMembers(cabinet.id));
    expect(after.items[0]?.status).toBe('active');
  });

  it('empêche un manager de faire partir une invitation privilégiée via le retry outbox', async () => {
    const { notifier, service } = setup();
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    await asPrincipal(admin, () =>
      service.inviteMember(cabinet.id, { email: 'manager@cabinet.test', role: 'manager' }),
    );
    const manager: Principal = {
      userId: 'expert-manager',
      companyId: null,
      email: 'manager@cabinet.test',
      emailVerified: true,
    };
    await asPrincipal(manager, () => service.acceptInvitation({ token: invitationToken(notifier.sent[0]!) }));

    // Invitation ADMIN dont la livraison échoue : elle reste en outbox `failed`, re-livrable.
    notifier.shouldFail = true;
    await asPrincipal(admin, () => service.inviteMember(cabinet.id, { email: 'boss@cabinet.test', role: 'admin' }));
    notifier.shouldFail = false;
    const sentBefore = notifier.sent.length;

    const future = new Date(Date.now() + 10 * 60_000);
    vi.useFakeTimers();
    vi.setSystemTime(future);
    try {
      // Parité app_can_manage_invitation_delivery : le manager ne claim jamais une livraison
      // d'invitation admin/manager — en prod la RLS renvoie 0 ligne, en démo le port mémoire aussi.
      const managerRetry = await asPrincipal(manager, () => service.retryInvitationDeliveries(cabinet.id));
      expect(managerRetry.status).toBe('idle');
      expect(notifier.sent).toHaveLength(sentBefore);

      // Contrôle positif : un admin relivre la même invitation (le déni manager est bien un filtre).
      const adminRetry = await asPrincipal(admin, () => service.retryInvitationDeliveries(cabinet.id));
      expect(adminRetry.status).toBe('done');
      expect(notifier.sent).toHaveLength(sentBefore + 1);
      expect(notifier.sent.at(-1)?.idempotencyKey).toBe(notifier.sent.at(-2)?.idempotencyKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it('interdit à un admin applicatif de désactiver le principal worker d’un pilote', async () => {
    const { notifier, service } = setup();
    const cabinet = await asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet Atlas' }));
    const worker: Principal = {
      userId: '79e27b85-d458-445e-a759-e8b1a49e1641',
      companyId: null,
      email: 'worker@cabinet.test',
      emailVerified: true,
    };
    await asPrincipal(admin, () =>
      service.inviteMember(cabinet.id, { email: worker.email!, role: 'admin' }),
    );
    await asPrincipal(worker, () => service.acceptInvitation({ token: invitationToken(notifier.sent[0]!) }));
    const roster = await asPrincipal(admin, () => service.listMembers(cabinet.id));
    const workerMember = roster.items.find((member) => member.userId === worker.userId)!;
    vi.stubEnv('CABINET_INVITATION_WORKER_ENABLED', 'true');
    vi.stubEnv('CABINET_INVITATION_WORKER_USER_ID', worker.userId);
    vi.stubEnv('JOB_CABINET_IDS', cabinet.id);

    await expect(
      asPrincipal(admin, () => service.updateMember(cabinet.id, workerMember.id, { status: 'revoked' })),
    ).rejects.toMatchObject({ status: 409, response: { code: 'CABINET_WORKER_MEMBERSHIP_IMMUTABLE' } });
  });

  it('ferme toutes les routes métier si le flag est absent dans l’environnement', async () => {
    const { service } = setup();
    vi.stubEnv('CABINET_RELEASE_ENV', 'production');

    expect(await asPrincipal(admin, () => service.availability())).toMatchObject({ enabled: false, source: 'missing' });
    await expect(asPrincipal(admin, () => service.createCabinet({ name: 'Cabinet fermé' }))).rejects.toMatchObject({
      status: 404,
    });
  });
});
