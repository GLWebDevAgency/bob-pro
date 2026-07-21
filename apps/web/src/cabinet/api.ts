import type { CabinetAccessSummary, CabinetRole } from './access';
import {
  normalizeSiren,
  validateCabinetDossierValue,
  validateFinancial,
  validateFiscal,
  validatePeriod,
  validateReview,
} from './dossier-validation';
import type {
  CabinetDossier,
  CabinetFinancialSummary,
  CabinetFiscalProfile,
  CabinetReviewSummary,
  StoredFecAnalysis,
} from './types';

const CABINET_API_PREFIX = '/cabinet/v1';

export class CabinetApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'CabinetApiError';
  }
}

export type CabinetMemberStatus = 'active' | 'suspended' | 'revoked';

export interface CabinetMemberSummary {
  readonly id: string;
  readonly userId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly role: CabinetRole;
  readonly status: CabinetMemberStatus;
  readonly joinedAt: string | null;
  readonly updatedAt: string;
}

export interface CabinetMemberPage {
  readonly items: readonly CabinetMemberSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type CabinetInvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface CabinetInvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly role: CabinetRole;
  readonly status: CabinetInvitationStatus;
  readonly expiresAt: string;
}

export interface CabinetInvitationPage {
  readonly items: readonly CabinetInvitationSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface CabinetDossierServerMetadata {
  readonly id: string;
  readonly cabinetId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CabinetDossierListItem = Omit<CabinetDossier, 'analysis'>
  & CabinetDossierServerMetadata;

export type CabinetDossierDetail = CabinetDossier
  & CabinetDossierServerMetadata
  & { readonly analysisSha256: string };

export interface CabinetDossierPage {
  readonly items: readonly CabinetDossierListItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface CabinetDossierWrite {
  readonly siren: string;
  readonly clientName: string;
  readonly sourceFileName: string;
  readonly entryCount: number;
  readonly rowCount: number;
  readonly period: CabinetDossier['period'];
  readonly analysis: StoredFecAnalysis;
  readonly review: CabinetReviewSummary | null;
  readonly fiscal: CabinetFiscalProfile;
  readonly expectedRevision: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function instantField(value: unknown): string | null {
  const candidate = stringField(value);
  return candidate !== null && ISO_INSTANT.test(candidate) && Number.isFinite(Date.parse(candidate))
    ? candidate
    : null;
}

function roleField(value: unknown): CabinetRole | null {
  return value === 'admin' || value === 'manager' || value === 'collaborator' ? value : null;
}

function memberStatusField(value: unknown): CabinetMemberStatus | null {
  return value === 'active' || value === 'suspended' || value === 'revoked' ? value : null;
}

function invitationStatusField(value: unknown): CabinetInvitationStatus | null {
  return value === 'pending' || value === 'accepted' || value === 'expired' || value === 'revoked' ? value : null;
}

function positiveIntegerField(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeDossierMetadata(value: Record<string, unknown>): CabinetDossierServerMetadata | null {
  const id = stringField(value.id);
  const cabinetId = stringField(value.cabinetId);
  const revision = positiveIntegerField(value.revision);
  const createdAt = instantField(value.createdAt);
  const updatedAt = instantField(value.updatedAt);
  return id && cabinetId && revision && createdAt && updatedAt
    ? { id, cabinetId, revision, createdAt, updatedAt }
    : null;
}

function normalizeDossierSummary(value: unknown): CabinetDossierListItem | null {
  if (!isRecord(value)) return null;
  const metadata = normalizeDossierMetadata(value);
  const siren = typeof value.siren === 'string' ? normalizeSiren(value.siren) : null;
  const clientName = stringField(value.clientName);
  const sourceFileName = stringField(value.sourceFileName);
  const entryCount = positiveIntegerField(value.entryCount);
  const rowCount = positiveIntegerField(value.rowCount);
  const lastImportedAt = instantField(value.lastImportedAt);
  if (
    metadata === null
    || siren === null
    || siren !== value.siren
    || clientName === null
    || clientName.length > 200
    || sourceFileName === null
    || sourceFileName.length > 255
    || entryCount === null
    || rowCount === null
    || rowCount < entryCount
    || lastImportedAt === null
    || validatePeriod(value.period, '$.period') !== null
    || validateFinancial(value.financial, '$.financial') !== null
    || validateReview(value.review, '$.review') !== null
    || validateFiscal(value.fiscal, '$.fiscal') !== null
  ) return null;
  return {
    ...metadata,
    siren,
    clientName,
    sourceFileName,
    entryCount,
    rowCount,
    period: value.period as CabinetDossier['period'],
    financial: value.financial as CabinetFinancialSummary,
    review: value.review as CabinetReviewSummary | null,
    fiscal: value.fiscal as CabinetFiscalProfile,
    lastImportedAt,
  };
}

function normalizeDossierDetail(value: unknown): CabinetDossierDetail | null {
  if (!isRecord(value)) return null;
  const summary = normalizeDossierSummary(value);
  const analysisSha256 = typeof value.analysisSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.analysisSha256)
    ? value.analysisSha256
    : null;
  if (summary === null || analysisSha256 === null) return null;
  const validated = validateCabinetDossierValue({
    siren: summary.siren,
    clientName: summary.clientName,
    sourceFileName: summary.sourceFileName,
    entryCount: summary.entryCount,
    rowCount: summary.rowCount,
    period: summary.period,
    financial: summary.financial,
    analysis: value.analysis,
    review: summary.review,
    fiscal: summary.fiscal,
    lastImportedAt: summary.lastImportedAt,
  });
  return validated.ok ? { ...validated.value, ...summary, analysisSha256 } : null;
}

function normalizeCabinet(value: unknown): CabinetAccessSummary | null {
  if (!isRecord(value)) return null;
  const nestedCabinet = isRecord(value.cabinet) ? value.cabinet : null;
  const nestedMembership = isRecord(value.membership) ? value.membership : null;
  const cabinet = nestedCabinet ?? value;
  const id = stringField(cabinet.id) ?? stringField(cabinet.cabinetId);
  const name = stringField(cabinet.name) ?? stringField(cabinet.displayName);
  const role = roleField(value.actorRole)
    ?? roleField(value.role)
    ?? roleField(nestedMembership?.actorRole)
    ?? roleField(nestedMembership?.role)
    ?? roleField(cabinet.actorRole)
    ?? roleField(cabinet.role);
  return id && name && role ? { id, name, role } : null;
}

function unwrapList(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  if (Array.isArray(value.cabinets)) return value.cabinets;
  if (Array.isArray(value.items)) return value.items;
  if ('data' in value) return unwrapList(value.data);
  return null;
}

function unwrapCandidate(value: unknown): unknown {
  return isRecord(value) && isRecord(value.data) ? value.data : value;
}

function normalizeMember(value: unknown): CabinetMemberSummary | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.id);
  const userId = stringField(value.userId);
  const role = roleField(value.role);
  const status = memberStatusField(value.status);
  const email = stringField(value.email);
  const displayName = stringField(value.displayName);
  const updatedAt = instantField(value.updatedAt);
  const joinedAt = value.joinedAt === null ? null : instantField(value.joinedAt);
  if (value.joinedAt !== null && joinedAt === null) return null;
  return id && userId && role && status && updatedAt ? {
    id,
    userId,
    role,
    status,
    joinedAt,
    updatedAt,
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
  } : null;
}

function normalizeInvitation(value: unknown): CabinetInvitationSummary | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.id);
  const email = stringField(value.email);
  const role = roleField(value.role);
  const status = invitationStatusField(value.status);
  const expiresAt = instantField(value.expiresAt);
  return id && email && role && status && expiresAt ? { id, email, role, status, expiresAt } : null;
}

