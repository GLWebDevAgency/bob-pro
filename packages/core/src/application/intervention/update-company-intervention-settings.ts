import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain } from '../result';
import {
  DEFAULT_INTERVENTION_REPORT_TITLE,
  type CompanyInterventionSettings,
  type CompanyInterventionSettingsRepository,
} from './intervention-repository';

/**
 * [Revue adversariale 28/07 — finding 5] PR-16 §3.2/§4.5 — CHEMIN D'ÉCRITURE des réglages de
 * fiche : le « titre PARAMÉTRABLE par société » et les templates de checklist étaient LUS par
 * `GenerateInterventionReport`/`SendInterventionReport`/`CreateIntervention` (table, RLS et
 * repo Prisma existants) sans qu'AUCUN use case, endpoint, méthode client ni outil vocal ne
 * permette de les écrire : la promesse produit n'était pas atteignable par l'utilisateur.
 *
 * Un libellé, JAMAIS un modèle de document (« Certificat sanitaire ») ; [Amélioration 10]
 * UNIQUE par société — le titre par `kind` est un non-but V1 documenté.
 */

/** Miroir EXACT du CHECK SQL `company_intervention_settings_title_check` (1..120, trim, cntrl). */
export const MAX_INTERVENTION_REPORT_TITLE_LENGTH = 120;
/** Un tenant ne définit pas cent métiers : borne honnête, refus actionnable au-delà. */
export const MAX_INTERVENTION_CHECKLIST_TEMPLATES = 20;
export const MAX_INTERVENTION_CHECKLIST_TEMPLATE_ITEMS = 50;
const MAX_KIND_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;

function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

export interface UpdateCompanyInterventionSettingsInput {
  companyId: string;
  /**
   * Titre du PDF. Absent = inchangé ; `null` ou chaîne blanche = RETOUR au défaut produit
   * (« Fiche de passage ») — jamais un titre vide imprimé sur une pièce de preuve.
   */
  reportTitle?: string | null;
  /**
   * Templates de checklist par `kind` (clé libre, comparée après trim/minuscules).
   * Absent = inchangé ; objet fourni = REMPLACEMENT COMPLET (l'écran envoie l'état voulu).
   */
  checklistTemplates?: Record<string, readonly string[]>;
  /**
   * CAS optimiste — révision observée. Absente : première écriture uniquement (aucun réglage
   * encore posé) ; sur des réglages existants, l'absence est refusée comme un conflit (jamais
   * un écrasement silencieux du réglage d'un autre appareil).
   */
  expectedRevision?: number;
}

export interface UpdateCompanyInterventionSettingsDeps {
  interventionSettings: CompanyInterventionSettingsRepository;
}

function validationError(field: string, message: string): AppError {
  return appDomain({ code: 'VALIDATION', field, message });
}

/** Réglages EFFECTIFS d'une société (défaut produit compris) — lecture d'écran et de voix. */
export function effectiveInterventionSettings(
  companyId: string,
  stored: CompanyInterventionSettings | null,
): CompanyInterventionSettings & { effectiveReportTitle: string } {
  const settings = stored ?? {
    companyId,
    reportTitle: null,
    checklistTemplates: {},
    revision: 0,
  };
  return {
    ...settings,
    checklistTemplates: { ...settings.checklistTemplates },
    effectiveReportTitle: settings.reportTitle?.trim() || DEFAULT_INTERVENTION_REPORT_TITLE,
  };
}

