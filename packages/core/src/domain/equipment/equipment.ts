import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly, type Instant, isValidDateOnly } from '../../shared-kernel/time';
import { assertTransition } from '../billing/shared/state-machines';

/**
 * Bloc A « Le métier » (C1, exigence 2) — cycle d'état du parc : un parc TOURNE, il ne
 * « workflow » pas. Retrait logique réversible, jamais de suppression.
 * SOURCE du CHECK SQL `equipments_status_check` (généré depuis cette union, leçon 25/07).
 */
export type EquipmentStatus = 'active' | 'retired';

export const EQUIPMENT_TRANSITIONS: Record<EquipmentStatus, readonly EquipmentStatus[]> = {
  active: ['retired'],
  retired: ['active'],
};

/** Identifiant d'équipement — alias sémantique (généré par IdGeneratorPort, jamais saisi). */
export type EquipmentId = string;

const MAX_LABEL_LENGTH = 200;
const MAX_FREE_FIELD_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;

/** Tous les caractères de contrôle Unicode sont interdits dans un champ MONO-LIGNE du parc (miroir SQL `[[:cntrl:]]`). */
function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

/** [Revue train n°2] `notes` est un texte LIBRE de terrain (§1.2/§1.3 : seule borne = 2000) :
 * les retours à la ligne et tabulations y sont légitimes — seuls les AUTRES caractères de
 * contrôle restent interdits (miroir SQL `translate(notes, \n\t, '') !~ '[[:cntrl:]]'`). */
function hasForbiddenNotesCharacter(value: string): boolean {
  return /(?![\n\t])\p{Cc}/u.test(value);
}

export interface EquipmentProps {
  id: EquipmentId;
  companyId: string;
  /** Site de rattachement — TOUJOURS un chantier du même tenant (FK composite en persistance). */
  chantierId: string;
  /** « Fontaine accueil R+2 » — le héros de la rangée. */
  label: string;
  /** Type LIBRE (« Fontaine réseau », « Clim gainable ») — JAMAIS une taxonomie codée en dur. */
  kind: string | null;
  brand: string | null;
  serialNumber: string | null;
  /** Emplacement dans le site (« R+2, accueil ») — libre. */
  location: string | null;
  installedAt: DateOnly | null;
  warrantyUntil: DateOnly | null;
  status: EquipmentStatus;
  /** [Revue P11] fait de RETRAIT réel : posé par la transition retired, PURGÉ à la
   * réactivation — « Retirée le … » affiche toujours ce fait, jamais une date fabriquée. */
  retiredAt: Instant | null;
  notes: string | null;
  /** Révision optimiste (CAS) — patron du repo, incrémentée par chaque mutation. */
  revision: number;
}

function canonicalOptional(
  field: string,
  value: string | null,
  maxLength: number,
  hasForbiddenCharacter: (candidate: string) => boolean = hasControlCharacter,
): DomainResult<string | null> {
  if (value === null) return ok(null);
  const trimmed = value.trim();
  if (trimmed.length === 0) return ok(null);
  if (trimmed.length > maxLength)
    return err({ code: 'VALIDATION', field, message: `Champ limité à ${maxLength} caractères.` });
  if (hasForbiddenCharacter(trimmed))
    return err({ code: 'VALIDATION', field, message: 'Caractères de contrôle interdits.' });
  return ok(trimmed);
}

function validateDates(
  installedAt: DateOnly | null,
  warrantyUntil: DateOnly | null,
): DomainResult<void> {
  if (installedAt !== null && !isValidDateOnly(installedAt))
    return err({ code: 'VALIDATION', field: 'installedAt', message: 'Date de pose invalide.' });
  if (warrantyUntil !== null && !isValidDateOnly(warrantyUntil))
    return err({ code: 'VALIDATION', field: 'warrantyUntil', message: 'Date de garantie invalide.' });
  // Comparaison lexicographique sûre sur YYYY-MM-DD : la garantie ne précède jamais la pose.
  if (installedAt !== null && warrantyUntil !== null && warrantyUntil < installedAt)
    return err({
      code: 'VALIDATION',
      field: 'warrantyUntil',
      message: 'La fin de garantie ne peut pas précéder la date de pose.',
    });
  return ok(undefined);
}

/** Champs modifiables d'un équipement — `null` efface, absent = inchangé. */
export interface EquipmentPatch {
  label?: string;
  kind?: string | null;
  brand?: string | null;
  serialNumber?: string | null;
  location?: string | null;
  installedAt?: DateOnly | null;
  warrantyUntil?: DateOnly | null;
  notes?: string | null;
}

/**
 * Agrégat Equipment — parc d'équipements d'un site (« Chantier » est le site générique).
 * Table minimale, `kind` libre, certificats/garanties portés par StoredDocument lié.
 * Zéro framework, zéro I/O : les gardes cross-agrégat (site du tenant, site ouvert) vivent
 * dans les use cases.
 */
export class Equipment {
  private constructor(private readonly p: EquipmentProps) {}

