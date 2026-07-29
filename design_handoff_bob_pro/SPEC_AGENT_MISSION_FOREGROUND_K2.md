# O4 — K2 OWNERSHIP EXCLUSIF ET FOREGROUND GLOBAL DES MISSIONS

Statut : `implemented` — certification locale PostgreSQL réelle verte, certification staging due
Date : 29/07/2026
Objectif canonique : O4 — mission continue / Bob Jarvis
Prérequis livré : `MissionKind` K1, PR #26, `main@c1fd88de`

## 1. Pourquoi

K1 a rendu `quote_creation@1` appelable depuis un registre fermé sans modifier M1-C. Deux
autorités restent toutefois locales au devis :

- le verrou et l'index SQL sont aujourd'hui uniques par `(company, owner, kind)` ;
- le cerveau historique peut encore reconnaître `nouveau_devis` après qu'une session Realtime a
  négocié la mission devis.

Ajouter un deuxième kind dans cet état permettrait deux missions actives et deux propriétaires
effectifs d'une même intention. K2 ferme ces deux chemins avant toute extension équipements,
interventions ou contrats.

## 2. Résultat produit

Pour un utilisateur et une société :

1. au plus une mission durable est active, quel que soit son kind ;
2. une session admise avec `quote_creation@1` confie exclusivement `nouveau_devis` à cette
   mission ;
3. si la compréhension MissionKind s'abstient mais que le cerveau historique reconnaît ensuite
   `nouveau_devis`, le tour échoue fermé avant navigation, proposition, journal ou mutation ;
4. sans capabilité MissionKind, le parcours historique reste disponible pendant le drainage
   N-1 ;
5. tous les autres outils restent explicitement `legacy` dans cette tranche. Ils constituent une
   surface de transition, pas un second framework ;
6. `MissionKind` est l'unique système cible à maintenir : les capacités existantes sont absorbées
   kind par kind sans réécrire leurs use cases. Tout packaging externe reste hors périmètre et
   postérieur à la publication de Bob.

## 3. Périmètre

### Inclus

- registre exhaustif `BobIntent → IntentOwnership` vérifié par TypeScript ;
- contrat exhaustif de chaque outil runtime vers son intention de restitution et ses intentions
  d'autorité, vérifié à la compilation et contre le registre réellement construit ;
- résolution effective de l'owner selon les kinds admis pour la session ;
- blocage du plan legacy avant tout handler si une de ses étapes appartient à un kind admis ;
- revalidation de l'ownership à la frontière réelle de toute exécution
  (`confirm`, `dryRun`, `runJournaled` et `/ai/confirm`) ;
- policy d'ownership versionnée et scellée dans toute proposition serveur opaque ;
- transmission de cette politique par le transport Realtime authentifié, jamais par le payload
  utilisateur ;
- repository de foreground actif sans filtre de kind ;
- index partiel unique global `(companyId, ownerUserId) WHERE status = 'active'` ;
- double verrou du writer N :
  `owner-foreground-v2 → owner-kind-v1/quote_creation` ;
- même double verrou dans le fence des mutations manuelles du brouillon ;
- compatibilité réelle du writer N-1, RLS forcée et déployeur non-superuser ;
- erreurs déterministes, sans exposition d'une erreur Prisma/SQL brute.

### Exclus

- nouveau kind persistant ;
- nouveau payload, phase, événement, fingerprint, seal ou route ;
- modification du wire M1-C, du mobile ou de l'API client ;
- orchestration de deux kinds dans une même phrase ;
- suppression de l'ancien index ou de l'ancien verrou ;
- migration d'un outil équipements/interventions/contrats ;
- activation production d'un nouveau comportement métier.

Les routes REST finales `POST /quotes` et `POST /quotes/:id/duplicate` ne démarrent pas une
nouvelle mission dans K2. Elles restent des gestes métier existants, utilisés notamment après la
sortie terminale de la mission. Le brouillon qu'elles consomment reste protégé par le fence global
sur chaque sauvegarde/suppression. Le chemin Realtime `nouveau_devis`, lui, est bloqué avant le
plan legacy et ne peut donc plus atteindre ces routes en contournement.

## 4. Ownership des intentions

```ts
type IntentOwnership =
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'mission';
      readonly missionKind: MissionKindId;
      readonly legacyWhenNotAdmitted: true;
    }
  | {
      readonly kind: 'direct_capability';
      readonly capability: string;
    };
```

`INTENT_OWNERSHIP` utilise :