function normalizeList<T>(
  payload: unknown,
  normalize: (value: unknown) => T | null,
  resource: string,
): readonly T[] {
  const items = unwrapList(payload);
  if (items === null) {
    throw new CabinetApiError(`Cabinet API returned an invalid ${resource} list`, 502, 'invalid_response');
  }
  const normalized = items.map(normalize);
  if (normalized.some((item) => item === null)) {
    throw new CabinetApiError(`Cabinet API returned an invalid ${resource} item`, 502, 'invalid_response');
  }
  return normalized.filter((item): item is T => item !== null);
}

function normalizeInvitationPage(payload: unknown): CabinetInvitationPage {
  const candidate = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(candidate)) {
    throw new CabinetApiError('Cabinet API returned invalid invitation pagination', 502, 'invalid_response');
  }
  const nextCursor = candidate.nextCursor === null ? null : stringField(candidate.nextCursor);
  if (nextCursor === null && candidate.nextCursor !== null) {
    throw new CabinetApiError('Cabinet API returned an invalid invitation cursor', 502, 'invalid_response');
  }
  if (typeof candidate.hasMore !== 'boolean' || candidate.hasMore !== (nextCursor !== null)) {
    throw new CabinetApiError('Cabinet API returned inconsistent invitation pagination', 502, 'invalid_response');
  }
  return {
    items: normalizeList(candidate, normalizeInvitation, 'invitation').filter((item) => item.status === 'pending'),
    nextCursor,
    hasMore: candidate.hasMore,
  };
}

