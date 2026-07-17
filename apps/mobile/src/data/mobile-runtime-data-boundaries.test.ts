import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MOBILE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNTIME_ROOTS = [
  fileURLToPath(new URL('../../app/', import.meta.url)),
  fileURLToPath(new URL('../', import.meta.url)),
] as const;

const FORBIDDEN_RUNTIME_IMPORT =
  /(?:from\s*|import\s*\()['"][^'"]*(?:@bob\/(?:core|api-client|ai)\/testing|\/fixtures(?:\/|['"]?)|\/in-memory(?:\/|['"]?)|local-client|demo-(?:adapter|ocr|stt|tts))[^'"]*['"]/u;
const FORBIDDEN_RUNTIME_SYMBOL =
  /\b(?:InMemory[A-Za-z0-9_]*|LocalBobClient|DemoOcrAdapter|MERCIER_PROPS|TODAY_FIXTURE|CASH_SNAPSHOT|seedCompany|seedCustomers|seedExpenses|seedVaultDocuments)\b/u;

function runtimeSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) return runtimeSources(path);
    if (!entry.isFile() || !['.ts', '.tsx'].includes(extname(entry.name))) return [];
    if (/\.(?:test|spec)\.[^.]+$/u.test(entry.name)) return [];
    return [path];
  });
}

describe('frontières des données du runtime mobile', () => {
  const sources = RUNTIME_ROOTS.flatMap(runtimeSources);

  it('aucun écran ni service embarqué n importe une fixture ou un adaptateur local', () => {
    const leaks = sources.flatMap((path) => {
      const code = readFileSync(path, 'utf8');
      return FORBIDDEN_RUNTIME_IMPORT.test(code) ? [relative(MOBILE_ROOT, path)] : [];
    });

    expect(leaks).toEqual([]);
  });

  it('aucun symbole de double, seed ou fixture ne subsiste dans le runtime mobile', () => {
    const leaks = sources.flatMap((path) => {
      const code = readFileSync(path, 'utf8');
      return FORBIDDEN_RUNTIME_SYMBOL.test(code) ? [relative(MOBILE_ROOT, path)] : [];
    });

    expect(leaks).toEqual([]);
  });

  it('aucun runtime mobile ne contient une URL du domaine de démonstration', () => {
    const leaks = sources.flatMap((path) => {
      const code = readFileSync(path, 'utf8');
      return code.includes('https://demo.bobpro.fr') ? [relative(MOBILE_ROOT, path)] : [];
    });

    expect(leaks).toEqual([]);
  });

  it('Bob mobile ne peut pas réactiver un cerveau local de repli', () => {
    const bob = readFileSync(new URL('./bob.ts', import.meta.url), 'utf8');

    expect(bob).not.toMatch(/\b(?:BobAgent|ModelRouter|LocalBobClient)\b/u);
    expect(bob).toContain('client.askBob(');
    expect(bob).toContain('client.confirmBob(');
  });

  it('l authentification mobile ne possède aucun jeton statique de repli', () => {
    const auth = readFileSync(new URL('./supabase.ts', import.meta.url), 'utf8');

    expect(auth).not.toContain('EXPO_PUBLIC_API_TOKEN');
    expect(auth).not.toContain('SupabaseClient | null');
    expect(auth).toContain('supabase.auth.getSession()');
  });

  it('ne fabrique aucune identité propriétaire ou device lorsque la session manque', () => {
    const push = readFileSync(new URL('./push.tsx', import.meta.url), 'utf8');
    const tenantIdentity = readFileSync(new URL('./tenant-identity.ts', import.meta.url), 'utf8');

    expect(push).not.toMatch(/local[-_]demo|authEnabled\s*\?/u);
    expect(tenantIdentity).not.toMatch(/configuredDemo|static tenant/iu);
  });

  it('le brouillon de devis de production dépend uniquement du slot HTTP authentifié', () => {
    const provider = readFileSync(
      new URL('../quote-draft/quote-draft-provider.tsx', import.meta.url),
      'utf8',
    );
    const runtimeBarrel = readFileSync(
      new URL('../quote-draft/index.ts', import.meta.url),
      'utf8',
    );

    expect(provider).toContain('createQuoteDraftRemotePersistence');
    expect(provider).toContain('registerBeforeSignOutCleanup');
    expect(provider).toContain('disposeQuoteDraftSession');
    expect(provider).not.toMatch(/registerBeforeSignOutCleanup\([^)]*persistence\.clear/su);
    expect(provider).toContain("{ ready: false, status: 'error', error: 'load' }");
    expect(provider).not.toMatch(/SecureStore|createSecureQuoteDraftPersistence|quote-draft-store/iu);
    expect(provider).not.toMatch(/\bdemo\b|local-demo|QuoteDraftStorageIdentity/iu);
    expect(runtimeBarrel).not.toMatch(/quote-draft-codec|quote-draft-store|secure-store/iu);
    for (const obsoleteLocalPersistence of [
      '../quote-draft/quote-draft-codec.ts',
      '../quote-draft/quote-draft-store.ts',
      '../quote-draft/quote-draft-secure-store.ts',
    ]) {
      expect(existsSync(new URL(obsoleteLocalPersistence, import.meta.url))).toBe(false);
    }
  });

  it('le diagnostic consomme les encaissements persistés et aucun compteur de questions fictif', () => {
    const diagnostic = readFileSync(new URL('../../app/diagnostic.tsx', import.meta.url), 'utf8');

    expect(diagnostic).toContain('const paymentsQ = usePayments()');
    expect(diagnostic).toContain('paymentsQ.data.map');
    expect(diagnostic).not.toMatch(/questions\.length\s*:\s*3/u);
    expect(diagnostic).not.toMatch(/amountCents:\s*i\.paid/u);
  });
});
