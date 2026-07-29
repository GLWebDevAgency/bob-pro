import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly, type Instant, isValidDateOnly } from '../../shared-kernel/time';
import { assertTransition } from '../billing/shared/state-machines';
import { type LineInput, MAX_BILLING_AMOUNT_CENTS } from '../billing/shared/line-item';
import { type VatRate, isVatRate } from '../billing/shared/vat-rate';
import { type Totals } from '../billing/shared/totals';
import { computeTotals } from '../services/compute-totals';

/**
 * Bloc B « Le métier » (C2, exigence 3) — machine à états AJUSTÉE (§2.4, direction 2) :
 * la reconduction tacite, l'échéance non-tacite et la couverture de facturation sont des
 * FAITS DÉRIVÉS (arithmétique + factures réelles), JAMAIS des transitions. La résiliation
 * est le SEUL événement d'état après l'activation. Aucune méthode `renew()` n'existe.
 * SOURCE du CHECK SQL `maintenance_contracts_status_check` (généré depuis cette union).
 */
export type MaintenanceContractStatus = 'draft' | 'active' | 'terminated';

export const CONTRACT_TRANSITIONS: Record<
  MaintenanceContractStatus,
  readonly MaintenanceContractStatus[]
> = {
  draft: ['active'],
  active: ['terminated'],
  terminated: [],
};

/** Période contractuelle CALCULÉE — borne de fin EXCLUSIVE (§2.3). */
export interface ContractPeriod {
  start: DateOnly;
  /** Exclusive : la période couvre [start, end). L'AFFICHAGE humain montre end − 1 jour. */
  end: DateOnly;
}

/**
 * Ligne de contrat — miroir du patron LineItem (centimes entiers, TVA du référentiel FR).
 * Le montant annuel du contrat = Σ lignes, JAMAIS persisté (§2.1).
 */
export interface MaintenanceContractLine {
  id: string;
  catalogueItemId: string | null;
  label: string;
  quantity: number;
  unitPriceHtCents: number;
  vatRate: VatRate;
  position: number;
}

/**
 * [Direction 5] — refus UNIQUE des contrats B2C en V1 (création ET activation), avec la
 * pédagogie légale au point de décision (LegalHint Chatel) : même substance à l'écran et à
 * la voix, jamais reformulée. Le chemin honnête proposé : devis signé annuel.
 */
export const CONTRACT_B2C_REFUSED_MESSAGE =
  'Les contrats avec un particulier exigent le devoir d’information avant reconduction tacite ' +
  '(art. L215-1 du code de la consommation, loi Chatel) et un cadre de facturation dédié — Bob ' +
  'les ajoutera proprement plutôt que mal. En attendant : un devis signé annuel couvre ce besoin.';

/**
 * BORNE du nom d'un contrat — et de chacune de ses lignes. EXPORTÉE parce qu'elle est la SEULE
 * règle qui s'applique à un nom ÉCRIT À LA MAIN : la fiche « Renommer » borne son champ avec
 * CETTE valeur plutôt qu'avec une copie, faute de quoi l'écran laisserait taper un nom que le
 * domaine refuserait ensuite — un cul-de-sac au lieu d'un remède.
 */
export const MAX_CONTRACT_LABEL_LENGTH = 200;
const MAX_LABEL_LENGTH = MAX_CONTRACT_LABEL_LENGTH;
const MAX_NOTES_LENGTH = 2000;
const MAX_NOTICE_DAYS = 365;
const MAX_VISITS_PER_YEAR = 52;
const MAX_CONTRACT_LINES = 100;
const MAX_LINE_QUANTITY = 1_000_000;

/** Caractères de contrôle interdits dans un champ MONO-LIGNE (miroir SQL `[[:cntrl:]]`). */
function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

/** Ce qui empêche un texte de NOMMER un contrat — `null` quand rien ne s'y oppose. */
export type ContractLabelRefusal = 'vide' | 'trop_long' | 'caractere_de_controle';

/**
 * LA borne d'un nom de contrat, lisible AVANT l'écriture. `record` l'applique (c'est elle qui
 * fait autorité) et les appelants la consultent pour DIRE au pro ce qui coince pendant qu'il
 * tape, au lieu de le lui apprendre par un refus après coup. Une seule règle, deux usages.
 */