```ts
satisfies Readonly<Record<BobIntent, IntentOwnership>>
```

La table est donc cassée au compile-time dès qu'une intention est ajoutée sans décision
d'ownership. Dans K2 :

- `nouveau_devis` → `mission quote_creation@1`, avec repli legacy uniquement si le kind n'a pas
  été admis ;
- toutes les autres intentions → `legacy`.

Le type `direct_capability` est réservé à une migration ultérieure et ne permet pas de déclarer
comme migrée une lecture qui passe encore par `BobAgent`.

La politique effective est calculée côté serveur depuis l'autorité de session. Elle n'entre pas
dans `AgentAskPayload`. Le client et le modèle ne peuvent donc ni la réduire ni la fabriquer.

### Gardes avant effet

Après classification et avant `runSingle`, `runMulti`, résolution métier ou `dryRun`, `BobAgent`
compare toutes les étapes au jeu d'intentions bloquées par l'hôte :

- aucun blocage → exécution actuelle inchangée ;
- au moins une étape bloquée → conflit `agent_intent_ownership/mission_owned`, plan entier refusé ;
- aucune étape autorisée n'est exécutée partiellement ;
- aucun fallback déterministe ne contourne le garde.

Ce garde de plan n'est pas la frontière d'autorité finale. Une proposition opaque peut survivre
quelques minutes, une confirmation peut être appelée directement et les chemins `dryRun` /
`runJournaled` ne repassent pas par le classifieur. K2 impose donc un second garde, au plus près de
l'effet :

- chaque outil du registre runtime déclare un contrat exhaustif :
  `resultIntent` pour la restitution et `authorityIntents[]` pour la possession ;
- le nom de chaque outil réellement construit est contraint par cette table et un test de parité
  refuse tout outil absent ou toute entrée morte ;
- un outil inconnu sous policy d'ownership est refusé fermé ;
- avant un lot, toutes les invocations sont résolues et comparées aux intentions bloquées ;
- si une invocation est bloquée ou inconnue, le lot entier est refusé avant le premier
  `parse`, journal `planned` ou `run` ;
- la même policy est appliquée par `BobAgent.confirm`, `AgentRuntime` en dry-run et en live.

Les 42 spécifications du planner produisent actuellement 51 outils dans le registre runtime
réel — le compte exact est dérivé du code et gardé par un test de parité, jamais recopié comme une
constante produit. Ce registre reste l'unique surface d'exécution. Le contrat outil → intentions
n'est pas un deuxième registre métier : il rattache cette surface existante à l'unique autorité
`INTENT_OWNERSHIP`. Les fiches de passage et le parc d'équipements seront absorbés en changeant
l'ownership de leurs intentions dans la PR de leur futur kind, sans réimplémenter leurs use cases,
révisions, choix scellés, capacités ou journaux.

### Proposition opaque et confirmation

Toute proposition serveur persiste, dans son entrée owner-bound :

- la version de schéma de l'autorité d'exécution ;
- le SHA-256 du contrat canonique `INTENT_OWNERSHIP + RUNTIME_TOOL_INTENTS` ;
- le jeu canonique des `admittedMissionKinds` admis par l'autorité serveur de cette session ;
- pour chaque entrée planifiée, la liaison exacte `{ seq, tool, intent }`.

Les intentions bloquées ne sont pas persistées : elles sont toujours recalculées depuis ces kinds
et le contrat compilé courant. Aucun de ces champs ne vient du payload client. `preview` et
`/ai/confirm` relisent en outre un journal canonique : `N` entrées `planned` de séquences `1..N`,
puis exactement une entrée owner non mutante/non sortante en séquence `N+1`. Une proposition sans
preuve K2, avec clé supplémentaire, version/SHA inconnu, kind non canonique, liaison altérée,
séquence trouée ou owner ambigu est refusée comme obsolète et doit être régénérée.

À la confirmation, le serveur reconstruit l'agent avec l'autorité exacte de la session persistée et
`runJournaled` revalide atomiquement toutes les invocations avant de revendiquer ou exécuter le
lot. Une évolution sémantique de `INTENT_OWNERSHIP` ou du contrat d'un outil change
automatiquement le SHA et invalide les propositions antérieures après le drainage rolling défini
ci-dessous, plutôt que de leur conserver une ancienne autorité.

## 5. Foreground global

### Repository

Les lectures historiques kind-scoped sont conservées pour les consommateurs M1-C. Deux opérations
explicites découvrent le foreground global :

