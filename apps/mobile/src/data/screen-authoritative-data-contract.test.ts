import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function screen(relativePath: string): string {
  return readFileSync(new URL(`../../app/${relativePath}`, import.meta.url), 'utf8');
}

describe('contrat données autoritatives des écrans métier', () => {
  it('Documents ne transforme jamais une source comptable absente en tableau vide', () => {
    const source = screen('(tabs)/documents.tsx');

    expect(source).toContain('hasBlockingAuthoritativeDataError([');
    expect(source).not.toMatch(/expenses:\s*expenses\.data\s*\?\?\s*\[\]/u);
    expect(source).not.toMatch(/invoices:\s*invoices\.data\s*\?\?\s*\[\]/u);
    expect(source).not.toMatch(/customers:\s*customers\.data\s*\?\?\s*\[\]/u);
    expect(source).toContain('expenses.data !== undefined');
    expect(source).toContain('documentFolders.data !== undefined');
  });

  it('Ventes ne retombe pas sur le filtre local quand la recherche serveur échoue', () => {
    const source = screen('ventes.tsx');

    expect(source).toContain('salesDocumentMatchesActiveSearch({');
    expect(source).toContain('serverSearchBlockingError');
    expect(source).not.toMatch(/matchedIds\s*!==\s*null\s*\?\s*matchedIds\.has\(id\)\s*:\s*local/u);
    expect(source).toContain('ventesDataReadyRef.current');
    expect(source).toContain('capabilities: ventesContextReady');
  });

  it('Catalogue ferme les écritures et la voix avant la première photographie PostgreSQL', () => {
    const source = screen('catalogue.tsx');
    const hook = readFileSync(new URL('./catalogue.ts', import.meta.url), 'utf8');

    expect(hook).toContain('mode: catalogueDataMode(');
    expect(source).toContain("const catalogueReady = catalogue.mode === 'ready'");
    expect(source).toContain('disabled={!catalogueReady}');
    expect(source).toContain('if (!catalogueReadyRef.current) return null');
    expect(source).toContain("catalogue.mode === 'error'");
  });

  it('Argent ne publie ni balance âgée partielle ni capacité Bob financière prématurée', () => {
    const source = screen('(tabs)/argent.tsx');

    expect(source).toContain('const agedLoading = invoices.isLoading || customers.isLoading');
    expect(source).toContain('authoritativeDataWhenHealthy(heroSafe)');
    expect(source).toContain('!balanceNeedsConfirmation && heroSafeData && !payGuidance.isLoading');
    expect(source).toContain('const agentDataReady =');
    expect(source).toContain('!balanceNeedsConfirmation &&');
    expect(source).toContain('capabilities: agentDataReady');
  });

  it('Accueil attend toutes ses sources financières avant les KPIs et Bob', () => {
    const source = screen('(tabs)/index.tsx');

    expect(source).toContain('const homeAgentDataReady =');
    expect(source).toContain('const bankBalanceSnapshot = authoritativeDataWhenHealthy(bankBalance)');
    expect(source).toContain('balanceConfirmation.cashflowInvalidatesBalance');
    expect(source).toContain('bankBalanceData !== undefined');
    expect(source).toContain('const prioritiesReady = !prioritiesLoading && !prioritiesFailed');
    expect(source).toContain('combineQueryStates(companyMe, invoices, today, contracts, notifications)');
    expect(source).toContain('fiscalFlow.profile !== undefined');
    expect(source).toContain('capabilities: homeAgentDataReady');
    expect(source).toContain('const glanceBlockingError =');
    expect(source).toContain('const glanceMissingBankingInput =');
    // Tolérant au formatage (props sur une ou plusieurs lignes) : le contrat porte sur la
    // présence de l'ErrorRetry avec la voix today.dataError, pas sur la mise en page JSX.
    expect(source).toMatch(/<ErrorRetry\s+message=\{t\('today\.dataError'/u);
  });

  it('les détails ferment leurs capacités Bob derrière leurs états de récupération', () => {
    const quote = screen('devis/[id].tsx');
    const invoice = screen('facture/[id].tsx');
    const document = screen('documents/[id].tsx');
    const folder = screen('documents/folder/[id].tsx');

    expect(quote).toContain('const screenDataReady =');
    expect(quote).toContain('screenDataReady ? quote.data?.status : undefined');
    expect(invoice).toContain('const screenDataReady =');
    expect(invoice).toContain('|| !screenDataReady');
    expect(document).toContain('const contextDocument = isDocumentView(document.data)');
    expect(folder).toContain('const documentsReady = documents.data !== undefined && !documents.isError');
  });

  it('les écrans transverses ferment Bob jusqu’au snapshot complet réellement affiché', () => {
    const chantiers = screen('chantiers.tsx');
    const search = screen('recherche.tsx');
    const pilotage = screen('pilotage.tsx');
    const accounting = screen('comptabilite.tsx');
    const closing = screen('cloture.tsx');

    expect(chantiers).toContain('chantiers.data !== undefined');
    expect(chantiers).toContain("capabilities: ready ? ['screen.read', 'chantier.read'] : []");
    expect(search).toContain('const dataReady =');
    expect(search).toContain('capabilities: dataReady');
    expect(pilotage).toContain('const agentDataReady =');
    expect(pilotage).toContain("capabilities: agentDataReady ? ['screen.read', 'customer.read'] : []");
    expect(accounting).toContain("capabilities: canExposeAccounting ? ['screen.read', 'accounting.read'] : []");
    expect(closing).toContain('const agentDataReady =');
    expect(closing).toContain("capabilities: agentDataReady ? ['screen.read'] : []");
    expect(closing).not.toMatch(/yy\s*\?\?\s*\d{4}|mm\s*\?\?\s*\d+/u);
  });

  it('le scan ne propose aucun classement à partir d’une fausse liste de dossiers vide', () => {
    const scan = screen('scan-document.tsx');
    const fiscal = screen('profil-fiscal.tsx');

    expect(scan).toContain('const foldersReady = rootFolders.data !== undefined');
    expect(scan).toContain('if (!foldersReady) return []');
    expect(scan).toContain('&& foldersReady');
    expect(scan).toContain("capabilities: archivedDocument ? ['screen.read', 'document.read'] : []");
    expect(fiscal).toContain('const profileReady = profile !== undefined');
    expect(fiscal).toContain("capabilities: profileReady ? ['screen.read', 'fiscal_profile.read', 'fiscal_profile.propose'] : []");
  });

  it('le carnet et la fiche client ne fabriquent ni standing ni encours en cas de source absente', () => {
    const clients = screen('(tabs)/clients.tsx');
    const detail = screen('client/[id].tsx');

    expect(clients).toContain('const sourcesFresh = sourcesReady && !staleError');
    expect(clients).toContain('if (customers.data === undefined || invoices.data === undefined || quotes.data === undefined) return []');
    expect(clients).toContain('disabled={!sourcesFresh}');
    expect(clients).toContain('capabilities:\n        sourcesFresh && !displayError');
    expect(detail).toContain('const standing = useMemo<CustomerStanding | null>');
    expect(detail).not.toContain("kind: 'nouveau', amountCents: 0");
    // Lot 4 : l'encours vit dans le héros (MoneyText) — l'invariant reste le même :
    // sources absentes ⇒ « — », jamais un zéro fabriqué.
    expect(detail).toContain('{outstandingCents === null ? (');
    expect(detail).not.toMatch(/paidOnTimeRatio\s*\?\?\s*0/u);
    expect(detail).toContain('customerFresh && piecesFresh');
  });

  it('Dépenses revalide la photographie serveur après la confirmation comptable', () => {
    const source = screen('depenses.tsx');

    expect(source).toContain('const dataFresh = dataReady && !staleError');
    expect(source).toContain('expenses.data === undefined ? null : summarizeExpenses');
    // La revalidation post-confirmation couvre les DEUX gestes comptables : le règlement exige
    // toujours `to_pay`, la régularisation exige l'état historique payé-sans-preuve.
    expect(source).toContain("currentExpense?.status === 'to_pay'");
    expect(source).toContain('isLegacyUnverifiedExpensePayment(currentExpense)');
    expect(source).toContain('if (!dataFreshRef.current || !stillActionable)');
    expect(source).toContain('disabled={pay.isPending || !dataFresh}');
    expect(source).toContain('disabled={regularize.isPending || !dataFresh}');
    expect(source).toContain("capabilities: contextReady ? ['screen.read', 'expense.read'] : []");
  });

  it('Notifications sépare le fil serveur réel des agrégats dont la fraîcheur est inconnue', () => {
    const source = screen('notifications.tsx');

    expect(source).toContain('const serverSnapshotReady = feed.unreadCount !== null');
    expect(source).toContain('const feedFresh = serverSnapshotReady && !feed.isLoading && !feed.isError');
    expect(source).toContain('if (!feedFreshRef.current) return');
    expect(source).toContain('dueRelanceProofsRef.current.get(entry.invoiceId) !== relanceProof(entry)');
    expect(source).toContain(') : staleFeed ? (');
  });

  it('Compte, onboarding et diagnostic signalent le cache périmé sans ouvrir les écritures', () => {
    const account = screen('compte.tsx');
    const onboarding = screen('onboarding.tsx');
    const diagnostic = screen('diagnostic.tsx');

    // Contrat réaligné 18/07 : la lane abonnement couvre aussi les factures Stripe (invoices),
    // et le formatage est multi-ligne — l'intention (stale = ready && erreur) est inchangée.
    expect(account).toMatch(
      /const subscriptionStaleError =\s*subscriptionReady && \(subscription\.isError \|\| subscriptionInvoices\.isError\)/u,
    );
    expect(account).toContain('const deleteAllowed = authEnabled && deleteCompanyName !== null');
    expect(onboarding).toContain('const sourcesFresh = sourcesReady && !sourcesStaleError');
    expect(onboarding).toContain('|| !sourcesFresh');
    expect(diagnostic).not.toMatch(/item\.count\s*\?\?\s*0/u);
    expect(diagnostic).toContain('const assessmentQ = useDiagnosticAssessment()');
    expect(diagnostic).toContain('const saveAssessment = useSaveDiagnosticAssessment()');
    expect(diagnostic).toContain('expectedRevision: assessmentQ.data.saved?.revision ?? 0');
    expect(diagnostic).toContain('expectedSourceFingerprint: sourceFingerprintSnapshot');
    expect(diagnostic).toContain('const result = persistedResult ? (');
    expect(diagnostic).not.toContain('<Result derived={derived}');
    expect(diagnostic).not.toContain('today: localToday()');
    expect(diagnostic).toContain('!queryState.failed && (sourceSnapshot !== null || sourcesReady)');
  });

  it('Assistant attend un abonnement vérifié et ne prétend pas être en ligne avant un échange réel', () => {
    const source = screen('(tabs)/assistant.tsx');

    expect(source).toContain('!assistantEntitlement.verified || !entitled');
    expect(source).toContain('if (!assistantEntitlement.verified)');
    expect(source).toContain('const [reachable, setReachable] = useState<boolean | null>(null)');
    expect(source).toContain('reachable !== null ? <View');
  });
});
