import { type Result, ok, err } from '../../shared-kernel/result';
import { type DateOnly, isValidDateOnly } from '../../shared-kernel/time';
import { type AccountingEntry, type AccountingJournal } from '../../domain/accounting/accounting-entry';
import { type ChartOfAccounts } from '../../domain/accounting/chart-of-accounts';
import { type AppError, appNotFound } from '../result';
import { type AccountingEntryRepository } from '../ports/accounting-entry-repository';
import { type ChartOfAccountsRepository } from '../ports/chart-of-accounts-repository';
import { type CompanyRepository } from '../ports/repositories';

export const FEC_HEADERS = [
  'JournalCode',
  'JournalLib',
  'EcritureNum',
  'EcritureDate',
  'CompteNum',
  'CompteLib',
  'CompAuxNum',
  'CompAuxLib',
  'PieceRef',
  'PieceDate',
  'EcritureLib',
  'Debit',
  'Credit',
  'EcritureLet',
  'DateLet',
  'ValidDate',
  'Montantdevise',
  'Idevise',
] as const;

export interface ExportFecInput {
  companyId: string;
  from: DateOnly;
  to: DateOnly;
}

export interface ExportFecOutput {
  filename: string;
  mimeType: string;
  content: string;
  descriptionFilename: string;
  descriptionContent: string;
  entryCount: number;
  rowCount: number;
  warnings: string[];
}

export interface ExportFecDeps {
  companies: CompanyRepository;
  entries: AccountingEntryRepository;
  charts?: ChartOfAccountsRepository;
}

const JOURNALS: Record<AccountingJournal, { code: string; label: string }> = {
  sales: { code: 'VE', label: 'Journal des ventes' },
  purchases: { code: 'AC', label: 'Journal des achats' },
  bank: { code: 'BQ', label: 'Journal de banque' },
  misc: { code: 'OD', label: 'Operations diverses' },
};

function compactDate(date: DateOnly): string {
  return date.replace(/-/g, '');
}

function centsToFecAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const decimals = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${decimals}`;
}

function sanitizeField(value: string | null | undefined): string {
  return (value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function issue(field: string, message: string) {
  return { field, message };
}

function accountLabel(chart: ChartOfAccounts | null, account: string, warnings: Set<string>): string {
  if (!chart) {
    warnings.add('Plan comptable absent : CompteLib est renseigne avec un libelle technique.');
    return `Compte ${account}`;
  }
  const found = chart.find(account);
  if (!found) {
    warnings.add(`Compte ${account} absent du plan comptable : CompteLib est renseigne avec un libelle technique.`);
    return `Compte ${account}`;
  }
  return found.label;
}

function sortedEntries(entries: AccountingEntry[], from: DateOnly, to: DateOnly): AccountingEntry[] {
  return entries
    .filter((entry) => entry.entryDate >= from && entry.entryDate <= to)
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.journal.localeCompare(b.journal) || a.id.localeCompare(b.id));
}

function toFecRows(entries: AccountingEntry[], chart: ChartOfAccounts | null, warnings: Set<string>): string[][] {
  const rows: string[][] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const journal = JOURNALS[entry.journal];
    const ecritureNum = String(entryIndex + 1).padStart(6, '0');
    for (const line of entry.lines) {
      rows.push([
        journal.code,
        journal.label,
        ecritureNum,
        compactDate(entry.entryDate),
        line.account,
        accountLabel(chart, line.account, warnings),
        '',
        '',
        entry.reference,
        compactDate(entry.entryDate),
        line.label || entry.label,
        centsToFecAmount(line.debitCents),
        centsToFecAmount(line.creditCents),
        '',
        '',
        compactDate(entry.entryDate),
        '',
        '',
      ].map(sanitizeField));
    }
  }
  return rows;
}

function serializeRows(rows: string[][]): string {
  return [FEC_HEADERS.join('\t'), ...rows.map((row) => row.join('\t'))].join('\n') + '\n';
}

function buildDescription(input: {
  companyName: string;
  siren: string;
  from: DateOnly;
  to: DateOnly;
  filename: string;
  warnings: string[];
}): string {
  const lines = [
    'Descriptif du fichier des ecritures comptables (FEC)',
    `Societe: ${input.companyName}`,
    `SIREN: ${input.siren}`,
    `Periode: ${input.from} au ${input.to}`,
    `Fichier: ${input.filename}`,
    '',
    'Format',
    '- Fichier texte UTF-8.',
    '- Separateur de champs: tabulation.',
    '- Premiere ligne: noms des champs.',
    '- Dates: AAAAMMJJ.',
    '- Montants: euros avec virgule decimale.',
    '- Champs non utilises: vides, sans zero ni espace.',
    '',
    'Champs',
    ...FEC_HEADERS.map((header, index) => `${index + 1}. ${header}`),
    '',
    'Codes journaux',
    ...Object.entries(JOURNALS).map(([journal, meta]) => `- ${meta.code}: ${meta.label} (${journal})`),
    '',
    'Conventions Bob Pro',
    '- EcritureNum est une sequence continue dans l export; toutes les lignes d une meme ecriture partagent le meme numero.',
    '- PieceDate et ValidDate reprennent EcritureDate lorsque la date de piece ou de validation distincte n est pas stockee.',
    '- CompAuxNum, CompAuxLib, EcritureLet, DateLet, Montantdevise et Idevise restent vides tant que la donnee n est pas utilisee.',
    '',
    'Alertes',
    ...(input.warnings.length ? input.warnings.map((w) => `- ${w}`) : ['- Aucune alerte.']),
  ];
  return `${lines.join('\n')}\n`;
}

export class ExportFec {
  constructor(private readonly deps: ExportFecDeps) {}

  async execute(input: ExportFecInput): Promise<Result<ExportFecOutput, AppError>> {
    const issues: { field: string; message: string }[] = [];
    if (!isValidDateOnly(input.from)) issues.push(issue('from', 'Date de debut invalide.'));
    if (!isValidDateOnly(input.to)) issues.push(issue('to', 'Date de fin invalide.'));
    if (issues.length === 0 && input.from > input.to) issues.push(issue('to', 'La date de fin doit etre posterieure au debut.'));
    if (issues.length > 0) return err({ kind: 'validation', issues });

    const company = await this.deps.companies.findById(input.companyId);
    if (!company) return err(appNotFound('company', input.companyId));

    const [entries, chart] = await Promise.all([
      this.deps.entries.listByCompany(input.companyId),
      this.deps.charts ? this.deps.charts.findByCompany(input.companyId) : Promise.resolve(null),
    ]);
    const periodEntries = sortedEntries(entries, input.from, input.to);
    const warnings = new Set<string>();
    const rows = toFecRows(periodEntries, chart, warnings);
    const filename = `${company.siren}FEC${compactDate(input.to)}.txt`;
    const descriptionFilename = `${company.siren}FEC${compactDate(input.to)}-description.txt`;
    const warningList = [...warnings];

    return ok({
      filename,
      mimeType: 'text/plain; charset=utf-8',
      content: serializeRows(rows),
      descriptionFilename,
      descriptionContent: buildDescription({
        companyName: company.name,
        siren: company.siren,
        from: input.from,
        to: input.to,
        filename,
        warnings: warningList,
      }),
      entryCount: periodEntries.length,
      rowCount: rows.length,
      warnings: warningList,
    });
  }
}