function normalizeMemberPage(payload: unknown): CabinetMemberPage {
  const candidate = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(candidate)) {
    throw new CabinetApiError('Cabinet API returned invalid member pagination', 502, 'invalid_response');
  }
  const nextCursor = candidate.nextCursor === null ? null : stringField(candidate.nextCursor);
  if (nextCursor === null && candidate.nextCursor !== null) {
    throw new CabinetApiError('Cabinet API returned an invalid member cursor', 502, 'invalid_response');
  }
  if (typeof candidate.hasMore !== 'boolean' || candidate.hasMore !== (nextCursor !== null)) {
    throw new CabinetApiError('Cabinet API returned inconsistent member pagination', 502, 'invalid_response');
  }
  return {
    items: normalizeList(candidate, normalizeMember, 'member'),
    nextCursor,
    hasMore: candidate.hasMore,
  };
}

function normalizeDossierPage(payload: unknown): CabinetDossierPage {
  const candidate = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(candidate)) {
    throw new CabinetApiError('Cabinet API returned invalid dossier pagination', 502, 'invalid_response');
  }
  const nextCursor = candidate.nextCursor === null ? null : stringField(candidate.nextCursor);
  if (nextCursor === null && candidate.nextCursor !== null) {
    throw new CabinetApiError('Cabinet API returned an invalid dossier cursor', 502, 'invalid_response');
  }
  if (typeof candidate.hasMore !== 'boolean' || candidate.hasMore !== (nextCursor !== null)) {
    throw new CabinetApiError('Cabinet API returned inconsistent dossier pagination', 502, 'invalid_response');
  }
  return {
    items: normalizeList(candidate, normalizeDossierSummary, 'dossier'),
    nextCursor,
    hasMore: candidate.hasMore,
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new CabinetApiError('API URL is missing', 0, 'missing_api_url');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CabinetApiError('API URL is invalid', 0, 'invalid_api_url');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new CabinetApiError('API URL must use HTTPS', 0, 'insecure_api_url');
  }
  return url.toString().replace(/\/$/, '');
}

async function errorFromResponse(response: Response): Promise<CabinetApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : isRecord(payload) ? payload : null;
  return new CabinetApiError(
    stringField(error?.message) ?? `Cabinet API returned ${response.status}`,
    response.status,
    stringField(error?.code) ?? stringField(error?.kind),
  );
}

