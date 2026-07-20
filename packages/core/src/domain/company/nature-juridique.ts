import { type LegalForm } from './company';

/**
 * Mappe un code catégorie juridique INSEE (nature_juridique de l'annuaire) vers une forme
 * juridique Bob Pro connue. Mapping PRUDENT : seuls les codes dont la correspondance est sans
 * ambiguïté sont couverts — code inconnu ou hors périmètre (SCI 6540, SNC 5202, associations…)
 * → null, l'utilisateur choisit manuellement.
 *
 * NB : « micro » est un RÉGIME (micro-entreprise), pas une catégorie juridique INSEE — il ne
 * peut jamais être déduit d'un code (un micro-entrepreneur est un 1000 côté INSEE).
 * NB : la SASU est une SAS à associé unique — même code INSEE 5710 : on mappe vers 'SAS',
 * l'utilisateur affine si besoin.
 */
const NATURE_JURIDIQUE_TO_LEGAL_FORM: Record<string, LegalForm> = {
  '1000': 'EI', // Entrepreneur individuel (dont micro-entrepreneurs)
  '5498': 'EURL', // SARL unipersonnelle
  '5499': 'SARL',
  '5710': 'SAS', // SAS — couvre aussi la SASU (associé unique, même code)
};

export function natureJuridiqueToLegalForm(code: string | null | undefined): LegalForm | null {
  if (!code) return null;
  return NATURE_JURIDIQUE_TO_LEGAL_FORM[code.replace(/\s/g, '')] ?? null;
}