```ts
findActive(owner & { kind }): Promise<AgentMission | null>;
findForeground(owner): Promise<AgentMissionForeground | null>;
findActiveForUpdate(owner & { kind }): Promise<AgentMission | null>;
findForegroundForUpdate(owner): Promise<AgentMissionForeground | null>;
```

`AgentMissionForeground` est discriminé : un kind connu fournit l'agrégat typé ; un kind futur
fournit seulement ses `missionId` et `kind`. Un binaire K2 ne tente donc jamais de parser un payload
futur comme un devis et répond par un conflit structuré, fail-closed. Les use cases et transactions
restent typés devis dans K2.

Un replay idempotent relit aussi le foreground : le replay historique reste exact tant qu'aucune
autre mission ne possède l'owner, mais il est refusé sans mutation ni navigation dès qu'un autre
foreground est actif.

Toutes les lectures historiques devis par identifiant ou `commandId`, y compris les événements,
sont elles aussi kind-aware. Une ligne d'un kind futur rend uniquement
`unsupported_kind { missionId, kind }` à partir de ses colonnes minimales. K2 ne passe jamais son
payload ou son événement à un parseur devis, ne traite jamais son `commandId` comme neuf et
n'effectue aucun append de rattrapage.

### Index backstop

Migration additive :

```sql
CREATE UNIQUE INDEX agent_missions_one_active_owner_key
  ON public.agent_missions ("companyId", "ownerUserId")
  WHERE "status" = 'active';
```

L'index historique `agent_missions_one_active_owner_kind_key` reste en place pour le binaire N-1.
Le CHECK courant n'autorise encore que `quote_creation` : l'ajout est donc compatible et toute
donnée existante valide satisfait déjà l'unicité globale.

Cette migration ne crée ni FK ni CHECK `NOT VALID`; une migration `VALIDATE` artificielle serait
mensongère. Le certificat PostgreSQL vérifie à la fois la définition catalogue de l'index et son
effet réel avec deux kinds dans une transaction de simulation contrôlée puis rollbackée.

## 6. Ordre de verrouillage

Writer mission N et fence manuel N :

```text
Company FOR SHARE
→ advisory bob.agent-mission.owner-foreground.v2/{company}/{owner}
→ advisory bob.agent-mission.owner-kind.v1/{company}/{owner}/quote_creation
→ advisory principal Bob Live
→ lease Realtime FOR UPDATE
→ mission
→ brouillon / agrégats métier
```

Writer N-1 :

```text
Company FOR SHARE
→ advisory owner-kind-v1/quote_creation
→ suite historique
```

Le writer N prend toujours l'ancien verrou après le nouveau : il se sérialise donc avec N-1.
L'ancien writer ne peut créer qu'un devis, et l'index global reste le backstop. Aucun chemin ne
prend les deux advisory locks dans l'ordre inverse.

## 7. Compatibilité de déploiement

| Schéma | Writer N-1 | Writer N | Attendu |
|---|---|---|---|
| avant K2 | oui | non | comportement M1-C actuel |
| index K2 appliqué | oui, verrou V1 | oui, V2 puis V1 | les deux fonctionnent, une seule mission |
| rollback applicatif N→N-1 | oui | drainé | ancien index + index global restent compatibles |
| futur kind | non concerné | V2 + verrou kind propre | bloqué tant que sa PR/certification n'existe pas |

La forme exacte N-1 est tentée après la migration sous les triggers finaux avec le rôle runtime.
La migration est exécutée par le déployeur non-superuser sous `SET ROLE bob_schema_owner`.

### Train d'activation sans autorité mixte

Le déploiement est obligatoirement en deux phases ; un changement de code et une activation de
capabilité simultanés sont interdits :

1. déployer schéma, double verrou, discriminants et preuve de proposition K2 sur toutes les
   répliques avec `BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED=false` et sans keyring AgentMission ;
2. prouver le SHA exact, l'absence de binaire N-1 et les lectures/écritures N-1 sous rôle
   non-superuser sur staging Supabase ;
3. attendre au minimum le TTL maximal des propositions opaques (10 minutes), puis confirmer
   qu'aucune proposition de l'ancien contrat n'est encore consommable ;
4. seulement ensuite, activer le bloc AgentMission complet selon M1-B
   (`flag + version HMAC + keyring`) et exécuter le smoke voix/tactile ;
5. tout rollback applicatif remet d'abord le flag à `false`, draine les leases et propositions,
   puis redéploie N-1. L'index global additif reste en place.

