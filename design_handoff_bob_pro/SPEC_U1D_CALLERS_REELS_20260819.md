# SPEC U1-d — Les callers réels : voix, tap, écran — le premier parcours visible

- **Date** : 2026-08-19 · **Auteur** : Claude (bâton fondateur) · **Méthode** : panel + juge
  (wf_e68b4e97) — ossature « voix-realtime » (12 citations vérifiées), **6 greffes intégrées**,
  arbitrage `commandId` tranché par le juge contre le code réel. Le 3ᵉ blueprint (preuves) n'est
  jamais arrivé (prompt tronqué) : la matrice §5 est composée par le lead. Contre-lecture GPT
  attendue, non bloquante.
- **Parents** : spec Jarvis §5.4/§7.0/§7.1/§14/§19.3-19.4 · SPEC_U1C (port d'admission).
- **Périmètre** : le vertical `customer_contact@1` de bout en bout — voix, tap, écran de
  confirmation, exécuteur d'effet réel — **candidates techniques uniquement : `client-creer@1`,
  `client-modifier@1`** (source unique G2, jamais une publication). Flags par défaut **OFF**.

## 1. Arbitrage `commandId` (juge, vérifié contre le code)

- **VOIX** : `commandId = turnId` (`deriveRealtimeTurnId`, v4-forme — passe le contrat
  `user=v4` d'agent-mission-event) — patron quote conservé : dérivé serveur AVANT tout appel
  LLM, stable aux replays (§5.4 « généré une fois, conservé jusqu'au reçu »), UNE admission
  user par tour.
- **TAP** : UUID v4 généré côté client UNE fois, mémoïsé par `AgentMissionCommandIdRegistry`
  jusqu'au reçu (§5.4 littéral). §19.3 admet un commandId par canal.
- **SYSTÈME** : `deriveJarvisSystemCommandId` (v8), inchangé.

## 2. Autorité par canal (greffe G1 — décisive)

`JarvisAdmissionAuthority` gagne un 3ᵉ membre fermé :
`{ source: 'authenticated_principal'; principalBindingHash }` — dérivé **serveur** du principal
authentifié (bearer), stampé pour l'audit. Le case in-tx est exhaustif (source inconnue ⇒
`capability_rejected`). Justification : la capability se résout contre une lease **vivante** ;
or §14 et le gate « `JarvisRun` park/reprend sans lease Realtime » exigent le tap au bearer seul
— après la mort de la session vocale, l'utilisateur continue à l'écran.

## 3. Ossature par sous-système

**VOIX** — `customer_contact@1` entre dans `MISSION_KIND_IDS` **atomiquement avec** son
adaptateur (sinon `missing_id` au boot) ; `CustomerContactSemanticFrameV1` (union fermée
d'intentions) ; planner étendu ADDITIVEMENT (frame émis seulement si le manifest annonce le kind
admis ; frames/prompts quote intacts, non-régression testée) ; `RealtimeJarvisMissionOrchestrator`
(prepare = `readJarvisStateless` ; runPlanned = frame → enveloppe → `runJarvisAdmission` →
speech fail-closed) derrière `CustomerContactMissionKindAdapter` (patron exact du quote) ;
`admittedMissionKinds` **dérivé de l'admission de session** (flag
`bob.agent_missions.customer_contact.v1` évalué PAR kind, variante de binding scopée kind —
jamais un élargissement des bindings quote), threadé par realtime.service — plus jamais codé en
dur ; `askBobWithPlan` reste le repli sans mutation, jamais producteur d'enveloppe Jarvis.

**TAP** — `JarvisModule` vertical (imports Observability+Persistence+AgentMission, AppModule ne
recopie rien) : `JarvisRunController` (`POST /jarvis/runs/:runId/commands`, `GET /jarvis/runs/:runId`),
`@Throttle` chiffré par route (POST 10/10 s, GET 30/10 s — patron AiController), corps exact 422,
`occurredAt`/`canonicalInputDigest` calculés **serveur** (stables par retry), mapping fermé
`JarvisAdmissionResult` → HTTP (G6). Autorité = `authenticated_principal`. `Disabled` fail-closed
flag OFF.

**MOBILE** — projection serveur `CustomerContactPresentationV1` : le state ne porte que des
digests ; les champs proposés vivent dans un **payload store PII** scellé par digest, écrit
idempotent AVANT `stage_proposal` (rétention/GC §5.5 dans la migration) ; au `GET` run, la
recomposition re-vérifie `fieldsDigest` (mismatch ⇒ présentation absente, fail-closed — G4).
Surface : réutilisation des composants existants (patron QuoteAgentMissionSurface/cartes
assistant), détails critiques vocalisables, `record_presentation_ack{screen_ack}` au rendu réel
puis `confirm` ; commandIds via `AgentMissionCommandIdRegistry` et actions fencées — **zéro
fork** ; `captureForQuoteScreen` reste pincé `/devis/new` (G3, refactor post-U1). `client-creer@1`
= M2+privacy_sensitive : `voice_presentation_ack` admis par la table §7.0, la surface écran
**toujours offerte** (§7.0 règles 2-3).

**HMAC/DEPS** — adapter `JARVIS_ADMISSION` liant le port mono-argument → persistence(envelope,
deps) : `fingerprints` = le signeur quote **exporté** (keyring unique, jamais re-déclaré, dégate
sur quoteV1 OU customerContactV1), `canonicalizationVersion: 1`,
`admissionEnabled: BOB_JARVIS_ADMISSION_ENABLED`, `allowCertificationAuthority: false` en prod.
La même instance sert le dispatch.

**EXÉCUTEUR D'EFFET** — `client-creer@1`/`client-modifier@1` branchés sur le **use case customer
canonique** (createCustomer/updateCustomer + coordinateur idempotent par `effectId` — la clé
opaque exigée par §15 pré-U1) : le registre du worker cesse d'être vide pour CES deux actions ;
tout le reste demeure `executor_unregistered` fail-closed.

## 4. Bornes d'ouverture (greffe G2)

`packages/core/src/domain/action-catalog/rollout.ts` : `U1_CANDIDATE_ACTIONS =
{'client-creer@1','client-modifier@1'}` + helper fail-closed — inventaire technique, jamais
policy, permission, disponibilité produit ni publication. Les frontières mutantes consomment
l'unique autorité de publication profonde.

## 5. Preuves de la tranche (composées par le lead — §19.2/19.3/19.4)

1. **Postgres (extension des suites U1-c)** : admission par `authenticated_principal` (hash
   stampé, source inconnue refusée) ; payload store PII (écrit avant stage, digest vérifié,
   mismatch fail-closed, GC rétention) ; exécuteur réel — même `effectId` ⇒ même `customerId`
   (idempotence du coordinateur), crash worker entre effet et signal ⇒ redélivrance sans doublon.
2. **Oracles voix/tap (§19.3, vitest+postgres)** : le MÊME run avancé par une enveloppe voix
   (turnId) puis une enveloppe tap (UUID client) — mêmes postimages, mêmes reçus normalisés ;
   la voix jamais plus permissive.
3. **Double appareil (G5)** : deux UUID v4 distincts, même `expectedRevision` ⇒ un seul
   `admitted`, le perdant `stale_revision`/`command_conflict` et se rafraîchit ; oracle =
   relecture DB/API, jamais l'écran.
4. **Crash/replay** : kill mi-transaction ⇒ zéro ligne ; même commandId ⇒ `replayed`.
5. **E2E staging** (serveur réel + modèle staging) : parcours §19.4 n°1 — créer puis modifier
   client, mutation d'email entre proposition et confirm ⇒ `invalidated`, nouvelle proposition.
6. **Device (§19.5)** : plan SANS build EAS (règle fondateur) — Expo Go/dev-client existant sur
   simulateur + device du fondateur à son GO ; la preuve device formelle est un gate de
   `certified`, pas de cette PR.

## 6. Non-objectifs

Contacts CRUD (`customer_contact@2`), autres actions du catalogue, mandats, généralisation de
`captureForQuoteScreen`, activation des flags (OFF par défaut — l'ouverture staging suit la loi
des environnements), tout renommage.
