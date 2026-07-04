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

/**
 * Données auxiliaires du FEC probant (E7) — port dédié (ISP) : fournies, elles remplissent
 * lettrage (EcritureLet/DateLet), comptes auxiliaires clients (411) et fournisseurs (401) ;
 * absentes, les colonnes restent vides (compat implémentations amont).
 */
export interface FecAuxiliaryData {
  invoices: { id: string; status: string; customerId: string }[];
  payments: { id: string; invoiceId: string; receivedAt: string }[];
  customers: { id: string; name: string }[];
  expenses: { id: string; supplierName: string }[];
}

export interface FecAuxiliaryDataPort {
  get(companyId: string): Promise<FecAuxiliaryData>;
}

export interface ExportFecDeps {
  companies: CompanyRepository;
  entries: AccountingEntryRepository;
  charts?: ChartOfAccountsRepository;
  auxiliary?: FecAuxiliaryDataPort;
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

/** Code de lettrage séquentiel : AA, AB … AZ, BA … (convention cabinet, stable par export). */
export function lettrageCode(index: number): string {
  const first = Math.floor(index / 26) % 26;
  const second = index % 26;
  return `${String.fromCharCode(65 + first)}${String.fromCharCode(65 + second)}`;
}

/** Identifiant d'auxiliaire déterministe : majuscules alphanumériques (accents/espaces → tiret). */
function auxNum(prefix: string, raw: string): string {
  const slug = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${prefix}${slug}`;
}

interface FecRowEnrichment {
  /** (compte 411) lettrage par entryId — posé UNIQUEMENT sur les factures SOLDÉES. */
  lettrageByEntryId: Map<string, { code: string; date: string }>;
  /** Auxiliaire par entryId pour les lignes 411 (client) — num + libellé. */
  customerAuxByEntryId: Map<string, { num: string; label: string }>;
  /** Auxiliaire par entryId pour les lignes 401 (fournisseur). */
  supplierAuxByEntryId: Map<string, { num: string; label: string }>;
}

/**
 * Dérive le lettrage et les auxiliaires depuis les données vivantes (E7) :
 * · lettrage 411 : une facture PAYÉE reçoit un code (AA, AB…) posé sur SA ligne 411
 *   (écriture de vente) ET sur les lignes 411 de ses encaissements — DateLet = date du
 *   dernier paiement. Une facture non soldée ne se lettre JAMAIS (lettrage partiel interdit) ;
 * · auxiliaires : 411 → client de la pièce (num déterministe + nom), 401 → fournisseur
 *   de la dépense. Le solde d'un auxiliaire devient justifiable ligne à ligne.
 */
function deriveFecEnrichment(entries: AccountingEntry[], aux: FecAuxiliaryData): FecRowEnrichment {
  const enrichment: FecRowEnrichment = {
    lettrageByEntryId: new Map(),
    customerAuxByEntryId: new Map(),
    supplierAuxByEntryId: new Map(),
  };
  const customerName = new Map(aux.customers.map((c) => [c.id, c.name]));
  const invoiceById = new Map(aux.invoices.map((i) => [i.id, i]));
  const paymentById = new Map(aux.payments.map((p) => [p.id, p]));
  const expenseById = new Map(aux.expenses.map((e) => [e.id, e]));
  const paymentsByInvoice = new Map<string, { receivedAt: string }[]>();
  for (const p of aux.payments) {
    const list = paymentsByInvoice.get(p.invoiceId) ?? [];
    list.push(p);
    paymentsByInvoice.set(p.invoiceId, list);
  }

  // Lettres allouées par ordre stable (id de facture) — un export = un lettrage reproductible.
  const paidInvoices = aux.invoices.filter((i) => i.status === 'paid').sort((a, b) => a.id.localeCompare(b.id));
  const letterByInvoice = new Map<string, { code: string; date: string }>();
  let letterIndex = 0;
  for (const invoice of paidInvoices) {
    const payments = paymentsByInvoice.get(invoice.id) ?? [];
    if (payments.length === 0) continue; // soldée sans encaissement tracé : rien à lettrer
    const lastPayment = payments.map((p) => p.receivedAt.slice(0, 10)).sort().at(-1) ?? '';
    letterByInvoice.set(invoice.id, { code: lettrageCode(letterIndex), date: lastPayment });
    letterIndex += 1;
  }

  for (const entry of entries) {
    // Facture liée à l'écriture : directe (vente/avoir) ou via l'encaissement.
    const invoiceId =
      entry.sourceType === 'invoice'
        ? entry.sourceId
        : entry.sourceType === 'payment'
          ? (paymentById.get(entry.sourceId)?.invoiceId ?? null)
          : null;
    if (invoiceId !== null) {
      const lettre = letterByInvoice.get(invoiceId);
      if (lettre) enrichment.lettrageByEntryId.set(entry.id, lettre);
      const invoice = invoiceById.get(invoiceId);
      const name = invoice ? customerName.get(invoice.customerId) : undefined;
      if (invoice && name !== undefined)
        enrichment.customerAuxByEntryId.set(entry.id, { num: auxNum('411', invoice.customerId), label: name });
    }
    if (entry.sourceType === 'expense') {
      const expense = expenseById.get(entry.sourceId);
      if (expense)
        enrichment.supplierAuxByEntryId.set(entry.id, {
          num: auxNum('401', expense.supplierName),
          label: expense.supplierName,
        });
    }
  }
  return enrichment;
}

function toFecRows(
  entries: AccountingEntry[],
  chart: ChartOfAccounts | null,
  warnings: Set<string>,
  enrichment: FecRowEnrichment | null,
): string[][] {
  const rows: string[][] = [];
  // E9 : EcritureNum est une séquence chronologique continue PAR JOURNAL (convention
  // contrôleur) — les entries arrivent triées par date, chaque journal tient son compteur.
  const seqByJournal = new Map<string, number>();
  for (const entry of entries) {
    const journal = JOURNALS[entry.journal];
    const next = (seqByJournal.get(journal.code) ?? 0) + 1;
    seqByJournal.set(journal.code, next);
    const ecritureNum = String(next).padStart(6, '0');
    for (const line of entry.lines) {
      // E7 : lettrage et auxiliaire ne se posent que sur les lignes de TIERS concernées.
      const isCustomerLine = line.account.startsWith('411');
      const isSupplierLine = line.account.startsWith('401');
      const lettre = enrichment && isCustomerLine ? (enrichment.lettrageByEntryId.get(entry.id) ?? null) : null;
      const auxiliary =
        enrichment && isCustomerLine
          ? (enrichment.customerAuxByEntryId.get(entry.id) ?? null)
          : enrichment && isSupplierLine
            ? (enrichment.supplierAuxByEntryId.get(entry.id) ?? null)
            : null;
      rows.push([
        journal.code,
        journal.label,
        ecritureNum,
        compactDate(entry.entryDate),
        line.account,
        accountLabel(chart, line.account, warnings),
        auxiliary?.num ?? '',
        auxiliary?.label ?? '',
        entry.reference,
        compactDate(entry.entryDate),
        line.label || entry.label,
        centsToFecAmount(line.debitCents),
        centsToFecAmount(line.creditCents),
        lettre?.code ?? '',
        lettre ? compactDate(lettre.date) : '',
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
    '- Fichier texte ISO 8859-15 (arrete du 29 juillet 2013).',
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
    '- EcritureNum est une sequence chronologique continue PAR JOURNAL; toutes les lignes d une meme ecriture partagent le meme numero.',
    '- PieceDate et ValidDate reprennent EcritureDate lorsque la date de piece ou de validation distincte n est pas stockee.',
    '- Lettrage (EcritureLet/DateLet): pose sur les lignes 411 des factures SOLDEES et de leurs encaissements; DateLet = date du dernier reglement. Une facture non soldee n est jamais lettree.',
    '- Comptes auxiliaires: CompAuxNum/CompAuxLib renseignes sur les lignes 411 (client de la piece) et 401 (fournisseur de la depense); identifiants deterministes derives du tiers.',
    '- Montantdevise et Idevise restent vides (comptabilite tenue en euros).',
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

    const [entries, chart, auxiliary] = await Promise.all([
      this.deps.entries.listByCompany(input.companyId),
      this.deps.charts ? this.deps.charts.findByCompany(input.companyId) : Promise.resolve(null),
      this.deps.auxiliary ? this.deps.auxiliary.get(input.companyId) : Promise.resolve(null),
    ]);
    const periodEntries = sortedEntries(entries, input.from, input.to);
    const warnings = new Set<string>();
    const enrichment = auxiliary ? deriveFecEnrichment(periodEntries, auxiliary) : null;
    const rows = toFecRows(periodEntries, chart, warnings, enrichment);
    const filename = `${company.siren}FEC${compactDate(input.to)}.txt`;
    const descriptionFilename = `${company.siren}FEC${compactDate(input.to)}-description.txt`;
    const warningList = [...warnings];

    return ok({
      filename,
      // E9 : le FICHIER remis s'encode en ISO 8859-15 (encodeLatin9 côté écriture) —
      // le champ content reste une string JS, l'encodage se joue à la matérialisation.
      mimeType: 'text/plain; charset=iso-8859-15',
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
