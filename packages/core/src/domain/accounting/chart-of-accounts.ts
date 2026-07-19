import { type DomainResult, ok, err } from '../../shared-kernel/result';

export type AccountingAccountKind = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type AccountingNormalSide = 'debit' | 'credit' | 'mixed';
export type AccountingAccountClass = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';

export interface AccountingAccountProps {
  code: string;
  label: string;
  kind: AccountingAccountKind;
  normalSide: AccountingNormalSide;
  /** Compte parent de regroupement. Null pour les classes racines. */
  parentCode: string | null;
  /** Un compte inactif reste historisable mais ne doit plus recevoir de nouvelles ecritures. */
  active: boolean;
  /** False pour les classes/comptes de regroupement ; true pour les comptes postables. */
  postingAllowed: boolean;
}

export interface AccountingAccountInput {
  code: string;
  label: string;
  kind: AccountingAccountKind;
  normalSide?: AccountingNormalSide;
  parentCode?: string | null;
  active?: boolean;
  postingAllowed?: boolean;
}

export interface ChartOfAccountsProps {
  companyId: string;
  accounts: AccountingAccountProps[];
}

export interface ChartOfAccountsCreateProps {
  companyId: string;
  accounts: AccountingAccountInput[];
}

const ACCOUNT_CODE_RE = /^\d{1,12}$/;
const POSTING_ACCOUNT_CODE_RE = /^\d{3,12}$/;
const ACCOUNT_KINDS: readonly AccountingAccountKind[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const NORMAL_SIDES: readonly AccountingNormalSide[] = ['debit', 'credit', 'mixed'];

export function isAccountingAccountCode(code: string): boolean {
  return ACCOUNT_CODE_RE.test(code);
}

export function isPostingAccountCode(code: string): boolean {
  return POSTING_ACCOUNT_CODE_RE.test(code);
}

export function accountingAccountClass(code: string): AccountingAccountClass | null {
  const first = code.trim()[0];
  return first && /^[1-8]$/.test(first) ? (first as AccountingAccountClass) : null;
}

function defaultNormalSide(kind: AccountingAccountKind): AccountingNormalSide {
  if (kind === 'asset' || kind === 'expense') return 'debit';
  if (kind === 'liability' || kind === 'equity' || kind === 'revenue') return 'credit';
  return 'mixed';
}

function required(value: string, field: string): DomainResult<string> {
  const normalized = value.trim();
  if (!normalized) return err({ code: 'VALIDATION', field, message: 'Champ requis.' });
  return ok(normalized);
}

function normalizeAccount(account: AccountingAccountInput, index: number): DomainResult<AccountingAccountProps> {
  const field = `accounts[${index}]`;
  const code = account.code.trim();
  const label = account.label.trim();
  const parentCode = account.parentCode?.trim() || null;
  if (!isAccountingAccountCode(code))
    return err({ code: 'VALIDATION', field: `${field}.code`, message: 'Code de compte invalide.' });
  if (!accountingAccountClass(code))
    return err({ code: 'VALIDATION', field: `${field}.code`, message: 'Classe de compte inconnue.' });
  if (!label) return err({ code: 'VALIDATION', field: `${field}.label`, message: 'Libelle de compte requis.' });
  if (!ACCOUNT_KINDS.includes(account.kind))
    return err({ code: 'VALIDATION', field: `${field}.kind`, message: 'Categorie de compte inconnue.' });
  if (account.normalSide !== undefined && !NORMAL_SIDES.includes(account.normalSide))
    return err({ code: 'VALIDATION', field: `${field}.normalSide`, message: 'Sens normal inconnu.' });
  if (parentCode !== null) {
    if (!isAccountingAccountCode(parentCode))
      return err({ code: 'VALIDATION', field: `${field}.parentCode`, message: 'Compte parent invalide.' });
    if (parentCode === code)
      return err({ code: 'VALIDATION', field: `${field}.parentCode`, message: 'Un compte ne peut pas etre son propre parent.' });
    if (!code.startsWith(parentCode))
      return err({ code: 'VALIDATION', field: `${field}.parentCode`, message: 'Le parent doit prefixer le compte enfant.' });
  }
  if (account.active !== undefined && typeof account.active !== 'boolean')
    return err({ code: 'VALIDATION', field: `${field}.active`, message: 'Statut de compte invalide.' });
  if (account.postingAllowed !== undefined && typeof account.postingAllowed !== 'boolean')
    return err({ code: 'VALIDATION', field: `${field}.postingAllowed`, message: 'Statut de saisie invalide.' });

  return ok({
    code,
    label,
    kind: account.kind,
    normalSide: account.normalSide ?? defaultNormalSide(account.kind),
    parentCode,
    active: account.active ?? true,
    postingAllowed: account.postingAllowed ?? isPostingAccountCode(code),
  });
}

/**
 * Plan comptable d'une societe.
 *
 * Le modele est volontairement riche des le depart : hierarchie, comptes de regroupement,
 * comptes postables, sens normal, activation/desactivation. Les templates fournis amorcent un
 * plan operationnel francais, mais le mapping metier (vente, achat, banque, immobilisation, TVA)
 * reste dans des services explicites et testables.
 */
export class ChartOfAccounts {
  private constructor(private readonly p: ChartOfAccountsProps) {}

  static create(props: ChartOfAccountsCreateProps): DomainResult<ChartOfAccounts> {
    const companyId = required(props.companyId, 'companyId');
    if (!companyId.ok) return companyId;
    if (props.accounts.length === 0)
      return err({ code: 'VALIDATION', field: 'accounts', message: 'Au moins un compte est requis.' });

    const seen = new Set<string>();
    const accounts: AccountingAccountProps[] = [];
    for (const [index, account] of props.accounts.entries()) {
      const normalized = normalizeAccount(account, index);
      if (!normalized.ok) return normalized;
      if (seen.has(normalized.value.code))
        return err({ code: 'VALIDATION', field: `accounts[${index}].code`, message: 'Compte en double.' });
      seen.add(normalized.value.code);
      accounts.push(normalized.value);
    }

    const byCode = new Map(accounts.map((account) => [account.code, account]));
    for (const [index, account] of accounts.entries()) {
      if (account.parentCode && !byCode.has(account.parentCode))
        return err({ code: 'VALIDATION', field: `accounts[${index}].parentCode`, message: 'Compte parent absent.' });
      if (account.parentCode && byCode.get(account.parentCode)?.active === false && account.active)
        return err({ code: 'VALIDATION', field: `accounts[${index}].parentCode`, message: 'Parent inactif.' });
      if (account.postingAllowed && account.code.length < 2)
        return err({ code: 'VALIDATION', field: `accounts[${index}].postingAllowed`, message: 'Compte trop general pour la saisie.' });
    }

    return ok(new ChartOfAccounts({ companyId: companyId.value, accounts }));
  }

  static rehydrate(props: ChartOfAccountsProps): ChartOfAccounts {
    return new ChartOfAccounts({ companyId: props.companyId, accounts: props.accounts.map((account) => ({ ...account })) });
  }

  get companyId(): string {
    return this.p.companyId;
  }

  get accounts(): AccountingAccountProps[] {
    return this.p.accounts.map((account) => ({ ...account }));
  }

  get postingAccounts(): AccountingAccountProps[] {
    return this.p.accounts.filter((account) => account.active && account.postingAllowed).map((account) => ({ ...account }));
  }

  find(code: string): AccountingAccountProps | null {
    const normalized = code.trim();
    const account = this.p.accounts.find((a) => a.code === normalized);
    return account ? { ...account } : null;
  }

  childrenOf(parentCode: string): AccountingAccountProps[] {
    const normalized = parentCode.trim();
    return this.p.accounts.filter((account) => account.parentCode === normalized).map((account) => ({ ...account }));
  }

  acceptsPosting(code: string): boolean {
    const account = this.find(code);
    return account?.active === true && account.postingAllowed;
  }

  toProps(): ChartOfAccountsProps {
    return { companyId: this.p.companyId, accounts: this.accounts };
  }
}

const root = (code: AccountingAccountClass, label: string): AccountingAccountInput => ({
  code,
  label,
  kind: code === '6' ? 'expense' : code === '7' ? 'revenue' : code === '1' ? 'equity' : 'asset',
  normalSide: code === '6' ? 'debit' : code === '7' || code === '1' ? 'credit' : 'mixed',
  postingAllowed: false,
});

/**
 * Gabarit operationnel FR pour artisans/independants/TPE.
 * Source structurante : ANC, plan de comptes PCG 2026. On seed les comptes utiles au produit Bob ;
 * l'import exhaustif ANC pourra remplacer ce gabarit sans changer le domaine.
 */
export const FRENCH_OPERATIONAL_PCG_ACCOUNTS: readonly AccountingAccountInput[] = [
  root('1', 'Comptes de capitaux'),
  { code: '10', label: 'Capital et reserves', kind: 'equity', parentCode: '1', postingAllowed: false },
  { code: '101', label: 'Capital', kind: 'equity', parentCode: '10' },
  { code: '106', label: 'Reserves', kind: 'equity', parentCode: '10' },
  { code: '108', label: "Compte de l'exploitant", kind: 'equity', parentCode: '10' },
  { code: '12', label: "Resultat de l'exercice", kind: 'equity', parentCode: '1', postingAllowed: false },
  { code: '120', label: "Resultat de l'exercice - benefice", kind: 'equity', parentCode: '12' },
  { code: '129', label: "Resultat de l'exercice - perte", kind: 'equity', normalSide: 'debit', parentCode: '12' },
  { code: '16', label: 'Emprunts et dettes assimilees', kind: 'liability', parentCode: '1', postingAllowed: false },
  { code: '164', label: 'Emprunts aupres des etablissements de credit', kind: 'liability', parentCode: '16' },

  root('2', 'Comptes immobilises'),
  { code: '20', label: 'Immobilisations incorporelles', kind: 'asset', parentCode: '2', postingAllowed: false },
  { code: '205', label: 'Concessions, brevets, licences, logiciels', kind: 'asset', parentCode: '20' },
  { code: '21', label: 'Immobilisations corporelles', kind: 'asset', parentCode: '2', postingAllowed: false },
  { code: '215', label: 'Installations techniques, materiel et outillage industriels', kind: 'asset', parentCode: '21' },
  { code: '2182', label: 'Materiel de transport', kind: 'asset', parentCode: '21' },
  { code: '2183', label: 'Materiel de bureau et informatique', kind: 'asset', parentCode: '21' },
  { code: '2184', label: 'Mobilier', kind: 'asset', parentCode: '21' },
  { code: '28', label: 'Amortissements des immobilisations', kind: 'asset', normalSide: 'credit', parentCode: '2', postingAllowed: false },
  { code: '2805', label: 'Amortissements logiciels', kind: 'asset', normalSide: 'credit', parentCode: '28' },
  { code: '2815', label: 'Amortissements materiel et outillage', kind: 'asset', normalSide: 'credit', parentCode: '28' },
  { code: '28182', label: 'Amortissements materiel de transport', kind: 'asset', normalSide: 'credit', parentCode: '28' },
  { code: '28183', label: 'Amortissements materiel informatique', kind: 'asset', normalSide: 'credit', parentCode: '28' },
  { code: '28184', label: 'Amortissements mobilier', kind: 'asset', normalSide: 'credit', parentCode: '28' },

  root('3', 'Comptes de stocks et en-cours'),
  { code: '31', label: 'Matieres premieres et fournitures', kind: 'asset', parentCode: '3', postingAllowed: true },
  { code: '37', label: 'Stocks de marchandises', kind: 'asset', parentCode: '3', postingAllowed: true },

  root('4', 'Comptes de tiers'),
  { code: '40', label: 'Fournisseurs et comptes rattaches', kind: 'liability', parentCode: '4', postingAllowed: false },
  { code: '401', label: 'Fournisseurs', kind: 'liability', parentCode: '40' },
  { code: '4081', label: 'Fournisseurs - factures non parvenues', kind: 'liability', parentCode: '40' },
  { code: '4091', label: 'Fournisseurs - avances et acomptes verses', kind: 'asset', parentCode: '40' },
  { code: '41', label: 'Clients et comptes rattaches', kind: 'asset', parentCode: '4', postingAllowed: false },
  { code: '411', label: 'Clients', kind: 'asset', parentCode: '41' },
  // B5 — retenue de garantie (loi 71-584) : creance client differee jusqu'a reception + 1 an.
  { code: '4117', label: 'Clients - retenues de garantie', kind: 'asset', parentCode: '41' },
  { code: '4181', label: 'Clients - factures a etablir', kind: 'asset', parentCode: '41' },
  { code: '4191', label: 'Clients - avances et acomptes recus', kind: 'liability', parentCode: '41' },
  { code: '42', label: 'Personnel et comptes rattaches', kind: 'liability', parentCode: '4', postingAllowed: false },
  { code: '421', label: 'Personnel - remunerations dues', kind: 'liability', parentCode: '42' },
  { code: '43', label: 'Securite sociale et autres organismes sociaux', kind: 'liability', parentCode: '4', postingAllowed: false },
  { code: '431', label: 'Securite sociale', kind: 'liability', parentCode: '43' },
  { code: '437', label: 'Autres organismes sociaux', kind: 'liability', parentCode: '43' },
  { code: '44', label: 'Etat et autres collectivites publiques', kind: 'liability', normalSide: 'mixed', parentCode: '4', postingAllowed: false },
  { code: '44551', label: 'TVA a decaisser', kind: 'liability', parentCode: '44' },
  { code: '44562', label: 'TVA deductible sur immobilisations', kind: 'asset', parentCode: '44' },
  { code: '44566', label: 'TVA deductible sur autres biens et services', kind: 'asset', parentCode: '44' },
  { code: '44567', label: 'Credit de TVA a reporter', kind: 'asset', parentCode: '44' },
  { code: '44571', label: 'TVA collectee', kind: 'liability', parentCode: '44' },
  { code: '4458', label: 'Taxes sur le chiffre d affaires a regulariser ou en attente', kind: 'liability', normalSide: 'mixed', parentCode: '44' },
  { code: '447', label: 'Autres impots, taxes et versements assimiles', kind: 'liability', parentCode: '44' },
  { code: '46', label: 'Debiteurs divers et crediteurs divers', kind: 'asset', normalSide: 'mixed', parentCode: '4', postingAllowed: false },
  { code: '467', label: 'Autres comptes debiteurs ou crediteurs', kind: 'asset', normalSide: 'mixed', parentCode: '46' },

  root('5', 'Comptes financiers'),
  { code: '51', label: 'Banques et etablissements financiers', kind: 'asset', parentCode: '5', postingAllowed: false },
  { code: '512', label: 'Banques', kind: 'asset', parentCode: '51' },
  { code: '514', label: 'Cheques postaux', kind: 'asset', parentCode: '51' },
  { code: '53', label: 'Caisse', kind: 'asset', parentCode: '5', postingAllowed: false },
  { code: '530', label: 'Caisse', kind: 'asset', parentCode: '53' },
  { code: '58', label: 'Virements internes', kind: 'asset', normalSide: 'mixed', parentCode: '5', postingAllowed: false },
  { code: '580', label: 'Virements internes', kind: 'asset', normalSide: 'mixed', parentCode: '58' },

  root('6', 'Comptes de charges'),
  { code: '60', label: 'Achats', kind: 'expense', parentCode: '6', postingAllowed: false },
  { code: '601', label: 'Achats de matieres premieres', kind: 'expense', parentCode: '60' },
  { code: '602', label: 'Achats stockes - autres approvisionnements', kind: 'expense', parentCode: '60' },
  { code: '604', label: "Achats d'etudes et prestations de services", kind: 'expense', parentCode: '60' },
  { code: '606', label: 'Achats non stockes de matieres et fournitures', kind: 'expense', parentCode: '60' },
  { code: '607', label: 'Achats de marchandises', kind: 'expense', parentCode: '60' },
  { code: '61', label: 'Services exterieurs', kind: 'expense', parentCode: '6', postingAllowed: false },
  { code: '611', label: 'Sous-traitance generale', kind: 'expense', parentCode: '61' },
  { code: '613', label: 'Locations', kind: 'expense', parentCode: '61' },
  { code: '615', label: 'Entretien et reparations', kind: 'expense', parentCode: '61' },
  { code: '616', label: "Primes d'assurance", kind: 'expense', parentCode: '61' },
  { code: '62', label: 'Autres services exterieurs', kind: 'expense', parentCode: '6', postingAllowed: false },
  { code: '622', label: 'Remunerations d intermediaires et honoraires', kind: 'expense', parentCode: '62' },
  { code: '623', label: 'Publicite, publications, relations publiques', kind: 'expense', parentCode: '62' },
  { code: '624', label: 'Transports de biens et transports collectifs du personnel', kind: 'expense', parentCode: '62' },
  { code: '625', label: 'Deplacements, missions et receptions', kind: 'expense', parentCode: '62' },
  { code: '626', label: 'Frais postaux et de telecommunications', kind: 'expense', parentCode: '62' },
  { code: '627', label: 'Services bancaires et assimiles', kind: 'expense', parentCode: '62' },
  { code: '63', label: 'Impots, taxes et versements assimiles', kind: 'expense', parentCode: '6', postingAllowed: false },
  { code: '641', label: 'Remunerations du personnel', kind: 'expense', parentCode: '6' },
  { code: '645', label: 'Charges de securite sociale et de prevoyance', kind: 'expense', parentCode: '6' },
  { code: '661', label: "Charges d'interets", kind: 'expense', parentCode: '6' },
  { code: '6811', label: 'Dotations aux amortissements sur immobilisations', kind: 'expense', parentCode: '6' },

  root('7', 'Comptes de produits'),
  { code: '70', label: 'Ventes de produits fabriques, prestations de services, marchandises', kind: 'revenue', parentCode: '7', postingAllowed: false },
  { code: '701', label: 'Ventes de produits finis', kind: 'revenue', parentCode: '70' },
  { code: '706', label: 'Prestations de services', kind: 'revenue', parentCode: '70' },
  { code: '707', label: 'Ventes de marchandises', kind: 'revenue', parentCode: '70' },
  { code: '708', label: 'Produits des activites annexes', kind: 'revenue', parentCode: '70' },
  { code: '75', label: 'Autres produits de gestion courante', kind: 'revenue', parentCode: '7', postingAllowed: false },
  { code: '758', label: 'Produits divers de gestion courante', kind: 'revenue', parentCode: '75' },
] as const;

export function createFrenchOperationalChartOfAccounts(companyId: string): DomainResult<ChartOfAccounts> {
  return ChartOfAccounts.create({ companyId, accounts: [...FRENCH_OPERATIONAL_PCG_ACCOUNTS] });
}
