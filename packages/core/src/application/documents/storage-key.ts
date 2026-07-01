import { type DocumentProps } from '../../domain/document/document';

const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function extensionFromFilename(filename: string): string | null {
  const match = /\.([a-zA-Z0-9]{1,12})$/.exec(filename.trim());
  if (!match) return null;
  return match[1]!.toLowerCase();
}

export function documentFileExtension(input: { filename: string; mimeType: string }): string {
  return extensionFromFilename(input.filename) ?? MIME_EXTENSIONS[input.mimeType.toLowerCase()] ?? 'bin';
}

export function buildDocumentStorageKey(input: {
  companyId: string;
  documentId: string;
  version: number;
  sha256: string;
  filename: string;
  mimeType: string;
}): DocumentProps['storageKey'] {
  const ext = documentFileExtension({ filename: input.filename, mimeType: input.mimeType });
  return `companies/${input.companyId}/documents/${input.documentId}/v${input.version}/${input.sha256}.${ext}`;
}
