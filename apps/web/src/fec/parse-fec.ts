import { FEC_HEADERS } from '@bob/core';

export type FecHeader = (typeof FEC_HEADERS)[number];

export interface FecParseIssue {
  readonly line: number;
  readonly field?: FecHeader | 'En-tête';
  readonly detail: string;
}

/**
 * Erreur lisible par l'interface : elle indique toujours la ligne physique et, lorsque
 * possible, le nom réglementaire du champ FEC en cause.
 */
export class FecParseError extends Error {
  readonly issues: readonly FecParseIssue[];

  constructor(issue: FecParseIssue) {
    const field = issue.field === undefined ? '' : `, champ « ${issue.field} »`;
    super(`Ce fichier ne ressemble pas à un FEC : ligne ${issue.line}${field} : ${issue.detail}`);
    this.name = 'FecParseError';
    this.issues = [issue];
  }

  get line(): number {
    return this.issues[0]?.line ?? 1;
  }

  get field(): FecParseIssue['field'] {
    return this.issues[0]?.field;
  }
}

export interface ParsedFecRow {
  /** Numéro de ligne physique dans le fichier (en-tête = ligne 1). */
  readonly lineNumber: number;
  readonly journalCode: string;
  readonly journalLabel: string;
  readonly entryNumber: string;
  /** Date ISO AAAA-MM-JJ, après validation de la date FEC AAAAMMJJ. */
  readonly entryDate: string;
  readonly account: string;
  readonly accountLabel: string;
  readonly auxiliaryAccount: string | null;
  readonly auxiliaryAccountLabel: string | null;
  readonly pieceReference: string;
  readonly pieceDate: string | null;
  readonly entryLabel: string;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly lettering: string | null;
  readonly letteringDate: string | null;
  readonly validationDate: string | null;
  /** Montant en devise conservé sans conversion : il peut avoir une précision autre que 2. */
  readonly currencyAmount: string | null;
  readonly currency: string | null;
}

export interface ParsedFecEntryLine {
  readonly account: string;
  readonly label: string;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly sourceLine: number;
}

export interface ParsedFecEntry {
  /** Clé stable dans le fichier. EcritureNum n'est séquentiel que par journal. */
  readonly key: string;
  readonly journalCode: string;
  readonly journalLabel: string;
  readonly entryNumber: string;
  readonly entryDate: string;
  readonly pieceReference: string;
  readonly label: string;
  readonly lines: readonly ParsedFecEntryLine[];
}

export interface ParsedFec {
  readonly rows: readonly ParsedFecRow[];
  readonly entries: readonly ParsedFecEntry[];
  readonly period: {
    readonly from: string | null;
    readonly to: string | null;
  };
  /** Premier libellé non vide rencontré pour chaque compte. */
  readonly accountLabels: Readonly<Record<string, string>>;
}

type BinaryFec = ArrayBuffer | Uint8Array;

function fail(line: number, field: FecParseIssue['field'], detail: string): never {
  throw new FecParseError({ line, field, detail });
}

function bytesOf(input: BinaryFec): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function withoutByteOrderMark(input: Uint8Array): Uint8Array {
  // Certains logiciels ajoutent un BOM UTF-8 devant un contenu pourtant déclaré Latin-9.
  // Le retirer avant TextDecoder évite qu'il devienne littéralement « ï»¿ » dans JournalCode.
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) return input.subarray(3);
  return input;
}

function decodeFec(input: BinaryFec): string {
  const decoded = new TextDecoder('iso-8859-15').decode(withoutByteOrderMark(bytesOf(input)));
  // Garde-fou pour les environnements qui exposeraient malgré tout un BOM Unicode.
  return decoded.replace(/^\uFEFF/, '');
}

function required(raw: string, line: number, field: FecHeader): string {
  const value = raw.trim();
  if (value.length === 0) fail(line, field, 'la valeur est obligatoire.');
  return value;
}

