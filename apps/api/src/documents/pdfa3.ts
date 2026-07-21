import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

export const SRGB_2014_PROFILE_BYTE_SIZE = 3024;
export const SRGB_2014_PROFILE_SHA256 =
  '384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a';

const SRGB_2014_ASSET = 'sRGB2014.icc.base64';
const FILE_ID_DOMAIN = 'bob:facturx-pdf:v1\0';

function colorAssetCandidates(): string[] {
  const cwd = process.cwd();
  return [
    join(cwd, 'assets', 'color', SRGB_2014_ASSET),
    join(cwd, 'apps', 'api', 'assets', 'color', SRGB_2014_ASSET),
  ];
}

/**
 * Décode puis authentifie l'asset ICC officiel. Un profil absent, tronqué ou remplacé arrête le
 * rendu : un PDF ordinaire présenté comme PDF/A serait plus dangereux qu'une indisponibilité.
 */
export function decodeAndVerifySrgb2014Profile(base64: string): Uint8Array {
  const normalized = base64.replace(/\s/gu, '');
  const bytes = Buffer.from(normalized, 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== SRGB_2014_PROFILE_BYTE_SIZE || digest !== SRGB_2014_PROFILE_SHA256) {
    throw new Error(
      `PDF_ICC_PROFILE_INVALID: taille=${bytes.byteLength}, sha256=${digest}`,
    );
  }
  return new Uint8Array(bytes);
}

let cachedProfile: Uint8Array | null = null;

export function loadSrgb2014Profile(): Uint8Array {
  if (cachedProfile !== null) return cachedProfile;
  const candidates = colorAssetCandidates();
  const asset = candidates.find((candidate) => existsSync(candidate));
  if (asset === undefined) {
    throw new Error(`PDF_ICC_PROFILE_MISSING: chemins essayés : ${candidates.join(' ; ')}`);
  }
  cachedProfile = decodeAndVerifySrgb2014Profile(readFileSync(asset, 'utf8'));
  return cachedProfile;
}

