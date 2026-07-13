# SPEC — BOB LIVE (mandat fondateur 2026-07-13, autonomie totale Claude+GPT)

**But** : fluidité de classe majeure — ChatGPT Live / Gemini Live / Claude vocal. Voix-à-voix
naturel, interruption à la parole, latence mesurée et pilotée. Validation fondateur À LA FIN.

## Cibles chiffrées (DoD globale)
| Métrique | p50 | p95 |
|---|---|---|
| Voix→voix (fin de parole → 1er audio Bob) | ≤ 900 ms | ≤ 1 800 ms |
| Interruption (parole user → silence Bob) | ≤ 250 ms | ≤ 500 ms |
| Faux barge-in (écho pris pour parole) | 0 toléré (plancher) | — |
| Exécution fantôme | 0 — invariant testé | — |

Instrumentation OBLIGATOIRE dès la phase 1 : chaque tour émet une `VoiceLatencyTrace`
(sttFinalAt, askSentAt, firstTokenAt, sayStartAt, sayFirstAudioAt, interruptedAt?) agrégée
en p50/p95, visible en dev (pilule) et journalisée serveur (metrics existantes aiDuration).

## Architecture cible (3 étages, dégradation honnête à chaque étage)
1. **Transport** : WebSocket `wss://…/voice/live` (Railway OK). Session authentifiée (JWT
   Supabase), 1 session = 1 mission vocale. Messages JSON typés :
   `client→srv : {type:'utterance', text, context, seq} | {type:'barge_in'} | {type:'end'}`
   `srv→client : {type:'token', text} | {type:'sentence', text} | {type:'run', run} | {type:'metrics', trace}`
   (v1 : STT reste ON-DEVICE — le texte part au serveur ; l'AUDIO streaming montant est la v2.)
2. **Cerveau streaming** : `askBob` gagne un mode flux — classification inchangée, mais la
   naturalisation/réponse est STREAMÉE par phrases (LlmPort.stream). Chaque phrase complète
   part en `sentence` → le client la parle immédiatement (chunked TTS) pendant que la suite
   se génère. Garde-fous INCHANGÉS : naturalizationViolations par phrase cumulée, consentement
   verbatim jamais streamé-modifié, montants vérifiés avant émission.
3. **Bouche/oreille** : TTS par phrases (file de lecture interruptible) ; barge-in par
   partiels ASR (echo-guard existant) + coupure de la file TTS ; AEC natif activé
   (audio session `voiceChat`/`echoCancellation` Android).

## Phases (livrables committables, chacun 100 % prod + testé)
- **P0 — Atterrissage** : commit unique client (vague 4 GPT + S2-GUIDÉ durci + ventes ultra),
  déblocage PONT-VOCAL serveur avec/après session A, déploiement staging+prod, QA device.
- **P1 — Primitives** (sans serveur) : `@bob/ai` `splitSpokenSentences` (chunker FR robuste,
  abréviations/nombres/« M. » gérés) + `VoiceLatencyTrace` (pure) + file TTS interruptible
  mobile (`useSpeak.speakQueue`) + métriques affichées en dev. Gain immédiat : Bob commence
  à parler dès la 1re phrase d'une réponse longue.
- **P2 — Gateway WS** : NestJS `VoiceLiveGateway` (`/voice/live`), auth+tenant, ask streaming
  par phrases (LlmPort.stream sur providers — Mistral supporte le stream), metrics serveur.
- **P3 — Client live** : la session mobile bascule sur WS quand dispo (fallback HTTP intact),
  lecture des `sentence` en file, barge-in → message `barge_in` (le serveur stoppe la génération).
- **P4 — Full-duplex** : écoute PENDANT la parole par défaut (echo-guard + AEC), reprise
  de parole naturelle (« attends », chevauchement), latences p95 tenues sur device réel.
- **P5 — Audio montant streamé (v2)** : STT serveur temps réel (Voxtral streaming si dispo,
  sinon WebRTC/chunks) — seulement si les mesures P4 le justifient.

## Répartition (claims)
- **Claude** : P1 primitives @bob/ai + file TTS mobile ; P2 gateway serveur ; métriques ;
  extension machine core (propositions/diff S2 — réconciliation du concept QuoteDraft DANS core).
- **GPT** : P0 commit unique + re-review finale S2 ; P3 client WS mobile (sa lane
  session/transport après P2) ; wizards facture/client/catalogue sur la fondation affordances ;
  QA device systématique.
- Arbitrages croisés par contre-review adversariale (protocole actuel, qui marche).

## Invariants NON NÉGOCIABLES (hérités, re-testés à chaque phase)
Consentement zéro-token verbatim ; montants jamais inventés/déformés (guard par phrase) ;
contexte = indice jamais autorisation ; navigation allowlistée ; parité voix↔manuel ;
i18n ×3 humeurs ; dégradation honnête (WS→HTTP→local) ; jamais de disparition muette.
