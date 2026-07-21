import { CabinetApiError, type CabinetDossierDetail, type CabinetDossierListItem, type CabinetDossierPage } from './api';

export interface CabinetDossierPageTransport {
  readonly listDossiers: (cabinetId: string, cursor?: string) => Promise<CabinetDossierPage>;
}

const MAX_DOSSIER_PAGES = 10_000;

/** Charge le portefeuille complet sans accepter une pagination cyclique ou des doublons. */
export async function loadCabinetDossierPortfolio(
  transport: CabinetDossierPageTransport,
  cabinetId: string,
): Promise<readonly CabinetDossierListItem[]> {
  const items: CabinetDossierListItem[] = [];
  const seenCursors = new Set<string>();
  const seenSirens = new Set<string>();
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < MAX_DOSSIER_PAGES; pageIndex += 1) {
    const page = await transport.listDossiers(cabinetId, cursor);
    for (const dossier of page.items) {
      if (dossier.cabinetId !== cabinetId || seenSirens.has(dossier.siren)) {
        throw new CabinetApiError(
          'Cabinet API returned an inconsistent dossier portfolio',
          502,
          'invalid_response',
        );
      }
      seenSirens.add(dossier.siren);
      items.push(dossier);
    }

    if (!page.hasMore) return items;
    if (page.nextCursor === null || seenCursors.has(page.nextCursor)) {
      throw new CabinetApiError(
        'Cabinet API returned a cyclic dossier cursor',
        502,
        'invalid_response',
      );
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new CabinetApiError(
    'Cabinet dossier pagination exceeded its safety limit',
    502,
    'invalid_response',
  );
}

export function dossierSummaryFromDetail(detail: CabinetDossierDetail): CabinetDossierListItem {
  const { analysis: _analysis, analysisSha256: _analysisSha256, ...summary } = detail;
  return summary;
}

export function replaceDossierSummary(
  current: readonly CabinetDossierListItem[],
  detail: CabinetDossierDetail,
): readonly CabinetDossierListItem[] {
  const summary = dossierSummaryFromDetail(detail);
  return [...current.filter((dossier) => dossier.siren !== detail.siren), summary]
    .sort((left, right) => right.lastImportedAt.localeCompare(left.lastImportedAt));
}
