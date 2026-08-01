/**
 * LA GARDE QUI MAINTIENT MISTRAL STRICTEMENT EN V1 (train M2-A-3).
 *
 * L'ordre du handoff est binaire : « Raccorder OpenAI WebRTC SEULEMENT au protocole 2 ;
 * laisser Mistral V1. » La séparation vit dans la négociation serveur (une fabrique par
 * transport) et dans les bootstraps Mistral qui épinglent la constante V1. Leurs tests de
 * wire l'assertent déjà par LITTÉRAL 1 (mistral-realtime-transport.test.ts,
 * mistral-conversation-runtime.test.ts) — un mutant qui pousserait la constante partagée
 * vers 2 y meurt.
 *
 * Ce fichier verrouille la moitié restante : qu'AUCUN module Mistral n'importe jamais la
 * constante M2-A. Le jour où un import `REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION`
 * apparaît sous `src/realtime/mistral-*`, la dérive est structurelle (un transport Mistral
 * qui « connaît » V2), et elle doit rougir ICI, avant tout comportement.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const realtimeDir = fileURLToPath(new URL('.', import.meta.url));

function mistralSources(): readonly { name: string; content: string }[] {
  return readdirSync(realtimeDir)
    .filter((name) => name.startsWith('mistral-'))
    .filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.includes('.test.'))
    .sort()
    .map((name) => ({
      name,
      content: readFileSync(join(realtimeDir, name), 'utf8'),
    }));
}

describe('Mistral reste un client Mission V1 — jamais la constante M2-A', () => {
  it('aucune source mistral-* ne mentionne REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION', () => {
    const sources = mistralSources();
    // Témoin d'observation : si le glob ne voyait plus rien, la garde serait verte à vide.
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const source of sources) {
      expect(
        source.content.includes('REALTIME_AGENT_MISSION_PROTOCOL_M2A_VERSION'),
        `${source.name} importe ou mentionne la constante M2-A — Mistral doit rester V1`,
      ).toBe(false);
    }
  });

  it('les deux bootstraps Mistral épinglent la constante V1 — le témoin que la garde regarde les bons fichiers', () => {
    const sources = mistralSources();
    const pinned = sources.filter((source) =>
      source.content.includes('agentMissionProtocolVersion: REALTIME_AGENT_MISSION_PROTOCOL_VERSION'));
    expect(
      pinned.map((source) => source.name),
      'les bootstraps mistral-realtime-transport et mistral-conversation-runtime doivent épingler la constante V1',
    ).toEqual([
      'mistral-conversation-runtime.ts',
      'mistral-realtime-transport.ts',
    ]);
  });
});