export function contractLabelRefusal(raw: string): ContractLabelRefusal | null {
  const label = raw.trim();
  if (label.length === 0) return 'vide';
  if (label.length > MAX_CONTRACT_LABEL_LENGTH) return 'trop_long';
  if (hasControlCharacter(label)) return 'caractere_de_controle';
  return null;
}

/** Ce que le DOMAINE répond quand un nom ne passe pas — même phrase à l'écran et à la voix. */
export function contractLabelRefusalMessage(refusal: ContractLabelRefusal): string {
  if (refusal === 'vide') return 'Nom du contrat requis.';
  if (refusal === 'trop_long') return `Nom limité à ${MAX_CONTRACT_LABEL_LENGTH} caractères.`;
  return 'Caractères de contrôle interdits.';
}

/** Notes multilignes de terrain : \n/\t admis, tout autre caractère de contrôle refusé. */
function hasForbiddenNotesCharacter(value: string): boolean {
  return /(?![\n\t])\p{Cc}/u.test(value);
}

function canonicalNotes(field: string, value: string | null): DomainResult<string | null> {
  if (value === null) return ok(null);
  const trimmed = value.trim();
  if (trimmed.length === 0) return ok(null);
  if (trimmed.length > MAX_NOTES_LENGTH)
    return err({ code: 'VALIDATION', field, message: `Champ limité à ${MAX_NOTES_LENGTH} caractères.` });
  if (hasForbiddenNotesCharacter(trimmed))
    return err({ code: 'VALIDATION', field, message: 'Caractères de contrôle interdits.' });
  return ok(trimmed);
}

export interface MaintenanceContractProps {
  id: string;
  companyId: string;
  /** Client PROFESSIONNEL (b2b/b2g) — la garde vit dans les use cases (création + activation). */
  customerId: string;
  /** Site couvert (Chantier) — optionnel ; les équipements liés exigent un site (§2.6). */
  chantierId: string | null;
  label: string;
  status: MaintenanceContractStatus;
  /**
   * [Direction 2] Date de DÉBUT INITIALE du contrat — IMMUABLE après activation. La période
   * courante est un CALCUL PUR (encadrement clampé, annexe erratum n° 5), jamais une mutation.
   * Peut être dans le PASSÉ (contrats migrés Fly Services, revue P13).
   */
  anniversaryDate: DateOnly;
  noticeDays: number;
  visitsPerYear: number;
  tacitRenewal: boolean;
  /**
   * [Revue P13] « déjà facturé hors Bob jusqu'à » — borne EXCLUSIVE en colonne (la saisie
   * humaine INCLUSIVE est convertie +1 jour par le wizard, annexe erratum n° 4). Déclaré à la
   * création, éditable en `draft` uniquement, FIGÉ à l'activation.
   */
  importCoveredUntil: DateOnly | null;
  activatedAt: Instant | null;
  /** Date de la DÉCISION de résiliation (fait stocké). */
  terminatedAt: Instant | null;
  /** Fin de couverture — défaut : prochain anniversaire CALCULÉ (posé par le use case). */
  terminationEffectiveDate: DateOnly | null;
  terminationNote: string | null;
  notes: string | null;
  revision: number;
  lines: MaintenanceContractLine[];
  /** Table de liaison contrat↔équipements (§2.2) — équipements du MÊME site (garde use case). */
  equipmentIds: string[];
}

/** Champs modifiables d'un contrat — `null` efface, absent = inchangé. */
export interface MaintenanceContractPatch {
  label?: string;
  chantierId?: string | null;
  anniversaryDate?: DateOnly;
  noticeDays?: number;
  visitsPerYear?: number;
  tacitRenewal?: boolean;
  importCoveredUntil?: DateOnly | null;
  notes?: string | null;
}

export interface ContractLineInput {
  catalogueItemId?: string | null;
  label: string;
  quantity: number;
  unitPriceHtCents: number;
  vatRate: VatRate;
}

