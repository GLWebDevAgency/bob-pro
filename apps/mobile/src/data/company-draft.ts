import type { Session } from '@supabase/supabase-js';
import type {
  CompanyLookupResult,
  CompanyRegistrationInput,
  LegalForm,
  Trade,
  VatRegime,
} from '@bob/core';

/**
 * Fiche entreprise en attente de provisioning (C24b).
 * Écrite par signUp (user_metadata.company_snapshot, voir data/auth.tsx) ; relue par le
 * ProvisioningScreen après le premier login pour créer le tenant côté serveur.
 */

/** Libellés d'affichage des formes juridiques — vocabulaire légal, invariant par personnalité. */
export const LEGAL_FORM_LABELS: Record<LegalForm, string> = {
  EI: 'Entreprise individuelle (EI)',
  micro: 'Micro-entreprise',
  EURL: 'EURL',
  SARL: 'SARL',
  SAS: 'SAS',
  SASU: 'SASU',
};

/** Ordre de présentation du choix de forme juridique (picker du provisioning). */
export const LEGAL_FORM_OPTIONS: readonly LegalForm[] = ['EI', 'micro', 'EURL', 'SARL', 'SAS', 'SASU'];

function isLegalForm(v: unknown): v is LegalForm {
  return typeof v === 'string' && v in LEGAL_FORM_LABELS;
}

const TRADES: ReadonlySet<string> = new Set<Trade>([
  'plombier', 'electricien', 'macon', 'peintre', 'paysagiste', 'consultant', 'freelance_it', 'photographe', 'coach', 'autre',
]);

function isTrade(v: unknown): v is Trade {
  return typeof v === 'string' && TRADES.has(v);
}

/** Validation structurelle MINIMALE du snapshot relu depuis user_metadata (JSON non typé). */
export function readCompanySnapshot(session: Session | null): CompanyLookupResult | null {
  const meta = (session?.user?.user_metadata ?? {}) as Record<string, unknown>;
  const raw = meta['company_snapshot'];
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s['siren'] !== 'string' || typeof s['siret'] !== 'string' || typeof s['denomination'] !== 'string') {
    return null;
  }
  const address = s['address'];
  const addr =
    address && typeof address === 'object' &&
    typeof (address as Record<string, unknown>)['line1'] === 'string' &&
    typeof (address as Record<string, unknown>)['zip'] === 'string' &&
    typeof (address as Record<string, unknown>)['city'] === 'string'
      ? (address as { line1: string; zip: string; city: string })
      : null;
  return {
    siren: s['siren'],
    siret: s['siret'],
    denomination: s['denomination'],
    nafApe: typeof s['nafApe'] === 'string' ? s['nafApe'] : null,
    trade: isTrade(s['trade']) ? s['trade'] : null,
    natureJuridiqueCode: typeof s['natureJuridiqueCode'] === 'string' ? s['natureJuridiqueCode'] : null,
    legalForm: isLegalForm(s['legalForm']) ? s['legalForm'] : null,
    dateCreation: typeof s['dateCreation'] === 'string' ? s['dateCreation'] : null,
    address: addr,
    tvaIntracom: typeof s['tvaIntracom'] === 'string' ? s['tvaIntracom'] : null,
    rge: s['rge'] === true,
  };
}

/** SIRET du brouillon léger (comptes créés avant le snapshot complet — clé company_siret). */
export function readDraftSiret(session: Session | null): string | null {
  const meta = (session?.user?.user_metadata ?? {}) as Record<string, unknown>;
  const siret = meta['company_siret'];
  return typeof siret === 'string' && /^\d{14}$/.test(siret.replace(/\s/g, '')) ? siret.replace(/\s/g, '') : null;
}

/**
 * Fiche annuaire → input registerCompany (fiche société COMPLÈTE en base, C24b).
 * - legalForm : celle du lookup, sinon le choix explicite de l'utilisateur (JAMAIS devinée) ;
 * - vatRegime : choix explicite de l'utilisateur (l'annuaire ne le connaît pas) ;
 * - trade : celui du lookup (NAF), sinon « autre » — affiné par l'onboarding métier (C22) ;
 * - adresse : celle du siège si connue, sinon vide (complétée avant émission — assertCanIssue).
 */
export function registerInputFromLookup(
  lookup: CompanyLookupResult,
  legalForm: LegalForm,
  vatRegime: VatRegime,
): CompanyRegistrationInput {
  return {
    name: lookup.denomination,
    legalForm,
    siren: lookup.siren,
    siret: lookup.siret,
    ...(lookup.nafApe ? { apeCode: lookup.nafApe } : {}),
    trade: lookup.trade ?? 'autre',
    vatRegime,
    address: lookup.address ?? { line1: '', zip: '', city: '' },
    ...(lookup.tvaIntracom ? { tvaIntracom: lookup.tvaIntracom } : {}),
    ...(lookup.dateCreation ? { dateCreation: lookup.dateCreation } : {}),
    // Phase B fiscal : le code catégorie juridique INSEE et la qualification RGE remontés par
    // l'annuaire sont persistés au provisioning (avant : jetés par registerCompany).
    ...(lookup.natureJuridiqueCode ? { natureJuridiqueCode: lookup.natureJuridiqueCode } : {}),
    estRge: lookup.rge,
  };
}

/** « 2016-03-01 » → « 01/03/2016 » (affichage FR) — null si la date est illisible. */
export function formatDateFr(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}