  static record(props: EquipmentProps): DomainResult<Equipment> {
    const label = props.label.trim();
    if (!label) return err({ code: 'VALIDATION', field: 'label', message: 'Nom d’équipement requis.' });
    if (label.length > MAX_LABEL_LENGTH)
      return err({ code: 'VALIDATION', field: 'label', message: `Nom limité à ${MAX_LABEL_LENGTH} caractères.` });
    if (hasControlCharacter(label))
      return err({ code: 'VALIDATION', field: 'label', message: 'Caractères de contrôle interdits.' });
    const chantierId = props.chantierId.trim();
    if (!chantierId)
      return err({ code: 'VALIDATION', field: 'chantierId', message: 'Site de rattachement requis.' });

    const kind = canonicalOptional('kind', props.kind, MAX_FREE_FIELD_LENGTH);
    if (!kind.ok) return kind;
    const brand = canonicalOptional('brand', props.brand, MAX_FREE_FIELD_LENGTH);
    if (!brand.ok) return brand;
    const serialNumber = canonicalOptional('serialNumber', props.serialNumber, MAX_FREE_FIELD_LENGTH);
    if (!serialNumber.ok) return serialNumber;
    const location = canonicalOptional('location', props.location, MAX_FREE_FIELD_LENGTH);
    if (!location.ok) return location;
    // Notes de terrain MULTILIGNES : \n et \t admis, tout autre caractère de contrôle refusé.
    const notes = canonicalOptional('notes', props.notes, MAX_NOTES_LENGTH, hasForbiddenNotesCharacter);
    if (!notes.ok) return notes;

    const dates = validateDates(props.installedAt, props.warrantyUntil);
    if (!dates.ok) return dates;

    // Cohérence TRIPLE statut/retrait (miroir du CHECK SQL) : jamais un demi-état.
    if ((props.status === 'retired') !== (props.retiredAt !== null))
      return err({
        code: 'VALIDATION',
        field: 'retiredAt',
        message: 'Statut et fait de retrait incohérents.',
      });

    return ok(
      new Equipment({
        ...props,
        chantierId,
        label,
        kind: kind.value,
        brand: brand.value,
        serialNumber: serialNumber.value,
        location: location.value,
        notes: notes.value,
      }),
    );
  }

  /** Réhydratation depuis le stockage (données déjà validées par record + CHECK SQL). */
  static rehydrate(props: EquipmentProps): Equipment {
    return new Equipment({ ...props });
  }

  get id(): EquipmentId {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get chantierId(): string {
    return this.p.chantierId;
  }
  get label(): string {
    return this.p.label;
  }
  get kind(): string | null {
    return this.p.kind;
  }
  get status(): EquipmentStatus {
    return this.p.status;
  }
  get retiredAt(): Instant | null {
    return this.p.retiredAt;
  }
  get revision(): number {
    return this.p.revision;
  }

  /**
   * Mutation des champs descriptifs — équipement ACTIF uniquement (cycle §1.4 : une fiche
   * retirée se réactive d'abord). Chaque champ fourni est revalidé ; `null` efface.
   */
  update(patch: EquipmentPatch): DomainResult<void> {
    if (this.p.status !== 'active')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message: 'Équipement retiré : réactive-le avant de le modifier.',
      });
    const allowed = new Set([
      'label', 'kind', 'brand', 'serialNumber', 'location', 'installedAt', 'warrantyUntil', 'notes',
    ]);
    const keys = Object.keys(patch);
    if (keys.length === 0 || keys.some((key) => !allowed.has(key)))
      return err({ code: 'VALIDATION', field: 'patch', message: 'Modification d’équipement invalide.' });

    const candidate: EquipmentProps = {
      ...this.p,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.brand !== undefined ? { brand: patch.brand } : {}),
      ...(patch.serialNumber !== undefined ? { serialNumber: patch.serialNumber } : {}),
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.installedAt !== undefined ? { installedAt: patch.installedAt } : {}),
      ...(patch.warrantyUntil !== undefined ? { warrantyUntil: patch.warrantyUntil } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    };
    const validated = Equipment.record(candidate);
    if (!validated.ok) return validated;
    Object.assign(this.p, validated.value.toProps(), { revision: this.p.revision + 1 });
    return ok(undefined);
  }

  /** Retrait LOGIQUE (dépose, hors service) — pose le fait `retiredAt`, jamais un DELETE. */
  retire(at: Instant): DomainResult<void> {
    const t = assertTransition(EQUIPMENT_TRANSITIONS, this.p.status, 'retired');
    if (!t.ok) return t;
    this.p.status = 'retired';
    this.p.retiredAt = at;
    this.p.revision += 1;
    return ok(undefined);
  }

  /** Réactivation (erreur honnête corrigée, machine remise en service) — PURGE `retiredAt`. */
  reactivate(): DomainResult<void> {
    const t = assertTransition(EQUIPMENT_TRANSITIONS, this.p.status, 'active');
    if (!t.ok) return t;
    this.p.status = 'active';
    this.p.retiredAt = null;
    this.p.revision += 1;
    return ok(undefined);
  }

  toProps(): EquipmentProps {
    return { ...this.p };
  }
}