function validateLine(
  line: MaintenanceContractLine,
  index: number,
): DomainResult<MaintenanceContractLine> {
  const label = line.label.trim();
  if (!label || label.length > MAX_LABEL_LENGTH || hasControlCharacter(label))
    return err({
      code: 'VALIDATION',
      field: `lines[${index}].label`,
      message: 'Libellé de ligne requis (200 caractères maximum, sans caractère de contrôle).',
    });
  if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > MAX_LINE_QUANTITY)
    return err({
      code: 'VALIDATION',
      field: `lines[${index}].quantity`,
      message: 'Quantité strictement positive requise.',
    });
  if (
    !Number.isSafeInteger(line.unitPriceHtCents)
    || line.unitPriceHtCents < 0
    || line.unitPriceHtCents > MAX_BILLING_AMOUNT_CENTS
  )
    return err({
      code: 'VALIDATION',
      field: `lines[${index}].unitPriceHtCents`,
      message: 'Prix unitaire HT en centimes entiers positifs requis.',
    });
  if (!isVatRate(line.vatRate))
    return err({
      code: 'VALIDATION',
      field: `lines[${index}].vatRate`,
      message: 'Taux de TVA hors référentiel français.',
    });
  const catalogueItemId =
    line.catalogueItemId === null ? null : line.catalogueItemId.trim() || null;
  return ok({ ...line, label, catalogueItemId });
}

/**
 * Montant annuel = Σ lignes via le MOTEUR UNIQUE computeTotals (assiette de TVA par taux,
 * arrondis identiques aux pièces) — JAMAIS stocké (§2.1).
 */
export function contractAnnualTotals(lines: readonly MaintenanceContractLine[]): Totals {
  return computeTotals(contractLinesToLineInputs(lines));
}

/**
 * Projection ARITHMÉTIQUE des lignes du contrat vers le patron LineInput : elle sert au CALCUL
 * du montant annuel, JAMAIS à une pièce. Le libellé qu'elle recopie est le nom saisi/dicté —
 * ce qui s'imprime sur une facture est COMPOSÉ par le domaine (`annual-invoice-designation.ts`,
 * `annualInvoiceLineInputs`), et ComposeStandaloneInvoice refuse structurellement toute ligne
 * de contrat qui n'aurait pas cette forme.
 */
export function contractLinesToLineInputs(
  lines: readonly MaintenanceContractLine[],
): LineInput[] {
  return lines.map((line) => ({
    label: line.label,
    category: 'subscription' as const,
    qty: line.quantity,
    unitPriceHT: line.unitPriceHtCents,
    vatRate: line.vatRate,
  }));
}

/**
 * Agrégat MaintenanceContract — cœur du revenu des mainteneurs (§2.1). Zéro framework,
 * zéro I/O : les gardes cross-agrégat (client b2b/b2g, site ouvert, équipements du même
 * site) vivent dans les use cases ; l'intégrité interne vit ici.
 */
export class MaintenanceContract {
  private constructor(private readonly p: MaintenanceContractProps) {}

  static record(props: MaintenanceContractProps): DomainResult<MaintenanceContract> {
    const label = props.label.trim();
    const labelRefusal = contractLabelRefusal(label);
    if (labelRefusal !== null)
      return err({
        code: 'VALIDATION',
        field: 'label',
        message: contractLabelRefusalMessage(labelRefusal),
      });
    const customerId = props.customerId.trim();
    if (!customerId)
      return err({ code: 'VALIDATION', field: 'customerId', message: 'Client requis.' });
    let chantierId: string | null = null;
    if (props.chantierId !== null) {
      chantierId = props.chantierId.trim();
      if (!chantierId)
        return err({ code: 'VALIDATION', field: 'chantierId', message: 'Site invalide.' });
    }
    if (!isValidDateOnly(props.anniversaryDate))
      return err({
        code: 'VALIDATION',
        field: 'anniversaryDate',
        message: 'Date de début du contrat invalide (AAAA-MM-JJ requis).',
      });
    if (!Number.isSafeInteger(props.noticeDays) || props.noticeDays < 0 || props.noticeDays > MAX_NOTICE_DAYS)
      return err({
        code: 'VALIDATION',
        field: 'noticeDays',
        message: `Préavis entre 0 et ${MAX_NOTICE_DAYS} jours requis.`,
      });
    if (
      !Number.isSafeInteger(props.visitsPerYear)
      || props.visitsPerYear < 0
      || props.visitsPerYear > MAX_VISITS_PER_YEAR
    )
      return err({
        code: 'VALIDATION',
        field: 'visitsPerYear',
        message: `Nombre de passages par an entre 0 et ${MAX_VISITS_PER_YEAR} requis.`,
      });
    if (props.importCoveredUntil !== null && !isValidDateOnly(props.importCoveredUntil))
      return err({
        code: 'VALIDATION',
        field: 'importCoveredUntil',
        message: 'Date « déjà facturé hors Bob » invalide (AAAA-MM-JJ requis).',
      });
    const notes = canonicalNotes('notes', props.notes);
    if (!notes.ok) return notes;
    const terminationNote = canonicalNotes('terminationNote', props.terminationNote);
    if (!terminationNote.ok) return terminationNote;