La topologie mono-réplique éventuellement observée sur Railway n'est jamais un invariant
d'architecture : la preuve doit rester vraie avec plusieurs répliques et l'autorité est portée par
PostgreSQL, pas par la mémoire du processus.

## 8. Critères d'acceptation binaires

- [x] Chaque `BobIntent` possède exactement une entrée dans `INTENT_OWNERSHIP`.
- [x] Chaque outil runtime construit possède exactement un contrat
      `{ resultIntent, authorityIntents }`, sans fallback `unknown`.
- [x] Une session sans kind admis conserve `nouveau_devis` en legacy.
- [x] Une session avec `quote_creation@1` rend `nouveau_devis` exclusivement MissionKind.
- [x] Un plan legacy simple ou composite contenant `nouveau_devis` est refusé avant tout handler.
- [x] `creer_devis`, et tout lot qui le contient, est refusé avant tout effet par `confirm`,
      `dryRun` et `runJournaled` lorsque `nouveau_devis` est MissionKind-owned.
- [x] Une proposition serveur persiste une policy d'ownership versionnée ; absente, invalide ou
      obsolète, elle ne peut être confirmée.
- [x] La preuve persistée contient exactement schéma, SHA, kinds admis et liaisons
      `{ seq, tool, intent }` ; toute clé, séquence ou owner supplémentaire est refusé.
- [x] `/ai/confirm` recharge et revalide cette policy avant de revendiquer ou exécuter le lot.
- [x] Le transport Realtime transmet la politique serveur au vrai `BackendService`.
- [x] Aucun payload client ne peut fournir ou réduire la politique d'ownership.
- [x] `findForeground` et `findForegroundForUpdate` découvrent le foreground sans filtre de kind,
      tandis que les lectures historiques `findActive*` restent kind-scoped.
- [x] Un kind futur est discriminé et refusé sans parser son payload comme `quote_creation@1`.
- [x] Un événement ou replay par ID d'un kind futur est discriminé avant tout parse devis et ne
      produit aucun append.
- [x] Un replay historique est refusé sans mutation si un autre foreground est actif.
- [x] Writer mission N et fence manuel N prennent V2 puis V1, après Company SHARE.
- [x] Aucun appel de lock V1→V2 n'existe.
- [x] L'index global partiel est présent sans retrait de l'index historique.
- [x] Deux starts concurrents produisent au plus une mission active et aucun SQL brut.
- [x] La forme N-1 passe après la migration sous RLS forcée/runtime non-superuser.
- [x] Un writer N-1 qui possède réellement le verrou V1 fait attendre le writer K2 V2→V1 ;
      après son commit, K2 converge vers le conflit de brouillon sans deuxième mission/event.
- [x] Une annulation SQL dans le callback transactionnel force un rollback réel après écriture ;
      `57014` et les formes timeout/expiration de Prisma `P2028` deviennent des indisponibilités
      bornées et réessayables, avec raison finie, métrique et log structuré sur les writers mission
      **et** manuel, sans exécuter le callback après expiration ni exposer l'erreur brute. Les
      autres erreurs `P2028` restent des pannes et ne sont pas maquillées en contention.
- [x] Une simulation de deux kinds prouve que le second actif reçoit `unique_violation`.
- [x] Les Data API roles Supabase n'obtiennent aucun nouveau droit.
- [x] Tous les résultats M1-C existants restent inchangés.

## 9. Definition of Done

- [x] spec et objectif canonique mis à jour avant code ;
- [x] tests purs ownership + contrat outils + anti-fallback aux frontières d'exécution ;
- [x] tests core des repository/UoW mémoire ;
- [x] tests API de wiring Realtime → Backend ;
- [x] tests Prisma ciblés et certification PostgreSQL 17 réelle ;
- [x] garde de migration et writer N-1 ;
- [x] typecheck, lint, tests et builds core/AI/API verts ;
- [x] `git diff --check` et garde d'artefact verts ;
- [x] review adversariale indépendante sans P0/P1 ;
- [ ] CI exacte verte ;
- [ ] déploiement phase A et certification sous rôle non-superuser sur staging Supabase ;
- [ ] drainage TTL, activation phase B bornée puis retour OFF certifié ;
- [ ] PR unique fusionnée avant K3.

K2 atteint au mieux `implemented` après merge. L'objectif O4 reste à certifier sur données réelles
et appareil : voix, toucher, kill/reprise et conflit multi-appareil.
