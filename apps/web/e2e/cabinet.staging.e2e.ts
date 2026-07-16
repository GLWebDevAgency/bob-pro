import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { loadCabinetStagingE2EConfig, type CabinetStagingE2EConfig } from './support/config';
import { invitationTokenFromLink, isSupabaseMagicLink } from './support/links';
import { MailosaurInbox } from './support/mailosaur';

interface AccessTokenCapture {
  readonly wait: () => Promise<string>;
}

function captureCabinetAccessToken(page: Page, apiBaseUrl: string): AccessTokenCapture {
  let token: string | null = null;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== apiBaseUrl || !url.pathname.startsWith('/cabinet/v1/')) return;
    const authorization = request.headers().authorization;
    if (authorization?.startsWith('Bearer ') && authorization.length < 4_096) token = authorization.slice(7);
  });
  return {
    wait: async () => {
      await expect.poll(() => token, { timeout: 30_000 }).not.toBeNull();
      if (token === null) throw new Error('Cabinet staging did not observe an authenticated API request.');
      return token;
    },
  };
}

async function primeVercelBypass(
  context: BrowserContext,
  webBaseUrl: string,
  secret: string | null,
): Promise<void> {
  if (secret === null) return;
  const response = await context.request.get(`${webBaseUrl}/cabinet`, {
    headers: {
      'x-vercel-protection-bypass': secret,
      'x-vercel-set-bypass-cookie': 'true',
    },
  });
  expect(response.status()).toBeLessThan(400);
  await response.dispose();
}

async function signInWithRealMagicLink(input: {
  readonly page: Page;
  readonly email: string;
  readonly config: CabinetStagingE2EConfig;
  readonly inbox: MailosaurInbox;
}): Promise<void> {
  await input.page.goto(`${input.config.webBaseUrl}/cabinet`);
  await expect(input.page.getByRole('heading', { name: 'Pilotez le cabinet avec Bob.' })).toBeVisible();

  const requestedAfter = new Date(Date.now() - 2_000);
  await input.page.getByLabel('Adresse professionnelle').fill(input.email);
  await input.page.getByRole('button', { name: 'Recevoir mon lien de connexion' }).click();
  await expect(input.page.getByRole('heading', { name: 'Consultez votre boîte de réception' })).toBeVisible();

  const magicLink = await input.inbox.waitForLink({
    sentTo: input.email,
    receivedAfter: requestedAfter,
    accepts: (link) => isSupabaseMagicLink(link, input.config.supabaseUrl, input.config.webBaseUrl),
  });
  await input.page.evaluate((url) => window.location.assign(url), magicLink.toString());
  await input.page.waitForURL(`${input.config.webBaseUrl}/cabinet**`, { timeout: 60_000 });
}

