import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';

export const DOCUMENT_FOLDER_SYSTEM_KEYS = [
  'projects',
  'purchases',
  'insurance',
  'tax_social',
  'bank',
  'accounting',
] as const;

export type DocumentFolderSystemKey = (typeof DOCUMENT_FOLDER_SYSTEM_KEYS)[number];
export type DocumentFolderStatus = 'active' | 'deleted';

export const DEFAULT_DOCUMENT_FOLDERS: readonly {
  systemKey: DocumentFolderSystemKey;
  name: string;
}[] = [
  { systemKey: 'projects', name: 'Chantiers' },
  { systemKey: 'purchases', name: 'Achats' },
  { systemKey: 'insurance', name: 'Assurances' },
  { systemKey: 'tax_social', name: 'Fiscal & social' },
  { systemKey: 'bank', name: 'Banque' },
  { systemKey: 'accounting', name: 'Comptable' },
] as const;

export interface DocumentFolderProps {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  normalizedName: string;
  systemKey: DocumentFolderSystemKey | null;
  status: DocumentFolderStatus;
  revision: number;
  createdAt: Instant;
  updatedAt: Instant;
  deletedAt: Instant | null;
}

const MAX_FOLDER_NAME_LENGTH = 80;

export function normalizeDocumentFolderName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fr-FR');
}

function hasForbiddenDocumentFolderNameCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return character === '/' || character === '\\' || code <= 0x1f;
  });
}

export function validateDocumentFolderName(value: unknown): DomainResult<{ name: string; normalizedName: string }> {
  if (typeof value !== 'string') {
    return err({ code: 'VALIDATION', field: 'name', message: 'Nom de dossier requis.' });
  }
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) return err({ code: 'VALIDATION', field: 'name', message: 'Nom de dossier requis.' });
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return err({
      code: 'VALIDATION',
      field: 'name',
      message: `Le nom du dossier ne peut pas dépasser ${MAX_FOLDER_NAME_LENGTH} caractères.`,
    });
  }
  if (hasForbiddenDocumentFolderNameCharacter(name)) {
    return err({ code: 'VALIDATION', field: 'name', message: 'Le nom du dossier contient un caractère interdit.' });
  }
  return ok({ name, normalizedName: normalizeDocumentFolderName(name) });
}

/**
 * Dossier du coffre documentaire.
 *
 * Le rattachement métier d'un document (facture, dépense, chantier…) reste indépendant de
 * son emplacement dans le coffre. Cette séparation permet de reclasser un original sans
 * altérer sa valeur comptable ni sa traçabilité.
 */
export class DocumentFolder {
  private constructor(private readonly p: DocumentFolderProps) {}

  static create(input: {
    id: string;
    companyId: string;
    parentId?: string | null;
    name: string;
    systemKey?: DocumentFolderSystemKey | null;
    now: Instant;
  }): DomainResult<DocumentFolder> {
    if (!input.id.trim()) return err({ code: 'VALIDATION', field: 'id', message: 'Id dossier requis.' });
    if (!input.companyId.trim()) return err({ code: 'VALIDATION', field: 'companyId', message: 'Tenant requis.' });
    if (input.parentId === input.id) {
      return err({ code: 'VALIDATION', field: 'parentId', message: 'Un dossier ne peut pas être son propre parent.' });
    }
    if (input.systemKey !== undefined && input.systemKey !== null && !DOCUMENT_FOLDER_SYSTEM_KEYS.includes(input.systemKey)) {
      return err({ code: 'VALIDATION', field: 'systemKey', message: 'Dossier système inconnu.' });
    }
    const validated = validateDocumentFolderName(input.name);
    if (!validated.ok) return validated;
    return ok(
      new DocumentFolder({
        id: input.id,
        companyId: input.companyId,
        parentId: input.parentId ?? null,
        name: validated.value.name,
        normalizedName: validated.value.normalizedName,
        systemKey: input.systemKey ?? null,
        status: 'active',
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
        deletedAt: null,
      }),
    );
  }

  static rehydrate(props: DocumentFolderProps): DocumentFolder {
    return new DocumentFolder({ ...props });
  }

  get id(): string {
    return this.p.id;
  }

  get companyId(): string {
    return this.p.companyId;
  }

  get parentId(): string | null {
    return this.p.parentId;
  }

  get status(): DocumentFolderStatus {
    return this.p.status;
  }

  get revision(): number {
    return this.p.revision;
  }

  rename(name: string, now: Instant): DomainResult<void> {
    if (this.p.status !== 'active') return err({ code: 'INVALID_TRANSITION', from: this.p.status, to: 'active' });
    const validated = validateDocumentFolderName(name);
    if (!validated.ok) return validated;
    if (validated.value.normalizedName === this.p.normalizedName && validated.value.name === this.p.name) return ok(undefined);
    this.p.name = validated.value.name;
    this.p.normalizedName = validated.value.normalizedName;
    this.touch(now);
    return ok(undefined);
  }

  move(parentId: string | null, now: Instant): DomainResult<void> {
    if (this.p.status !== 'active') return err({ code: 'INVALID_TRANSITION', from: this.p.status, to: 'active' });
    if (parentId === this.p.id) {
      return err({ code: 'VALIDATION', field: 'parentId', message: 'Un dossier ne peut pas être son propre parent.' });
    }
    if (parentId === this.p.parentId) return ok(undefined);
    this.p.parentId = parentId;
    this.touch(now);
    return ok(undefined);
  }

  markDeleted(now: Instant): DomainResult<void> {
    if (this.p.status === 'deleted') return ok(undefined);
    this.p.status = 'deleted';
    this.p.deletedAt = now;
    this.touch(now);
    return ok(undefined);
  }

  toProps(): DocumentFolderProps {
    return { ...this.p };
  }

  private touch(now: Instant): void {
    this.p.updatedAt = now;
    this.p.revision += 1;
  }
}
