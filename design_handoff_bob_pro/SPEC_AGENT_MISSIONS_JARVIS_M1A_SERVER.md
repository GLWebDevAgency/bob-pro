# SPEC — Agent Missions Jarvis M1-A : autorité serveur `start/get`

**Statut** : `specified`.

**Instruction de travail** : continuité Jarvis demandée par le fondateur dans le canal Codex,
26 juillet 2026. Cette trace autorise le lot technique décrit ici mais ne s'auto-transforme pas
en décision de gouvernance. Cette tranche ne modifie ni la matrice des flags ni leur état ; une
telle modification exige une décision datée et contre-signée Claude + GPT prévue par `AGENTS.md`.

**Objectifs servis** : `O4` (mission continue), `O6` (données réelles) et `O7` (release
reproductible).

**Spécification parente** :
[SPEC_AGENT_MISSIONS_JARVIS.md](SPEC_AGENT_MISSIONS_JARVIS.md).

## 1. Résultat attendu

Le domaine pur `AgentMission` existe déjà mais n'est ni exporté, ni persisté, ni appelé par le
runtime. M1-A doit rendre le début d'une mission devis durable et relisible, sans activer le
parcours vocal public :

```text
identité JWT réelle
  → start devis idempotent
  → lecture/verrou du vrai QuoteDraftSlot
  → mission + brouillon éventuel + event dans UNE transaction
  → GET courant owner/tenant-scopé
```

Le lot s'arrête avant la négociation Realtime, l'ACK d'écran, la recherche client et le mobile.
Il ne revendique donc pas la Definition of Done M1.

## 2. Périmètre

### Inclus

- export des agrégats `AgentMission` et `AgentMissionEvent` ;
- garde exacte de taille : payload mission ≤ 64 KiB, payload événement ≤ 32 KiB ;
- ports framework-free d'unité de travail, repository mission/event et horloge/idempotence ;
- use cases `StartQuoteAgentMission`, `GetActiveAgentMission` et
  `CancelQuoteAgentMission` ; ce dernier porte aussi le handoff manuel explicite ;
- tables `agent_missions` et `agent_mission_events`, migration expand-only, contraintes, index,
  FORCE RLS société + propriétaire, ACL PostgREST fermées et événement immuable ;
- adapter Prisma transactionnel utilisant le vrai `QuoteDraftSlot` et son CAS ;
- `POST /agent-missions/quote-creation/start` et
  `GET /agent-missions/current/quote-creation`, dérivant société/propriétaire de l'identité
  authentifiée ;
- autorité HTTP production `DisabledAgentMissionHttpAuthority` : après l'admission société courte
  standard, elle refuse avant validation métier, use case et tout SQL `agent_mission` tant que la
  future négociation de capability n'existe pas ; les tests positifs la remplacent explicitement ;
- hard fence PostgreSQL et fence applicative des `PUT`/`DELETE /quote-drafts/current` tant
  qu'une mission active possède le slot, y compris pour un writer N-1 ;
- replay exact de toute commande `start`, y compris une commande qui rejoint une mission déjà
  active : le premier join est une transition `mission_joined` durable, son retry reste lié à la
  mission d'origine même si elle est ensuite terminalisée, et n'en crée jamais une nouvelle ;
- démarrages concurrents convergeant vers une mission active ;
- expiration paresseuse de l'ancienne mission dans le même commit avant le nouveau start ;
- annulation ou handoff manuel terminalisant la mission et libérant son brouillon dans le même
  commit, sans modifier le contenu du brouillon ;
- certification PostgreSQL réelle avec rôle runtime non-superuser et preuve writer N-1 ;
- migration rejouée sur Supabase staging avant fusion.

### Exclus

- ajout ou activation de `BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED` ;
- modification de `MATRICE_FLAGS_V1.md` ou d'un environnement de publication ;
- négociation de capability dans la lease Realtime ;
- protocole non forgeable qui liera une requête HTTP à la capability négociée d'une lease ;
- ACK écran, recherche/résolution client, `turn_settled`, codec mobile ou UI ;
- scheduler expiration/purge et changement de provider vocal ;
- toute promesse publique de devis vocal complet.