    // Cohérence TRIPLE de la résiliation (miroir des CHECK SQL §2.2) : jamais un demi-état —
    // CHAQUE fait (décision, date d'effet) existe si et seulement si le statut est résilié.
    const terminated = props.status === 'terminated';
    if (
      terminated !== (props.terminatedAt !== null)
      || terminated !== (props.terminationEffectiveDate !== null)
    )
      return err({
        code: 'VALIDATION',
        field: 'terminatedAt',
        message: 'Statut et faits de résiliation incohérents.',
      });
    if (terminationNote.value !== null && !terminated)
      return err({
        code: 'VALIDATION',
        field: 'terminationNote',
        message: 'Un motif de résiliation exige un contrat résilié.',
      });
    if (
      props.terminationEffectiveDate !== null
      && !isValidDateOnly(props.terminationEffectiveDate)
    )
      return err({
        code: 'VALIDATION',
        field: 'terminationEffectiveDate',
        message: 'Date d’effet de résiliation invalide (AAAA-MM-JJ requis).',
      });
    // Un actif/résilié porte TOUJOURS son fait d'activation (CHECK SQL §2.2).
    if (props.status !== 'draft' && props.activatedAt === null)
      return err({
        code: 'VALIDATION',
        field: 'activatedAt',
        message: 'Un contrat actif ou résilié porte toujours son fait d’activation.',
      });

    if (!Array.isArray(props.lines) || props.lines.length > MAX_CONTRACT_LINES)
      return err({
        code: 'VALIDATION',
        field: 'lines',
        message: `Au plus ${MAX_CONTRACT_LINES} lignes par contrat.`,
      });
    const lines: MaintenanceContractLine[] = [];
    for (const [index, line] of props.lines.entries()) {
      const validated = validateLine(line, index);
      if (!validated.ok) return validated;
      lines.push({ ...validated.value, position: index });
    }
    // Un actif exige ≥ 1 ligne (le montant annuel = Σ lignes doit exister, §2.3).
    if (props.status !== 'draft' && lines.length === 0)
      return err({
        code: 'VALIDATION',
        field: 'lines',
        message: 'Un contrat actif exige au moins une ligne.',
      });

    const equipmentIds = [...new Set(props.equipmentIds.map((id) => id.trim()).filter(Boolean))];
    if (equipmentIds.length !== props.equipmentIds.length)
      return err({
        code: 'VALIDATION',
        field: 'equipmentIds',
        message: 'Liste d’équipements invalide (vides ou doublons).',
      });
    // Les équipements couverts vivent sur le SITE du contrat : sans site, aucune liaison (§2.6).
    if (equipmentIds.length > 0 && chantierId === null)
      return err({
        code: 'VALIDATION',
        field: 'equipmentIds',
        message: 'Lie d’abord un site au contrat pour couvrir ses équipements.',
      });

    return ok(
      new MaintenanceContract({
        ...props,
        customerId,
        chantierId,
        label,
        notes: notes.value,
        terminationNote: terminationNote.value,
        lines,
        equipmentIds,
      }),
    );
  }

