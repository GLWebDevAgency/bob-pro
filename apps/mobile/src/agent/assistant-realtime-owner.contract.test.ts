import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MOBILE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP_ROOT = fileURLToPath(new URL('../../app/', import.meta.url));
const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));
const assistant = readFileSync(new URL('../../app/(tabs)/assistant.tsx', import.meta.url), 'utf8');
const globalAccess = readFileSync(
  new URL('../components/GlobalBobAccess.tsx', import.meta.url),
  'utf8',
);
const rootLayout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');
const agentSession = readFileSync(new URL('./agent-session.tsx', import.meta.url), 'utf8');

function runtimeSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) return runtimeSources(path);
    if (!entry.isFile() || !['.ts', '.tsx'].includes(extname(entry.name))) return [];
    if (/\.(?:test|spec)\.[^.]+$/u.test(entry.name)) return [];
    return [path];
  });
}

const AUDIO_HOOK_IMPORT =
  /import\s*\{[^}]*\b(?:useVoiceInput|useSpeak)\b[^}]*\}\s*from\s*['"][^'"]*data\/voice['"]/su;

describe('Bob Live mobile — propriétaire Realtime unique', () => {
  it('le provider racine enveloppe les deux surfaces qui consomment la même session', () => {
    expect(rootLayout.match(/<AgentSessionProvider>/gu)).toHaveLength(1);
    expect(rootLayout.match(/<\/AgentSessionProvider>/gu)).toHaveLength(1);
    expect(rootLayout).toContain('<GlobalBobAccess />');
    expect(globalAccess).toContain('const session = useAgentSession()');
    expect(assistant).toContain('const globalSession = useAgentSession()');
    expect(assistant).toContain('globalSession.toggle()');
  });

  it('l Assistant ne possède plus de moteur audio, de boucle de silence ni de teardown au blur', () => {
    expect(assistant).not.toMatch(/\buseVoiceInput\b|\buseSpeak\b/u);
    expect(assistant).not.toContain('/data/voice');
    expect(assistant).not.toContain('/assistant/live-silence');
    expect(assistant).not.toMatch(/\bliveRef\b|\bvoiceRef\b|\bstopSpeaking\b/u);
    expect(assistant).not.toMatch(/return\s*\(\)\s*=>\s*globalSession\.stop/u);
  });

  it('un seul module de production importe les hooks micro et bouche : AgentSessionProvider', () => {
    const sources = [...runtimeSources(APP_ROOT), ...runtimeSources(SRC_ROOT)];
    // Témoin anti-test-vert-à-vide : le scan doit couvrir une vraie application Expo.
    expect(sources.length).toBeGreaterThan(100);
    const owners = sources
      .filter((path) => AUDIO_HOOK_IMPORT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(MOBILE_ROOT, path))
      .sort();
    expect(owners).toEqual(['src/agent/agent-session.tsx']);
  });

  it('le chrome Assistant rend la réponse terminale et son action de fermeture', () => {
    expect(assistant).toContain('responseAlreadyInConversation');
    expect(assistant).toContain(
      'accessibilityLabel={assistantVoiceErrorMessage ?? displayedLiveCopy}',
    );
    expect(assistant).toContain('displayedLive ? globalSession.stop : globalSession.dismissResponse');
    expect(assistant).toContain("displayedLive ? 'agent.global.stop' : 'agent.global.dismiss'");
    expect(assistant).toContain("name={displayedLive ? 'stop' : 'pulse'}");
    expect(assistant).toContain('globalSession.conversation');
    expect(assistant).toContain('globalSession.reviewRequired');
    expect(assistant).toContain('globalSession.requestHandoff(handoff.id)');
  });

  it('l overlay transmet chaque arrêt produit comme policy, jamais comme geste user', () => {
    expect(globalAccess).toContain('const { active: sessionActive, stopForPolicy } = session');
    expect(globalAccess).toContain('stopForPolicy(sessionStopReason)');
    expect(globalAccess).not.toContain('if (transition.shouldStop) stopSession()');
    expect(agentSession).toContain('realtimeRef.current?.stopForPolicy(policyReason)');
  });

  it('le droit Live est identique sur les deux surfaces et un cache en erreur ferme le micro', () => {
    expect(globalAccess).toContain("features.includes('voice_live')");
    expect(globalAccess).toContain('isGlobalBobSubscriptionVerified({');
    expect(globalAccess).not.toContain("features.includes('ai_assistant')");
  });

  it('les décisions historiques sont neutralisées pendant Live et chaque surface expose Stop', () => {
    expect(assistant).toContain('disabled={busy || displayedLive}');
    expect(assistant).toContain('visible={activeAsk !== null && !displayedLive}');
    expect(globalAccess).toContain("title={t('agent.global.stop', { personality })}");
    expect(globalAccess).toContain('onPress={session.stop}');
  });

  it('une consommation de handoff est un CAS et le fil Live expose des tours immuables', () => {
    expect(agentSession).toContain('consumeAgentSessionHandoff(handoffRef.current, id)');
    expect(agentSession).toContain('conversationEpoch');
    expect(agentSession).toContain('appendConversation({ role: \'user\', text })');
    expect(assistant).toContain('importedLiveTurnIdsRef');
    expect(assistant).toContain('planAssistantLiveTurnImport({');
    expect(agentSession).toContain('appendAgentConversationJournal(conversationRef.current, appended)');
    expect(agentSession).not.toContain('conversationRef.current = Object.freeze([])');
  });

  it('un prompt de navigation attend la fin de Live avant de se marquer consommé', () => {
    const liveGuard = assistant.indexOf('|| globalSession.active');
    const consumed = assistant.indexOf('submittedPrompt.current = raw');
    expect(liveGuard).toBeGreaterThanOrEqual(0);
    expect(consumed).toBeGreaterThan(liveGuard);
  });
});