Les endpoints restent fermés tant que la capability M1 n'est pas négociée par une future tranche.
Le JWT ou le release flag ne sont jamais traités comme une preuve de session. Le provider de
production refuse après l'admission société courte, mais avant validation métier, use case et SQL
`agent_mission`; le parseur JSON transport peut répondre 400/413 avant lui. Les tests positifs
substituent une autorité de test
explicite. Aucune route de production ne peut donc créer ou lire une mission dans M1-A.

**[BLOQUÉ FONDATEUR : keyring HMAC AgentMission de production, versions active/précédente et
destination de secrets approuvée]**. Tant que cet input n'est pas fourni et certifié, le port de
fingerprint production reste indisponible et l'autorité HTTP reste fermée.

## 3. Invariants

1. `companyId` et `ownerUserId` ne viennent jamais du body.
2. La transaction partage exactement le même client Prisma et les mêmes GUC RLS pour mission,
   événement et brouillon. Après acquisition du verrou owner+kind, l'instant métier unique est lu
   via `clock_timestamp()` PostgreSQL. `transaction_timestamp()` est interdit pour cet instant :
   une transaction concurrente peut commencer avant le détenteur du verrou et reprendre ensuite
   avec une horloge antérieure. Les timestamps techniques du slot peuvent rester transactionnels.
3. `mission_started(no_slot)` crée le brouillon vide, la mission révision 1 et l'événement
   séquence 1, ou rien.
4. Un brouillon significatif reste byte-for-byte inchangé et produit la décision typée de conflit.
5. Un brouillon non significatif est adopté sans réinitialisation de révision.
6. Tout `commandId` de `start` est consommé durablement. Le créateur produit `mission_started` ;
   une commande distincte arrivée pendant une mission active produit `mission_joined`, avance sa
   révision et prolonge son idle TTL sans dépasser le hard TTL. Le replay exact n'écrit rien,
   relit la mission d'origine même après annulation/expiration et ne peut donc jamais créer une
   nouvelle mission. M1-A ne prétend pas détecter un « contenu différent » puisque l'unique
   commande HTTP exacte `{commandId}` ne porte aucun autre fait sémantique.
7. Une mission/event dépassement de taille est rejetée avant SQL. L'application borne l'UTF-8 du
   JSON reçu ; PostgreSQL applique indépendamment le même plafond à sa représentation JSONB. La
   frontière effective est la plus stricte des deux, jamais une acceptation optimiste.
8. Les événements sont append-only ; le rôle runtime ne possède ni `DELETE`, ni `UPDATE`, ni
   `TRUNCATE`. Leur `retentionExpiresAt` est une date minimale d'éligibilité, jamais une autorité
   de purge indépendante. En M1-A le trigger interdit toute purge. Toute future tranche de purge
   devra supprimer journal + mission dans une transaction seulement lorsque la rétention de la
   mission est due et que tous ses événements le sont ; aucun reçu d'idempotence ne peut
   disparaître pendant que sa mission existe. La FK `ON DELETE RESTRICT` maintient l'ordre.
9. Les rôles Supabase `anon`, `authenticated` et `service_role` n'obtiennent aucun accès implicite.
10. `QuoteDraftSlot.agentMissionId` est un marqueur nullable additif avec FK composite vers
    mission/société/propriétaire. Un writer N-1 peut encore lire/écrire le slot quand ce marqueur
    est nul. Dès qu'une mission active le possède, un trigger refuse UPDATE/DELETE sans GUC local
    `app.current_agent_mission_id` exact ; DELETE d'un slot possédé reste interdit.
11. `GET` est strictement read-only et une autre identité reçoit `null`/`404` sans révélation.
12. Aucun transcript, nom client, email, téléphone, montant ou texte LLM n'entre dans mission,
    événement, log ou métrique.
13. `completed` est réservé à M2 et n'est pas persistable en M1-A : le CHECK SQL est généré depuis
    les états M1 réellement réhydratables (`active`, `cancelled`, `expired`).

## 4. API M1-A

```text
POST /agent-missions/quote-creation/start
  body { commandId }
  acteur M1-A : user_tap sans tuple Realtime
  autorité M1-A production : toujours refusée avant validation métier/SQL mission
  réponse future autorisée : 201 si créée, 200 si join/replay

GET /agent-missions/current/quote-creation
  body absent
  autorité M1-A production : toujours refusée avant SQL mission

POST /agent-missions/:missionId/cancel
  body { commandId, expectedMissionRevision }
  raison serveur : user_cancelled
  acteur M1-A : user_tap sans tuple Realtime
  autorité M1-A production : toujours refusée avant validation métier/SQL mission
```

