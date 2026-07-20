/**
 * Extraction du texte VISIBLE d'un PDF rendu par PdfRenderer — helper de TEST partagé
 * (pieces-conformes-rendus, facturation-terrain-rendus, purchase-order-flow,
 * retractation-a3-flow, pdf-renderer.test).
 *
 * Depuis l'embarquement des polices TTF (fontkit), pdf-lib encode chaque `Tj` en hex de
 * GLYPH IDs (fontes composites Identity-H) : le décodage latin1 historique ne suffit plus.
 * Ici : parcours des pages via pdf-lib, décompression des content streams, suivi de l'opérateur
 * `Tf` (police courante) et décodage de chaque chaîne via la CMap **ToUnicode** de la police
 * (fallback latin1 pour les polices standard sans ToUnicode — rétro-compatible Helvetica).
 *
 * La sortie liste chaque run de texte (un `drawText` = un run) joint par '\n' — mêmes
 * propriétés que l'ancien helper : une string légale dessinée d'un seul tenant reste
 * recherchable par `toContain` d'un seul tenant.
 */

import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';

type HexDecoder = (hex: string) => string;

function utf16beHexToString(hex: string): string {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

function latin1HexToString(hex: string): string {
  let out = '';
  for (let i = 0; i + 2 <= hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/** CMap ToUnicode (bfchar + bfrange) → table code (16 bits) → texte. */
function parseToUnicodeCMap(cmapText: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(entry[1]!, 16), utf16beHexToString(entry[2] ?? ''));
    }
  }
  for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const entryRe =
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[((?:\s*<[0-9A-Fa-f]*>)*)\s*\])/g;
    for (const entry of (block[1] ?? '').matchAll(entryRe)) {
      const lo = parseInt(entry[1]!, 16);
      const hi = parseInt(entry[2]!, 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo > 0xffff) continue;
      if (entry[3] !== undefined) {
        const start = parseInt(entry[3], 16);
        for (let code = lo; code <= hi; code++) {
          map.set(code, String.fromCharCode(start + (code - lo)));
        }
      } else {
        const dsts = [...(entry[4] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)].map((m) =>
          utf16beHexToString(m[1] ?? ''),
        );
        for (let code = lo; code <= hi && code - lo < dsts.length; code++) {
          map.set(code, dsts[code - lo] ?? '');
        }
      }
    }
  }
  return map;
}

function decodeStreamBytes(stream: PDFRawStream): Uint8Array {
  return decodePDFRawStream(stream).decode();
}

function bytesToLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/** Runs de texte d'un content stream, décodés avec la police active (opérateur Tf). */
function extractRuns(content: string, decoders: Map<string, HexDecoder>): string[] {
  const runs: string[] = [];
  let decoder: HexDecoder = latin1HexToString;
  const opRe =
    /\/([^\s/<>[\]()%]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (const match of content.matchAll(opRe)) {
    if (match[1] !== undefined) {
      decoder = decoders.get(match[1]) ?? latin1HexToString;
      continue;
    }
    if (match[2] !== undefined) {
      runs.push(decoder(match[2]));
      continue;
    }
    if (match[3] !== undefined) {
      runs.push(match[3].replace(/\\([()\\])/g, '$1'));
    }
  }
  return runs;
}

async function loadPages(bytes: Uint8Array): Promise<{
  pages: { content: string; decoders: Map<string, HexDecoder> }[];
}> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages().map((page) => {
    const { context } = doc;
    // Content stream(s) de la page, décompressés.
    const contentsRef = page.node.get(PDFName.of('Contents'));
    const contentsObj = contentsRef ? context.lookup(contentsRef) : undefined;
    const streams: PDFRawStream[] = [];
    if (contentsObj instanceof PDFRawStream) streams.push(contentsObj);
    else if (contentsObj instanceof PDFArray) {
      for (const element of contentsObj.asArray()) {
        const resolved = context.lookup(element);
        if (resolved instanceof PDFRawStream) streams.push(resolved);
      }
    }
    const content = streams.map((s) => bytesToLatin1(decodeStreamBytes(s))).join('\n');

    // Police (nom de ressource) → décodeur ToUnicode.
    const decoders = new Map<string, HexDecoder>();
    const resources = context.lookupMaybe(page.node.get(PDFName.of('Resources')), PDFDict);
    const fontDict = resources
      ? context.lookupMaybe(resources.get(PDFName.of('Font')), PDFDict)
      : undefined;
    if (fontDict) {
      for (const [name, value] of fontDict.entries()) {
        const font = context.lookupMaybe(value, PDFDict);
        if (!font) continue;
        const toUnicode = context.lookup(font.get(PDFName.of('ToUnicode')));
        if (toUnicode instanceof PDFRawStream) {
          const table = parseToUnicodeCMap(bytesToLatin1(decodeStreamBytes(toUnicode)));
          decoders.set(name.toString().replace(/^\//, ''), (hex) => {
            let out = '';
            for (let i = 0; i + 4 <= hex.length; i += 4) {
              out += table.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
            }
            return out;
          });
        }
      }
    }
    return { content, decoders };
  });
  return { pages };
}

/** Texte visible page par page (runs joints par '\n'). */
export async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  const { pages } = await loadPages(bytes);
  return pages.map(({ content, decoders }) => extractRuns(content, decoders).join('\n'));
}

/** Texte visible de tout le document — remplaçant direct de l'ancien helper latin1. */
export async function pdfVisibleText(bytes: Uint8Array): Promise<string> {
  return (await pdfPageTexts(bytes)).join('\n');
}

/** Triplets `rg` (fill) de tous les content streams, arrondis à 3 décimales — pour verrouiller
 *  les accents RECALÉS sur les tokens (WYSIWYG sélecteur mobile → papier). */
export async function pdfFillColors(bytes: Uint8Array): Promise<Set<string>> {
  const { pages } = await loadPages(bytes);
  const found = new Set<string>();
  for (const { content } of pages) {
    for (const m of content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)) {
      found.add(
        [m[1], m[2], m[3]].map((v) => Number.parseFloat(v!).toFixed(3)).join(' '),
      );
    }
  }
  return found;
}

/**
 * Contenu structurel « brut + flux dégonflés » (latin1) — pour les assertions sur la STRUCTURE
 * du PDF (pièce jointe Factur-X, AFRelationship, XMP), pas sur le texte visible : pdf-lib range
 * les dictionnaires (Filespec…) dans des object streams compressés.
 */
export function pdfStructuralText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const chunks: string[] = [raw.toString('latin1')];
  let cursor = 0;
  for (;;) {
    const start = raw.indexOf('stream', cursor);
    if (start === -1) break;
    const dataStart = raw.indexOf('\n', start) + 1;
    const end = raw.indexOf('endstream', dataStart);
    if (dataStart === 0 || end === -1) break;
    try {
      chunks.push(inflateSync(raw.subarray(dataStart, end)).toString('latin1'));
    } catch {
      // Flux non compressé ou binaire — déjà couvert par le texte brut.
    }
    cursor = end + 'endstream'.length;
  }
  return chunks.join('\n');
}

/** Triplet attendu pour un hex donné, au même arrondi que `pdfFillColors`. */
export function hexFillTriplet(hex: string): string {
  const v = hex.replace('#', '');
  return [v.slice(0, 2), v.slice(2, 4), v.slice(4, 6)]
    .map((c) => (parseInt(c, 16) / 255).toFixed(3))
    .join(' ');
}