/** Identifiant PDF stable de 16 octets, séparé par domaine et dérivé du XML comptable figé. */
export function facturXPdfFileId(xml: string): string {
  return createHash('sha256')
    .update(FILE_ID_DOMAIN, 'utf8')
    .update(xml, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export interface PdfA3EnvelopeInput {
  facturXXml: string;
  title: string;
  createdAt: Date;
}

/**
 * Représentation réglementaire réellement observée dans les octets du PDF. Cette valeur n'est
 * jamais déduite du client, du nom de fichier ou du job : elle est relue dans les structures
 * `AF`/`EmbeddedFiles` du conteneur PDF qui sera archivé.
 */
export type InvoicePdfRepresentation =
  | {
      ok: true;
      profile: 'plain_pdf';
      detectorVersion: 1;
      documentSha256: string;
      embeddedXmlSha256: null;
    }
  | {
      ok: true;
      profile: 'facturx_pdfa3';
      detectorVersion: 1;
      documentSha256: string;
      embeddedXmlSha256: string;
    }
  | { ok: false; reason: 'unknown_or_ambiguous' };

/**
 * Classe un PDF de facture de manière conservative :
 * - aucun fichier associé ni arbre EmbeddedFiles => PDF simple ;
 * - exactement un fichier associé `factur-x.xml`, relation Alternative, présent dans les deux
 *   structures requises => PDF hybride Factur-X ;
 * - toute forme partielle, ambiguë, multiple ou illisible => invalid.
 *
 * Le résultat `invalid` est fail-closed : un worker ne peut pas transformer une structure PDF
 * qu'il ne comprend pas en preuve d'archive légale.
 */
export async function inspectInvoicePdfRepresentation(
  bytes: Uint8Array,
): Promise<InvoicePdfRepresentation> {
  try {
    const documentSha256 = createHash('sha256').update(bytes).digest('hex');
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    const associatedFiles = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    const embeddedFiles = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
    const embeddedFileNames = embeddedFiles?.lookupMaybe(PDFName.of('Names'), PDFArray);
    const associatedCount = associatedFiles?.size() ?? 0;
    const embeddedNameEntryCount = embeddedFileNames?.size() ?? 0;

    const indirect = doc.context.enumerateIndirectObjects();
    const fileSpecs = indirect.filter(([, object]) =>
      object instanceof PDFDict
      && object.lookupMaybe(PDFName.of('Type'), PDFName)?.asString() === '/Filespec');
    const embeddedStreams = indirect.filter(([, object]) =>
      object instanceof PDFRawStream
      && object.dict.lookupMaybe(PDFName.of('Type'), PDFName)?.asString() === '/EmbeddedFile');

    const metadataObject = doc.catalog.lookup(PDFName.of('Metadata'));
    if (metadataObject !== undefined && !(metadataObject instanceof PDFRawStream)) {
      return { ok: false, reason: 'unknown_or_ambiguous' };
    }
    const metadata = metadataObject instanceof PDFRawStream ? metadataObject : undefined;
    const metadataText = metadata === undefined
      ? ''
      : new TextDecoder('utf-8', { fatal: true }).decode(decodePDFRawStream(metadata).decode());
    const hasFacturXMetadata =
      /<(?:[A-Za-z0-9_-]+:)?DocumentFileName>\s*factur-x\.xml\s*</iu.test(metadataText)
      || /<(?:[A-Za-z0-9_-]+:)?ConformanceLevel>/iu.test(metadataText)
      || /factur[- ]?x/iu.test(metadataText);

    if (
      associatedCount === 0
      && embeddedNameEntryCount === 0
      && fileSpecs.length === 0
      && embeddedStreams.length === 0
      && !hasFacturXMetadata
    ) {
      return {
        ok: true,
        profile: 'plain_pdf',
        detectorVersion: 1,
        documentSha256,
        embeddedXmlSha256: null,
      };
    }
    // Un name tree plat contient des paires [nom, FileSpec]. Notre writer n'émet qu'une pièce
    // jointe ; toute autre cardinalité est volontairement refusée.
    if (
      associatedCount !== 1
      || embeddedNameEntryCount !== 2
      || fileSpecs.length !== 1
      || embeddedStreams.length !== 1
    ) return { ok: false, reason: 'unknown_or_ambiguous' };

    const associatedSpec = associatedFiles?.lookupMaybe(0, PDFDict);
    const namedSpec = embeddedFileNames?.lookupMaybe(1, PDFDict);
    if (associatedSpec === undefined || namedSpec === undefined) {
      return { ok: false, reason: 'unknown_or_ambiguous' };
    }

    const filename = associatedSpec.lookupMaybe(
      PDFName.of('F'),
      PDFString,
      PDFHexString,
    );
    const unicodeFilename = associatedSpec.lookupMaybe(
      PDFName.of('UF'),
      PDFString,
      PDFHexString,
    );
    const treeFilename = embeddedFileNames?.lookupMaybe(0, PDFString, PDFHexString);
    const relationship = associatedSpec.lookupMaybe(PDFName.of('AFRelationship'), PDFName);
    const embeddedPayloadObject = associatedSpec
      .lookupMaybe(PDFName.of('EF'), PDFDict)
      ?.lookup(PDFName.of('F'));
    const embeddedPayload = embeddedPayloadObject instanceof PDFRawStream
      ? embeddedPayloadObject
      : undefined;
    const facturXXmpIsExactEnough =
      metadataText.includes('<pdfaid:part>3</pdfaid:part>')
      && metadataText.includes('<pdfaid:conformance>B</pdfaid:conformance>')
      && metadataText.includes('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>')
      && metadataText.includes('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
    const embeddedMime = embeddedPayload?.dict
      .lookupMaybe(PDFName.of('Subtype'), PDFName)
      ?.asString();

    if (!(filename?.decodeText() === 'factur-x.xml'
      && unicodeFilename?.decodeText() === 'factur-x.xml'
      && treeFilename?.decodeText() === 'factur-x.xml'
      && relationship?.toString() === '/Alternative'
      && associatedSpec === namedSpec
      && embeddedPayload !== undefined
      && embeddedMime === '/application#2Fxml'
      && facturXXmpIsExactEnough)) {
      return { ok: false, reason: 'unknown_or_ambiguous' };
    }
    const xmlBytes = decodePDFRawStream(embeddedPayload).decode();
    if (xmlBytes.byteLength === 0) return { ok: false, reason: 'unknown_or_ambiguous' };
    return {
      ok: true,
      profile: 'facturx_pdfa3',
      detectorVersion: 1,
      documentSha256,
      embeddedXmlSha256: createHash('sha256').update(xmlBytes).digest('hex'),
    };
  } catch {
    return { ok: false, reason: 'unknown_or_ambiguous' };
  }
}

/**
 * Applique l'enveloppe PDF/A-3b au document Factur-X sans post-processeur externe : ID trailer,
 * OutputIntent sRGB authentifié et espace couleur du groupe de transparence sur chaque page.
 */
export function applyPdfA3bEnvelope(doc: PDFDocument, input: PdfA3EnvelopeInput): void {
  const { context, catalog } = doc;
  const id = PDFHexString.of(facturXPdfFileId(input.facturXXml));
  context.trailerInfo.ID = context.obj([id, id]);

  const profileRef = context.register(
    context.flateStream(loadSrgb2014Profile(), { N: 3 }),
  );
  const outputIntentRef = context.register(
    context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
      OutputCondition: PDFString.of('sRGB IEC61966-2.1'),
      RegistryName: PDFString.of('http://www.color.org'),
      Info: PDFString.of('sRGB IEC61966-2.1 (sRGB2014)'),
      DestOutputProfile: profileRef,
    }),
  );
  catalog.set(PDFName.of('OutputIntents'), context.obj([outputIntentRef]));

  for (const page of doc.getPages()) {
    page.node.set(
      PDFName.of('Group'),
      context.obj({ Type: 'Group', S: 'Transparency', CS: 'DeviceRGB' }),
    );
  }

  doc.setTitle(input.title);
  doc.setCreator('Bob Pro');
  doc.setProducer('Bob Pro');
  doc.setLanguage('fr-FR');
  doc.setCreationDate(input.createdAt);
  doc.setModificationDate(input.createdAt);
}