function canonicalTemplates(
  raw: Record<string, readonly string[]>,
): Result<Record<string, string[]>, AppError> {
  const entries = Object.entries(raw);
  if (entries.length > MAX_INTERVENTION_CHECKLIST_TEMPLATES)
    return err(
      validationError(
        'checklistTemplates',
        `Pas plus de ${MAX_INTERVENTION_CHECKLIST_TEMPLATES} modèles de checklist — regroupe tes types de passage.`,
      ),
    );
  const canonical: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const [rawKind, rawLabels] of entries) {
    const kind = rawKind.trim();
    if (kind.length === 0 || kind.length > MAX_KIND_LENGTH || hasControlCharacter(kind))
      return err(
        validationError(
          'checklistTemplates',
          `Type de passage invalide (${MAX_KIND_LENGTH} caractères maximum, sans caractère de contrôle).`,
        ),
      );
    // Le `kind` est comparé après trim/minuscules à la lecture : deux clés qui ne diffèrent
    // que par la casse produiraient un template gagnant arbitraire — refus explicite.
    const key = kind.toLowerCase();
    if (seen.has(key))
      return err(
        validationError(
          'checklistTemplates',
          `Deux modèles portent le même type de passage (« ${kind} ») — garde-en un seul.`,
        ),
      );
    seen.add(key);
    if (!Array.isArray(rawLabels))
      return err(validationError('checklistTemplates', 'Modèle de checklist invalide.'));
    if (rawLabels.length === 0 || rawLabels.length > MAX_INTERVENTION_CHECKLIST_TEMPLATE_ITEMS)
      return err(
        validationError(
          'checklistTemplates',
          `Un modèle contient de 1 à ${MAX_INTERVENTION_CHECKLIST_TEMPLATE_ITEMS} points à contrôler.`,
        ),
      );
    const labels: string[] = [];
    for (const rawLabel of rawLabels) {
      if (typeof rawLabel !== 'string')
        return err(validationError('checklistTemplates', 'Point à contrôler invalide.'));
      const label = rawLabel.trim();
      if (label.length === 0 || label.length > MAX_LABEL_LENGTH || hasControlCharacter(label))
        return err(
          validationError(
            'checklistTemplates',
            `Point à contrôler invalide (${MAX_LABEL_LENGTH} caractères maximum, sans caractère de contrôle).`,
          ),
        );
      labels.push(label);
    }
    canonical[kind] = labels;
  }
  return ok(canonical);
}

export class UpdateCompanyInterventionSettings {
  constructor(private readonly deps: UpdateCompanyInterventionSettingsDeps) {}

  async execute(
    input: UpdateCompanyInterventionSettingsInput,
  ): Promise<Result<CompanyInterventionSettings, AppError>> {
    if (input.reportTitle === undefined && input.checklistTemplates === undefined)
      return err(validationError('settings', 'Rien à modifier dans les réglages de fiche.'));

    const current = await this.deps.interventionSettings.find(input.companyId);

    // CAS explicite : deux appareils (ou voix + écran) ne s'écrasent jamais en silence.
    if (current !== null) {
      if (input.expectedRevision === undefined || input.expectedRevision !== current.revision)
        return err(appConflict('company_intervention_settings', 'stale_revision'));
    } else if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
      return err(appConflict('company_intervention_settings', 'stale_revision'));
    }

    let reportTitle = current?.reportTitle ?? null;
    if (input.reportTitle !== undefined) {
      const trimmed = input.reportTitle === null ? '' : input.reportTitle.trim();
      if (trimmed.length === 0) {
        // Retour au défaut produit — le PDF garde toujours une identité imprimée.
        reportTitle = null;
      } else {
        if (trimmed.length > MAX_INTERVENTION_REPORT_TITLE_LENGTH)
          return err(
            validationError(
              'reportTitle',
              `Titre limité à ${MAX_INTERVENTION_REPORT_TITLE_LENGTH} caractères.`,
            ),
          );
        if (hasControlCharacter(trimmed))
          return err(validationError('reportTitle', 'Caractères de contrôle interdits.'));
        reportTitle = trimmed;
      }
    }

    let checklistTemplates = current?.checklistTemplates ?? {};
    if (input.checklistTemplates !== undefined) {
      const canonical = canonicalTemplates(input.checklistTemplates);
      if (!canonical.ok) return canonical;
      checklistTemplates = canonical.value;
    }

    const next: CompanyInterventionSettings = {
      companyId: input.companyId,
      reportTitle,
      checklistTemplates,
      revision: (current?.revision ?? 0) + 1,
    };
    await this.deps.interventionSettings.save(next);
    return ok(next);
  }
}
