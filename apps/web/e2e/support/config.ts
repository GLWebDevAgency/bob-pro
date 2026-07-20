export interface CabinetStagingE2EConfig {
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly supabaseUrl: string;
  readonly expectedReleaseSha: string;
  readonly adminEmail: string;
  readonly collaboratorEmail: string;
  readonly primaryCabinetId: string;
  readonly foreignCabinetId: string;
  readonly mailosaurServerId: string;
  readonly mailosaurApiKey: string;
  readonly vercelBypassSecret: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Cabinet staging E2E configuration is missing ${name}.`);
  return value;
}

function httpsOrigin(environment: NodeJS.ProcessEnv, name: string): string {
  const raw = required(environment, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Cabinet staging E2E configuration has an invalid ${name}.`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error(`Cabinet staging E2E configuration requires ${name} to be an HTTPS origin.`);
  }
  return parsed.origin;
}

function email(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name).toLowerCase();
  if (value.length > 254 || !EMAIL.test(value)) {
    throw new Error(`Cabinet staging E2E configuration has an invalid ${name}.`);
  }
  return value;
}

function uuid(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!UUID.test(value)) throw new Error(`Cabinet staging E2E configuration has an invalid ${name}.`);
  return value;
}

export function loadCabinetStagingE2EConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CabinetStagingE2EConfig {
  const webBaseUrl = httpsOrigin(environment, 'CABINET_WEB_BASE_URL');
  const apiBaseUrl = httpsOrigin(environment, 'API_BASE_URL');
  const supabaseUrl = httpsOrigin(environment, 'CABINET_E2E_SUPABASE_URL');
  const adminEmail = email(environment, 'CABINET_E2E_ADMIN_EMAIL');
  const collaboratorEmail = email(environment, 'CABINET_E2E_COLLABORATOR_EMAIL');
  const primaryCabinetId = uuid(environment, 'CABINET_E2E_PRIMARY_CABINET_ID');
  const foreignCabinetId = uuid(environment, 'CABINET_E2E_FOREIGN_CABINET_ID');
  const mailosaurServerId = required(environment, 'CABINET_E2E_MAILOSAUR_SERVER_ID');
  const expectedReleaseSha = required(environment, 'EXPECTED_RELEASE_SHA');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(mailosaurServerId)) {
    throw new Error('Cabinet staging E2E configuration has an invalid CABINET_E2E_MAILOSAUR_SERVER_ID.');
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedReleaseSha)) {
    throw new Error('Cabinet staging E2E configuration has an invalid EXPECTED_RELEASE_SHA.');
  }
  if (adminEmail === collaboratorEmail) {
    throw new Error('Cabinet staging E2E identities must be distinct.');
  }
  if (primaryCabinetId === foreignCabinetId) {
    throw new Error('Cabinet staging E2E tenants must be distinct.');
  }
  return {
    webBaseUrl,
    apiBaseUrl,
    supabaseUrl,
    expectedReleaseSha,
    adminEmail,
    collaboratorEmail,
    primaryCabinetId,
    foreignCabinetId,
    mailosaurServerId,
    mailosaurApiKey: required(environment, 'CABINET_E2E_MAILOSAUR_API_KEY'),
    vercelBypassSecret: environment.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null,
  };
}