  /** Réhydratation depuis le stockage (données déjà validées par record + CHECK SQL). */
  static rehydrate(props: MaintenanceContractProps): MaintenanceContract {
    return new MaintenanceContract({
      ...props,
      lines: props.lines.map((line) => ({ ...line })),
      equipmentIds: [...props.equipmentIds],
    });
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get customerId(): string {
    return this.p.customerId;
  }
  get chantierId(): string | null {
    return this.p.chantierId;
  }
  get label(): string {
    return this.p.label;
  }
  get status(): MaintenanceContractStatus {
    return this.p.status;
  }
  get anniversaryDate(): DateOnly {
    return this.p.anniversaryDate;
  }
  get tacitRenewal(): boolean {
    return this.p.tacitRenewal;
  }
  get importCoveredUntil(): DateOnly | null {
    return this.p.importCoveredUntil;
  }
  get terminationEffectiveDate(): DateOnly | null {
    return this.p.terminationEffectiveDate;
  }
  get revision(): number {
    return this.p.revision;
  }
  get lines(): readonly MaintenanceContractLine[] {
    return this.p.lines;
  }
  get equipmentIds(): readonly string[] {
    return this.p.equipmentIds;
  }

  /** Montant annuel VIVANT = Σ lignes (jamais persisté). */
  annualTotals(): Totals {
    return contractAnnualTotals(this.p.lines);
  }

  /**
   * Mutation des conditions — `draft` et `active` (CAS), figé en `terminated`.
   * `anniversaryDate` et `importCoveredUntil` sont IMMUABLES après activation (§2.1/§2.6) :
   * la période calculée et la couverture migrée ne se réécrivent jamais sous un contrat vivant.
   */
  update(patch: MaintenanceContractPatch): DomainResult<void> {
    if (this.p.status === 'terminated')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message: 'Contrat résilié : lecture seule.',
      });
    const keys = Object.keys(patch);
    const allowed = new Set([
      'label', 'chantierId', 'anniversaryDate', 'noticeDays', 'visitsPerYear', 'tacitRenewal',
      'importCoveredUntil', 'notes',
    ]);
    if (keys.length === 0 || keys.some((key) => !allowed.has(key)))
      return err({ code: 'VALIDATION', field: 'patch', message: 'Modification de contrat invalide.' });
    if (this.p.status === 'active') {
      if (patch.anniversaryDate !== undefined && patch.anniversaryDate !== this.p.anniversaryDate)
        return err({
          code: 'VALIDATION',
          field: 'anniversaryDate',
          message: 'La date de début est figée à l’activation : la période calculée ne se réécrit pas.',
        });
      if (
        patch.importCoveredUntil !== undefined
        && patch.importCoveredUntil !== this.p.importCoveredUntil
      )
        return err({
          code: 'VALIDATION',
          field: 'importCoveredUntil',
          message: '« Déjà facturé hors Bob » est figé à l’activation (fait déclaré du jour 1).',
        });
      if (patch.chantierId !== undefined && patch.chantierId !== this.p.chantierId)
        return err({
          code: 'VALIDATION',
          field: 'chantierId',
          message: 'Le site couvert est figé à l’activation.',
        });
    }
    const candidate: MaintenanceContractProps = {
      ...this.p,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.chantierId !== undefined ? { chantierId: patch.chantierId } : {}),
      ...(patch.anniversaryDate !== undefined ? { anniversaryDate: patch.anniversaryDate } : {}),
      ...(patch.noticeDays !== undefined ? { noticeDays: patch.noticeDays } : {}),
      ...(patch.visitsPerYear !== undefined ? { visitsPerYear: patch.visitsPerYear } : {}),
      ...(patch.tacitRenewal !== undefined ? { tacitRenewal: patch.tacitRenewal } : {}),
      ...(patch.importCoveredUntil !== undefined
        ? { importCoveredUntil: patch.importCoveredUntil }
        : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      lines: this.p.lines.map((line) => ({ ...line })),
      equipmentIds: [...this.p.equipmentIds],
    };
    const validated = MaintenanceContract.record(candidate);
    if (!validated.ok) return validated;
    const next = validated.value.toProps();
    // Invariant NO-OP : la normalisation du domaine fait autorité. Un patch qui ne change
    // finalement aucun fait (par exemple le même nom entouré d'espaces) ne doit ni faire
    // tourner la révision, ni forcer les appelants à persister une fausse modification.
    const changed =
      (patch.label !== undefined && next.label !== this.p.label)
      || (patch.chantierId !== undefined && next.chantierId !== this.p.chantierId)
      || (patch.anniversaryDate !== undefined && next.anniversaryDate !== this.p.anniversaryDate)
      || (patch.noticeDays !== undefined && next.noticeDays !== this.p.noticeDays)
      || (patch.visitsPerYear !== undefined && next.visitsPerYear !== this.p.visitsPerYear)
      || (patch.tacitRenewal !== undefined && next.tacitRenewal !== this.p.tacitRenewal)
      || (
        patch.importCoveredUntil !== undefined
        && next.importCoveredUntil !== this.p.importCoveredUntil
      )
      || (patch.notes !== undefined && next.notes !== this.p.notes);
    if (!changed) return ok(undefined);
    Object.assign(this.p, next, { revision: this.p.revision + 1 });
    return ok(undefined);
  }

  /** Remplace les LIGNES — `draft` et `active` (le prix d'un contrat vivant se renégocie). */
  replaceLines(lines: readonly ContractLineInput[], newLineId: () => string): DomainResult<void> {
    if (this.p.status === 'terminated')
      return err({ code: 'VALIDATION', field: 'status', message: 'Contrat résilié : lecture seule.' });
    const candidate: MaintenanceContractProps = {
      ...this.p,
      lines: lines.map((line, position) => ({
        id: newLineId(),
        catalogueItemId: line.catalogueItemId ?? null,
        label: line.label,
        quantity: line.quantity,
        unitPriceHtCents: line.unitPriceHtCents,
        vatRate: line.vatRate,
        position,
      })),
      equipmentIds: [...this.p.equipmentIds],
    };
    const validated = MaintenanceContract.record(candidate);
    if (!validated.ok) return validated;
    Object.assign(this.p, validated.value.toProps(), { revision: this.p.revision + 1 });
    return ok(undefined);
  }

  /** Remplace la LIAISON équipements — `draft` et `active` (le parc couvert évolue). */
  replaceEquipments(equipmentIds: readonly string[]): DomainResult<void> {
    if (this.p.status === 'terminated')
      return err({ code: 'VALIDATION', field: 'status', message: 'Contrat résilié : lecture seule.' });
    const candidate: MaintenanceContractProps = {
      ...this.p,
      lines: this.p.lines.map((line) => ({ ...line })),
      equipmentIds: [...equipmentIds],
    };
    const validated = MaintenanceContract.record(candidate);
    if (!validated.ok) return validated;
    Object.assign(this.p, validated.value.toProps(), { revision: this.p.revision + 1 });
    return ok(undefined);
  }

  /**
   * Activation (§2.3) : ≥ 1 ligne + client b2b/b2g REVALIDÉ par l'appelant qui fournit le
   * type RELU — refus actionnable + LegalHint Chatel sinon. FIGE `anniversaryDate` et
   * `importCoveredUntil` (via update()) et pose le fait `activatedAt`.
   */
  activate(at: Instant, customerType: 'b2c' | 'b2b' | 'b2g'): DomainResult<void> {
    const t = assertTransition(CONTRACT_TRANSITIONS, this.p.status, 'active');
    if (!t.ok) return t;
    if (customerType === 'b2c')
      return err({ code: 'VALIDATION', field: 'customerId', message: CONTRACT_B2C_REFUSED_MESSAGE });
    if (this.p.lines.length === 0)
      return err({
        code: 'VALIDATION',
        field: 'lines',
        message: 'Ajoute au moins une ligne avant d’activer : le montant annuel = Σ lignes.',
      });
    this.p.status = 'active';
    this.p.activatedAt = at;
    this.p.revision += 1;
    return ok(undefined);
  }

  /**
   * Résiliation (§2.3) — SEUL événement d'état après l'activation. TOUJOURS possible depuis
   * `active` (la résiliation subie se TRACE, jamais interdite — le préavis est AFFICHÉ par
   * l'UI/voix, jamais bloquant). Motif requis (trace honnête d'une décision).
   */
  terminate(input: {
    decidedAt: Instant;
    effectiveDate: DateOnly;
    note: string;
  }): DomainResult<void> {
    const t = assertTransition(CONTRACT_TRANSITIONS, this.p.status, 'terminated');
    if (!t.ok) return t;
    if (!isValidDateOnly(input.effectiveDate))
      return err({
        code: 'VALIDATION',
        field: 'terminationEffectiveDate',
        message: 'Date d’effet de résiliation invalide (AAAA-MM-JJ requis).',
      });
    const note = input.note.trim();
    if (!note)
      return err({
        code: 'VALIDATION',
        field: 'terminationNote',
        message: 'Motif de résiliation requis (trace de la décision).',
      });
    if (note.length > MAX_NOTES_LENGTH || hasForbiddenNotesCharacter(note))
      return err({
        code: 'VALIDATION',
        field: 'terminationNote',
        message: `Motif limité à ${MAX_NOTES_LENGTH} caractères, sans caractère de contrôle.`,
      });
    this.p.status = 'terminated';
    this.p.terminatedAt = input.decidedAt;
    this.p.terminationEffectiveDate = input.effectiveDate;
    this.p.terminationNote = note;
    this.p.revision += 1;
    return ok(undefined);
  }

  toProps(): MaintenanceContractProps {
    return {
      ...this.p,
      lines: this.p.lines.map((line) => ({ ...line })),
      equipmentIds: [...this.p.equipmentIds],
    };
  }
}
