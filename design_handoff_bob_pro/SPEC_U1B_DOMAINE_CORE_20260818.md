# SPEC U1-b — Domaine core : vocabulaire JarvisRun, reducer racine et premières définitions

- **Date** : 2026-08-18 · **Auteur** : Claude (bâton fondateur) · **Méthode** : panel de conception
  3 architectes + juge (wf_41e7ef5e) — blueprint « delta-minimal » gagnant 37/40, enrichi des
  7 greffes du juge. Contre-lecture GPT attendue au retour, non bloquante.
- **Parents** : [SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md](SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md)
  §4.1/§4.3/§5.1/§5.3/§7.1 · [SPEC_U1_NOYAU_DURABLE_20260818.md](SPEC_U1_NOYAU_DURABLE_20260818.md) (stockage U1-a).
- **Périmètre** : `packages/core` uniquement — aucun changement de persistence, gateway ou HTTP
  (U1-c). `agent-mission.ts` et `agent-mission-event.ts` ne sont PAS modifiés (writer N-1 intact).

## 1. Thèse

Le vocabulaire JarvisRun se pose **par composition** dans `domain/agent/` : les unions §5.1
étendent les constantes AgentMission existantes (`AGENT_MISSION_KIND` l.16,
`AGENT_MISSION_STATUSES` l.29) — jamais un second agrégat ni un second journal. `JarvisRun` n'est
pas une classe : c'est une **enveloppe** dont la branche `quote_creation` est une projection pure
de l'`AgentMissionSnapshot` existant (`createdBy = ownerUserId`, `definitionVersion =
protocolVersion`, `state = payload` — le mapping U1-a §2). `reduceJarvisRun(run, command)` est
l'unique entrée de réduction (§4.3) ; les définitions sont des branches pures enregistrées dans un
**registre gelé** `DEFINITIONS[kind][definitionVersion]` (greffe reducer-racine) — l'inconnu part
en quarantaine §5.5, jamais en comportement par défaut.

## 2. Modules livrés

| Fichier | Rôle |
|---|---|
| `domain/agent/jarvis-run.ts` | Unions §5.1 (kinds, 11 statuts + union persistée avec `expired` legacy = 12, miroir du CHECK U1-a), ensembles terminaux et libérant-la-lease, enveloppe + projection depuis snapshot, `projectQuoteMissionJarvisStatus(status, phase)` — **grille 3×9 totale snapshot-testée** (greffe continuité : oracle unique de la projection cutover §17), wakes (`wakeId` stable, `deriveNextWakeAt` = min pur) |
| `domain/agent/jarvis-work-item.ts` | Domaine §5.3 : 9 statuts (miroir CHECK U1-a), union fermée `JarvisAuthorizationSource` (parse exact-keys), `JarvisWorkItemIntent` émis par le reducer — **miroir 1:1 des colonnes `jarvis_work_items`** (greffe continuité : l'admission U1-c ne fait que mapper) ; jamais lease/fence (worker U1-c) |
| `domain/agent/jarvis-run-reducer.ts` | `JarvisRunCommand` union fermée, registre gelé des définitions, `reduceJarvisRun` exhaustif ; branche `quote_creation` **délègue** à l'agrégat (cancel/expire — mêmes postimages, mêmes événements) et rend `legacy_route_active` pour les commandes interactives (code de migration daté, complétion au manifeste de cutover §17.1) ; `definition_version_unknown` → quarantaine |
| `domain/agent/definitions/single-business-action-v1.ts` | §4.3 : une action cataloguée pincée `actionId@version`, ≤ 1 effet mutant, phases fermées, cycle de confirmation §7.1 complet, **cancel après autorisation → `cancelling` qui OBSERVE** (greffe : jamais prétendre annulé un effet possiblement parti, §5.3) |
| `domain/agent/definitions/customer-contact-v1.ts` | Transitions **réelles** création/modification client (§9.1, `client-creer@1`/`client-modifier@1`) : résolution de cible, doublons bornés sans fusion (FD-06), proposition digestée, invalidation stale (TVA/facturation/adresse/destinataire), un seul `effectId`, reçu idempotent |

Types quote dérivés par `Parameters<…>` des signatures de l'agrégat (greffe : zéro copie de forme,
co-évolution forcée à la compilation).

## 3. Invariants prouvés (gate de merge)

1. **SQL ↔ domaine synchrones** : test `apps/api` qui lit les blocs `GENERATED` de la migration
   U1-a et les compare aux constantes `@bob/core` — le CHECK élargi a une source unique (§4.4).
2. **Un seul moteur** : `cancel` via `reduceJarvisRun` ≡ `AgentMission.cancel` direct (postimage
   et événement identiques) ; aucune logique quote dupliquée.
3. **Writer N-1 intact** : `agent-mission.ts`/`agent-mission-event.ts` non modifiés, suites
   existantes vertes telles quelles.
4. **≤ 1 effet mutant par run** (property test sur séquences arbitraires de commandes).
5. **Confirmation one-shot §7.1** : replay même commandId ; conflit autre commandId sur
   `consumed` ; invalidation jamais rétroactive ; cycle fermé.
6. **Stale §9.1** : mutation d'un champ sensible entre présentation et confirm ⇒ `invalidated`.
7. **Projection totale** : grille 3×9 snapshot-testée, `expired → failed_terminal`,
   `awaiting_quote_screen → waiting_screen` ; les nouvelles définitions n'émettent jamais
   `expired` ; terminal ⇒ `terminalAt` posé, plus aucune transition.
8. **Pureté structurelle** : test interdisant aux modules `definitions/` tout import de
   ports/repositories/horloge ambiante (greffe) + unicité de `reduceJarvisRun`.

## 4. Non-objectifs de la tranche

Persistence/admission (U1-c étend `PrismaAgentMissionUnitOfWork`), gateway HTTP/realtime,
worker de dispatch des work items, contacts CRUD (`customer_contact@2`), absorption des 25
commandes interactives quote (manifeste de cutover §17.1), tout renommage.