Les bodies sont exacts. UUID non canonique, clé inconnue, capability absente, autorité DB
indisponible ou configuration partielle échouent fermés. Le `GET` ne terminalise jamais une
mission expirée. Une future capability request-bound non forgeable remplacera le provider
disabled ; aucun header/session libre fourni par le client n'est préfiguré ici.

## 5. Migration et release

- Chaque migration commence par des `SET LOCAL` bornés.
- Les listes de valeurs des CHECK sont générées depuis les constantes TypeScript du domaine et un
  test anti-drift compare la migration committée à la sortie du générateur.
- Une contrainte ajoutée `NOT VALID` n'est jamais validée dans la même migration.
- La certification locale utilise un déployeur non-superuser distinct du propriétaire des objets.
  Le propriétaire NOLOGIN est créé par le déployeur avec
  `createrole_self_grant='set'`; après transfert, toute DDL/ACL s'exécute sous `SET ROLE`
  propriétaire. Le runtime reste non-superuser, non-owner et sans `BYPASSRLS`.
- Le script de release est modifié seulement après intégration séquentielle du travail Claude déjà
  présent sur ce fichier. Aucun contournement ni écrasement n'est autorisé.
- Ordre obligatoire : PR → Supabase staging certifié → fusion → production. Cette tranche ne
  déclenche aucune production tant que l'ensemble M1 n'est pas activable et certifié.

## 6. Critères d'acceptation binaires

- [ ] Le domaine mission est exporté et les gardes 64/32 KiB ont des tests de borne.
- [ ] `start` sans slot commit mission + draft + event ou rollbacke les trois.
- [ ] `start` avec slot significatif ne modifie pas le slot et présente le conflit réel.
- [ ] Deux starts concurrents produisent une mission active, un événement initial et un join
      durable pour la commande concurrente.
- [ ] Le replay exact de tout `commandId` start n'ajoute aucune écriture et reste lié à la mission
      d'origine après sa terminalisation ; aucune garantie d'`idempotency_conflict` sans contenu
      sémantique différent n'est annoncée par M1-A.
- [ ] `GET` ne voit que l'identité société/propriétaire courante et n'écrit rien.
- [ ] PUT/DELETE legacy N et N-1 du brouillon sont refusés par PostgreSQL si une mission active
      possède le slot ; sans mission, le writer N-1 continue de fonctionner.
- [ ] Une mission active expirée est terminalisée une fois sous verrou avant le nouveau start.
- [ ] Annulation et handoff manuel terminalisent la mission, conservent le payload du brouillon
      byte-for-byte et libèrent `agentMissionId` dans la même transaction ; une faute rollbacke
      les trois effets.
- [ ] RLS, ACL, immutabilité, CAS, rollback et writer N-1 passent sur PostgreSQL réel avec les rôles
      de production simulés.
- [ ] Les endpoints sont réellement composés ; pour un JSON transport valide, l'autorité
      production M1-A refuse après l'admission société courte et avant validation métier/SQL
      mission ; `@WithoutTenantPersistenceTransaction()` empêche toute transaction HTTP externe
      d'englober l'UoW owner,
      et le test AppModule prouve zéro requête mission quand elle refuse.
- [ ] Aucun flag, texte marketing, mock ou donnée de démonstration n'est ajouté au runtime.
- [ ] La migration et le certificat sont rejoués avec succès sur Supabase staging.

## 7. Definition of Done M1-A

- [ ] Tests ciblés core/API/Prisma/PostgreSQL verts.
- [ ] Typecheck et lint des packages touchés verts.
- [ ] Build API + garde d'artefact verts depuis un checkout propre du commit candidat.
- [ ] Review adversariale correctness/sécurité, architecture/parité et release Supabase terminée ;
      tous les P0/P1 sont corrigés.
- [ ] Une seule PR, CI complète verte, validation staging consignée, fusion dans `main`, branche et
      worktree supprimés.
- [ ] Le registre O4 indique seulement `implemented partiellement`; aucune case M1 complète ou
      `certified` n'est cochée.