async function cabinetRequest(
  config: CabinetStagingE2EConfig,
  token: string,
  path: string,
): Promise<Response> {
  return fetch(`${config.apiBaseUrl}/cabinet/v1${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
}

async function assertRelease(config: CabinetStagingE2EConfig): Promise<void> {
  const response = await fetch(`${config.apiBaseUrl}/health/ready`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.status).toBe(200);
  const payload: unknown = await response.json();
  const release = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>).release
    : null;
  expect(release).toMatchObject({ sha: config.expectedReleaseSha, environment: 'staging' });
}

test('CAB-0: invitation réelle, isolation tenant et révocation immédiate', async ({ browser, page }) => {
  const config = loadCabinetStagingE2EConfig();
  const inbox = new MailosaurInbox(config.mailosaurServerId, config.mailosaurApiKey);
  await assertRelease(config);
  await primeVercelBypass(page.context(), config.webBaseUrl, config.vercelBypassSecret);

  const adminTokenCapture = captureCabinetAccessToken(page, config.apiBaseUrl);
  await signInWithRealMagicLink({ page, email: config.adminEmail, config, inbox });
  await expect(page.getByRole('heading', { name: 'Fondations de votre espace cabinet' })).toBeVisible();
  await expect(page.getByLabel('Cabinet actif')).toHaveValue(config.primaryCabinetId);
  const adminToken = await adminTokenCapture.wait();

  const adminForeignAccess = await cabinetRequest(config, adminToken, `/cabinets/${config.foreignCabinetId}`);
  expect(adminForeignAccess.status).toBe(404);

  await page.getByRole('button', { name: 'Équipe', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Équipe du cabinet' })).toBeVisible();
  const invitationRequestedAfter = new Date(Date.now() - 2_000);
  await page.getByLabel('Adresse professionnelle').fill(config.collaboratorEmail);
  await page.getByLabel('Rôle proposé').selectOption('collaborator');
  await page.getByRole('button', { name: 'Envoyer l’invitation' }).click();
  await expect(page.getByRole('status')).toBeVisible();

  const invitationLink = await inbox.waitForLink({
    sentTo: config.collaboratorEmail,
    receivedAfter: invitationRequestedAfter,
    accepts: (link) => invitationTokenFromLink(link, config.webBaseUrl) !== null,
  });
  const invitationToken = invitationTokenFromLink(invitationLink, config.webBaseUrl);
  if (invitationToken === null) throw new Error('Cabinet staging invitation email did not contain a valid token.');

  const collaboratorContext = await browser.newContext();
  try {
    await primeVercelBypass(collaboratorContext, config.webBaseUrl, config.vercelBypassSecret);
    const stash = await collaboratorContext.request.post(`${config.webBaseUrl}/auth/invitation/stash`, {
      headers: { Origin: config.webBaseUrl },
      data: { token: invitationToken },
    });
    expect(stash.status()).toBe(200);
    await stash.dispose();

    const collaboratorPage = await collaboratorContext.newPage();
    const collaboratorTokenCapture = captureCabinetAccessToken(collaboratorPage, config.apiBaseUrl);
    await signInWithRealMagicLink({
      page: collaboratorPage,
      email: config.collaboratorEmail,
      config,
      inbox,
    });
    await expect(collaboratorPage.getByRole('heading', { name: 'Fondations de votre espace cabinet' })).toBeVisible();
    await expect(collaboratorPage.getByLabel('Cabinet actif')).toHaveValue(config.primaryCabinetId);
    const collaboratorToken = await collaboratorTokenCapture.wait();

    const foreignAccess = await cabinetRequest(config, collaboratorToken, `/cabinets/${config.foreignCabinetId}`);
    expect(foreignAccess.status).toBe(404);
    await collaboratorPage.getByRole('button', { name: 'Équipe', exact: true }).click();
    await expect(collaboratorPage.getByRole('heading', { name: 'Équipe du cabinet' })).toBeVisible();
    await expect(collaboratorPage.getByRole('heading', { name: 'Inviter un membre' })).toHaveCount(0);
    await expect(collaboratorPage.getByText('Invitations en attente', { exact: true })).toHaveCount(0);

    const replayStash = await collaboratorContext.request.post(`${config.webBaseUrl}/auth/invitation/stash`, {
      headers: { Origin: config.webBaseUrl },
      data: { token: invitationToken },
    });
    expect(replayStash.status()).toBe(200);
    await replayStash.dispose();
    const replay = await collaboratorContext.request.post(`${config.webBaseUrl}/auth/invitation/accept`, {
      headers: { Origin: config.webBaseUrl },
    });
    expect(replay.status()).toBe(404);
    await replay.dispose();

    await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
    const memberRow = page.getByRole('row').filter({ hasText: config.collaboratorEmail });
    await expect(memberRow).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept());
    await memberRow.getByRole('button', { name: 'Révoquer', exact: true }).click();
    await expect(memberRow.getByText('Révoqué', { exact: true })).toBeVisible();

    const revokedAccess = await cabinetRequest(config, collaboratorToken, `/cabinets/${config.primaryCabinetId}`);
    expect(revokedAccess.status).toBe(404);
    await collaboratorPage.reload();
    await expect(collaboratorPage.getByRole('heading', { name: 'Aucun cabinet associé' })).toBeVisible();
  } finally {
    await collaboratorContext.close();
  }
});
