import { FEC_HEADERS } from '@bob/core';
import { describe, expect, it } from 'vitest';

import { FecParseError, parseFec } from './parse-fec';

type Header = (typeof FEC_HEADERS)[number];

const DEFAULT_ROW: Record<Header, string> = {
  JournalCode: 'VE',
  JournalLib: 'Journal des ventes',
  EcritureNum: '000001',
  EcritureDate: '20240229',
  CompteNum: '411',
  CompteLib: 'Clients',
  CompAuxNum: '',
  CompAuxLib: '',
  PieceRef: 'FA-001',
  PieceDate: '20240229',
  EcritureLib: 'Facture client',
  Debit: '1200,00',
  Credit: '0,00',
  EcritureLet: '',
  DateLet: '',
  ValidDate: '20240229',
  Montantdevise: '',
  Idevise: '',
};

function row(overrides: Partial<Record<Header, string>> = {}): string {
  const values = { ...DEFAULT_ROW, ...overrides };
  return FEC_HEADERS.map((header) => values[header]).join('\t');
}

function latin9Bytes(text: string, withBom = false): Uint8Array {
  const bytes: number[] = withBom ? [0xef, 0xbb, 0xbf] : [];
  for (const character of text) {
    if (character === '€') bytes.push(0xa4);
    else {
      const code = character.codePointAt(0)!;
      if (code > 0xff) throw new Error(`Caractere fixture non Latin-9 : ${character}`);
      bytes.push(code);
    }
  }
  return Uint8Array.from(bytes);
}

function fec(
  lines: readonly string[],
  options: { crlf?: boolean; bom?: boolean; finalBlanks?: number } = {},
): Uint8Array {
  const newline = options.crlf ? '\r\n' : '\n';
  const finalBlanks = newline.repeat(options.finalBlanks ?? 1);
  return latin9Bytes([FEC_HEADERS.join('\t'), ...lines].join(newline) + finalBlanks, options.bom);
}

describe('parseFec', () => {
  it('decode le Latin-9, tolere BOM/CRLF/lignes finales et conserve auxiliaires et lettrage', () => {
    const bytes = fec(
      [
        row({
          CompteLib: 'Clients été €',
          CompAuxNum: '411DUPONT',
          CompAuxLib: 'Dupont été',
          EcritureLet: 'AA',
          DateLet: '20240315',
        }),
        row({ CompteNum: '706', CompteLib: 'Prestations', Debit: '0,00', Credit: '1000,00' }),
        row({ CompteNum: '44571', CompteLib: 'TVA collectée', Debit: '0,00', Credit: '200,00' }),
        row({
          JournalCode: 'BQ',
          JournalLib: 'Banque',
          CompteNum: '512',
          CompteLib: 'Banque',
          Debit: '1200,00',
          Credit: '0,00',
        }),
        row({
          JournalCode: 'BQ',
          JournalLib: 'Banque',
          CompteNum: '411',
          CompteLib: 'Clients été €',
          Debit: '0,00',
          Credit: '1200,00',
        }),
      ],
      { bom: true, crlf: true, finalBlanks: 2 },
    );
    const parsed = parseFec(bytes.buffer as ArrayBuffer);

    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows[0]).toMatchObject({
      accountLabel: 'Clients été €',
      auxiliaryAccount: '411DUPONT',
      auxiliaryAccountLabel: 'Dupont été',
      lettering: 'AA',
      letteringDate: '2024-03-15',
      entryDate: '2024-02-29',
      debitCents: 120_000,
    });
    // Le numero 000001 existe dans deux journaux : ce sont bien deux ecritures distinctes.
    expect(parsed.entries).toHaveLength(2);
    expect(
      parsed.entries.map((entry) => [entry.journalCode, entry.entryNumber, entry.lines.length]),
    ).toEqual([
      ['VE', '000001', 3],
      ['BQ', '000001', 2],
    ]);
    expect(parsed.period).toEqual({ from: '2024-02-29', to: '2024-02-29' });
  });

  it('exige les 18 en-tetes exacts et localise la premiere colonne differente', () => {
    const headers: string[] = [...FEC_HEADERS];
    headers[4] = 'NumeroCompte';

    expect(() => parseFec(latin9Bytes(`${headers.join('\t')}\n`))).toThrowError(
      /ligne 1, champ « En-tête ».*colonne 5.*CompteNum/,
    );
  });

  it('convertit exactement les montants sans float, y compris signe et cellule vide', () => {
    const parsed = parseFec(
      fec([
        row({ Debit: '1234567890123,45', Credit: '' }),
        row({ CompteNum: '706', Debit: '-0,10', Credit: '1,2' }),
      ]),
    );

    expect(parsed.rows[0]?.debitCents).toBe(123_456_789_012_345);
    expect(parsed.rows[0]?.creditCents).toBe(0);
    expect(parsed.rows[1]).toMatchObject({ debitCents: -10, creditCents: 120 });
  });

  it('refuse un separateur decimal non FEC avec la ligne et le champ honnetes', () => {
    expect(() => parseFec(fec([row({ Debit: '12.34' })]))).toThrowError(
      /ligne 2, champ « Debit ».*virgule/,
    );
  });

  it('valide toutes les dates renseignees, sans normaliser une date impossible', () => {
    try {
      parseFec(fec([row({ PieceDate: '20230229' })]));
      throw new Error('Le parseur aurait du echouer.');
    } catch (error) {
      expect(error).toBeInstanceOf(FecParseError);
      expect(error).toMatchObject({ line: 2, field: 'PieceDate' });
      expect((error as Error).message).toContain("n'est pas une date calendaire valide");
    }
  });

  it('parse un fichier desequilibre et laisse les moteurs produire le diagnostic', () => {
    const parsed = parseFec(fec([row({ Debit: '10,00', Credit: '0,00' })]));

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.lines).toEqual([
      expect.objectContaining({ account: '411', debitCents: 1_000, creditCents: 0 }),
    ]);
  });

  it('accepte un FEC vide limite a son en-tete', () => {
    expect(parseFec(fec([]))).toMatchObject({
      rows: [],
      entries: [],
      period: { from: null, to: null },
    });
  });
});