function parseDate(raw: string, line: number, field: FecHeader, mandatory: boolean): string | null {
  const value = raw.trim();
  if (value.length === 0) {
    if (mandatory) fail(line, field, 'la date est obligatoire (format AAAAMMJJ).');
    return null;
  }
  if (!/^\d{8}$/.test(value)) fail(line, field, `« ${value} » doit respecter le format AAAAMMJJ.`);

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = daysInMonth[month - 1];
  if (year === 0 || maxDay === undefined || day < 1 || day > maxDay) {
    fail(line, field, `« ${value} » n'est pas une date calendaire valide.`);
  }

  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** Conversion exacte chaîne -> centimes : aucune opération en virgule flottante. */
function parseAmount(raw: string, line: number, field: 'Debit' | 'Credit'): number {
  const value = raw.trim();
  // Les exports courants représentent parfois le zéro par une cellule vide.
  if (value.length === 0) return 0;

  const match = /^([+-]?)(\d+)(?:,(\d{1,2}))?$/.exec(value);
  if (!match) {
    const hint = value.includes('.')
      ? 'utilisez une virgule comme séparateur décimal'
      : 'format attendu : 1234,56';
    fail(line, field, `montant « ${value} » invalide (${hint}).`);
  }

  const [, sign = '', euros = '0', decimalPart = ''] = match;
  const decimals = decimalPart.padEnd(2, '0');
  const absoluteCents = BigInt(euros) * 100n + BigInt(decimals || '0');
  const signedCents = sign === '-' ? -absoluteCents : absoluteCents;
  if (
    signedCents > BigInt(Number.MAX_SAFE_INTEGER) ||
    signedCents < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    fail(line, field, `montant « ${value} » trop grand pour être totalisé exactement.`);
  }
  return Number(signedCents);
}

function nullableText(raw: string): string | null {
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

function parseHeader(line: string): void {
  const received = line.split('\t');
  if (received.length !== FEC_HEADERS.length) {
    fail(
      1,
      'En-tête',
      `${received.length} colonnes reçues ; ${FEC_HEADERS.length} colonnes exactes sont attendues.`,
    );
  }

  for (let index = 0; index < FEC_HEADERS.length; index += 1) {
    const expected = FEC_HEADERS[index];
    const actual = received[index];
    if (actual !== expected) {
      fail(
        1,
        'En-tête',
        `colonne ${index + 1} : « ${actual ?? ''} » reçue, « ${expected} » attendue.`,
      );
    }
  }
}

function parseRow(line: string, lineNumber: number): ParsedFecRow {
  const values = line.split('\t');
  if (values.length !== FEC_HEADERS.length) {
    fail(
      lineNumber,
      'En-tête',
      `${values.length} colonnes reçues ; chaque écriture doit contenir les ${FEC_HEADERS.length} champs FEC.`,
    );
  }

  const value = (header: FecHeader): string => values[FEC_HEADERS.indexOf(header)] ?? '';
  return {
    lineNumber,
    journalCode: required(value('JournalCode'), lineNumber, 'JournalCode'),
    journalLabel: value('JournalLib').trim(),
    entryNumber: required(value('EcritureNum'), lineNumber, 'EcritureNum'),
    entryDate: parseDate(value('EcritureDate'), lineNumber, 'EcritureDate', true)!,
    account: required(value('CompteNum'), lineNumber, 'CompteNum'),
    accountLabel: value('CompteLib').trim(),
    auxiliaryAccount: nullableText(value('CompAuxNum')),
    auxiliaryAccountLabel: nullableText(value('CompAuxLib')),
    pieceReference: value('PieceRef').trim(),
    pieceDate: parseDate(value('PieceDate'), lineNumber, 'PieceDate', false),
    entryLabel: value('EcritureLib').trim(),
    debitCents: parseAmount(value('Debit'), lineNumber, 'Debit'),
    creditCents: parseAmount(value('Credit'), lineNumber, 'Credit'),
    lettering: nullableText(value('EcritureLet')),
    letteringDate: parseDate(value('DateLet'), lineNumber, 'DateLet', false),
    validationDate: parseDate(value('ValidDate'), lineNumber, 'ValidDate', false),
    currencyAmount: nullableText(value('Montantdevise')),
    currency: nullableText(value('Idevise')),
  };
}

function groupEntries(rows: readonly ParsedFecRow[]): readonly ParsedFecEntry[] {
  type MutableEntry = Omit<ParsedFecEntry, 'lines'> & { lines: ParsedFecEntryLine[] };
  const byKey = new Map<string, MutableEntry>();

  for (const row of rows) {
    // JSON encode le tuple pour qu'aucun séparateur présent dans les valeurs ne crée de collision.
    const key = JSON.stringify([row.journalCode, row.entryNumber]);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        journalCode: row.journalCode,
        journalLabel: row.journalLabel,
        entryNumber: row.entryNumber,
        entryDate: row.entryDate,
        pieceReference: row.pieceReference,
        label: row.entryLabel,
        lines: [],
      };
      byKey.set(key, entry);
    }
    entry.lines.push({
      account: row.account,
      label: row.accountLabel,
      debitCents: row.debitCents,
      creditCents: row.creditCents,
      sourceLine: row.lineNumber,
    });
  }

  return [...byKey.values()];
}

export function parseFec(input: BinaryFec): ParsedFec {
  const physicalLines = decodeFec(input).split(/\r\n|\n|\r/);
  // Une ou plusieurs lignes blanches finales sont tolérées, pas un trou au milieu du FEC.
  while (physicalLines.length > 0 && physicalLines.at(-1)?.trim() === '') physicalLines.pop();
  if (physicalLines.length === 0 || physicalLines[0]?.length === 0) {
    fail(1, 'En-tête', `l'en-tête FEC est absent.`);
  }
  parseHeader(physicalLines[0]!);

  const rows: ParsedFecRow[] = [];
  for (let index = 1; index < physicalLines.length; index += 1) {
    const line = physicalLines[index]!;
    if (line.trim() === '') fail(index + 1, 'En-tête', `une ligne vide coupe les écritures.`);
    rows.push(parseRow(line, index + 1));
  }

  const dates = rows.map((row) => row.entryDate).sort((left, right) => left.localeCompare(right));
  const accountLabels: Record<string, string> = {};
  for (const row of rows) {
    if (accountLabels[row.account] === undefined && row.accountLabel.length > 0) {
      accountLabels[row.account] = row.accountLabel;
    }
  }

  return {
    rows,
    entries: groupEntries(rows),
    period: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    accountLabels,
  };
}