export class CabinetApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly accessToken: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${CABINET_API_PREFIX}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });
    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === 204) return null;
    return response.json() as Promise<unknown>;
  }

  async listCabinets(): Promise<readonly CabinetAccessSummary[]> {
    const payload = await this.request('/cabinets');
    return normalizeList(payload, normalizeCabinet, 'cabinet');
  }

  async createCabinet(name: string): Promise<CabinetAccessSummary> {
    const payload = await this.request('/cabinets', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() }),
    });
    const candidate = unwrapCandidate(payload);
    const normalized = normalizeCabinet(candidate);
    if (normalized === null) {
      throw new CabinetApiError('Cabinet API returned an invalid cabinet', 502, 'invalid_response');
    }
    return normalized;
  }

  async acceptInvitation(rawToken: string): Promise<void> {
    await this.request('/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken }),
    });
  }

  async listMembers(cabinetId: string, cursor?: string): Promise<CabinetMemberPage> {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const payload = await this.request(`/cabinets/${encodeURIComponent(cabinetId)}/members?${query.toString()}`);
    return normalizeMemberPage(payload);
  }

  async inviteMember(cabinetId: string, input: { readonly email: string; readonly role: CabinetRole }): Promise<CabinetInvitationSummary> {
    const payload = await this.request(`/cabinets/${encodeURIComponent(cabinetId)}/invitations`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const candidate = unwrapCandidate(payload);
    const invitation = isRecord(candidate) && isRecord(candidate.invitation) ? candidate.invitation : isRecord(candidate) ? candidate : null;
    const normalized = normalizeInvitation(invitation);
    if (normalized === null) {
      throw new CabinetApiError('Cabinet API returned an invalid invitation', 502, 'invalid_response');
    }
    return normalized;
  }

  async listInvitations(cabinetId: string, cursor?: string): Promise<CabinetInvitationPage> {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const payload = await this.request(`/cabinets/${encodeURIComponent(cabinetId)}/invitations?${query.toString()}`);
    return normalizeInvitationPage(payload);
  }

  async revokeInvitation(cabinetId: string, invitationId: string): Promise<void> {
    await this.request(`/cabinets/${encodeURIComponent(cabinetId)}/invitations/${encodeURIComponent(invitationId)}`, {
      method: 'DELETE',
    });
  }

  async updateMember(
    cabinetId: string,
    memberId: string,
    input: { readonly role?: CabinetRole; readonly status?: CabinetMemberStatus },
  ): Promise<CabinetMemberSummary> {
    const payload = await this.request(`/cabinets/${encodeURIComponent(cabinetId)}/members/${encodeURIComponent(memberId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    const candidate = unwrapCandidate(payload);
    const member = normalizeMember(isRecord(candidate) && isRecord(candidate.member) ? candidate.member : candidate);
    if (member === null) throw new CabinetApiError('Cabinet API returned an invalid member', 502, 'invalid_response');
    return member;
  }

  async listDossiers(cabinetId: string, cursor?: string): Promise<CabinetDossierPage> {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const payload = await this.request(
      `/cabinets/${encodeURIComponent(cabinetId)}/dossiers?${query.toString()}`,
    );
    const page = normalizeDossierPage(payload);
    if (page.items.some((dossier) => dossier.cabinetId !== cabinetId)) {
      throw new CabinetApiError('Cabinet API returned a cross-tenant dossier', 502, 'invalid_response');
    }
    return page;
  }

  async getDossier(cabinetId: string, siren: string): Promise<CabinetDossierDetail> {
    const payload = await this.request(
      `/cabinets/${encodeURIComponent(cabinetId)}/dossiers/${encodeURIComponent(siren)}`,
    );
    const dossier = normalizeDossierDetail(unwrapCandidate(payload));
    if (dossier === null || dossier.cabinetId !== cabinetId) {
      throw new CabinetApiError('Cabinet API returned an invalid dossier', 502, 'invalid_response');
    }
    return dossier;
  }

  async saveDossier(cabinetId: string, input: CabinetDossierWrite): Promise<CabinetDossierDetail> {
    const { expectedRevision, ...body } = input;
    const payload = await this.request(
      `/cabinets/${encodeURIComponent(cabinetId)}/dossiers/${encodeURIComponent(input.siren)}`,
      {
        method: 'PUT',
        headers: expectedRevision === null
          ? { 'If-None-Match': '*' }
          : { 'If-Match': `"${expectedRevision}"` },
        body: JSON.stringify(body),
      },
    );
    const dossier = normalizeDossierDetail(unwrapCandidate(payload));
    if (dossier === null || dossier.cabinetId !== cabinetId || dossier.siren !== input.siren) {
      throw new CabinetApiError('Cabinet API returned an invalid dossier', 502, 'invalid_response');
    }
    return dossier;
  }

  async deleteDossier(cabinetId: string, siren: string, expectedRevision: number): Promise<void> {
    await this.request(
      `/cabinets/${encodeURIComponent(cabinetId)}/dossiers/${encodeURIComponent(siren)}`,
      { method: 'DELETE', headers: { 'If-Match': `"${expectedRevision}"` } },
    );
  }
}

export function getCabinetApiUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_API_URL;
  return value && value.trim() !== '' ? value : null;
}
