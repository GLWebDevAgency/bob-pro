# SPEC — Stabilisation et accélération de la certification M1-B staging

**Date :** 2026-07-28
**Statut :** `implemented`
**Objectifs servis :** O4 — mission continue ; O7 — release reproductible
**Autorité parente :** `OBJECTIFS_SPECS_DOD_PUBLICATION.md`
**Contrat raffiné :** `SPEC_AGENT_MISSIONS_JARVIS_M1B_CAPABILITY_ACK.md`, §8.1

## 1. Problème vérifié

Le run staging `30317301533` a échoué après 41 min 49 s :

- `Baseline OFF predeploy` : 18 min 20 s ;
- déploiement Railway : 2 min 02 s ;
- `Baseline OFF postdeploy` : 18 min 31 s ;
- négociation WebRTC : échec après un bootstrap client borné à 12 s, alors que le serveur a
  terminé à 12,637 s avec une lease encore active.

Les deux appels à `release.sh` ont représenté 88 % du chemin critique. Le scénario nominal en
appelle six et peut dépasser deux heures. Ce script rejoue en outre des opérateurs Mistral,
archive, settlement, outbox et cabinet étrangers à la fenêtre M1-B, alors que §8.1 interdit à ce
lane de muter un autre protocole.

L'échec WebRTC est une réponse ambiguë après timeout : le client a initié la terminaison mais le
harness pouvait réessayer ou conclure sans preuve atomique que la lease exacte **et toutes les
leases du tenant technique** avaient disparu.

Le run `30328210635` a ensuite prouvé un second défaut d'intégration au SHA exact : après création
de la mission et du brouillon, `updateContext` persistait le SHA-256 canonique produit par
`prepareRealtimeContext`, mais notifiait le sideband et répondait au client avec une autre
empreinte interne incluant version et révision. Le sideband durable exigeant
`contextDigest === contextAppliedDigest`, l'application du contexte était impossible, la session
était fermée, l'ACK écran ne pouvait jamais aboutir et le cleanup perdait sa capability.

## 2. Résultat attendu

Une seule PR courte rend la certification M1-B :

1. résistante à un unique timeout réseau ambigu sans créer deux sessions ;
2. diagnostiquable sans donnée personnelle, token, SDP ou identifiant ;
3. limitée aux mutations M1-B ;
4. sensiblement plus courte sans retirer une preuve de sécurité ;
5. toujours terminée par l'état global OFF et zéro session, même après échec.

## 3. Périmètre

### Inclus

- classification centralisée du timeout local exact du bootstrap Bob Live ;
- reprise unique après réconciliation durable ;
- récupération explicite, optionnelle et staging-only d'un résidu appartenant au compte
  technique M1-B après perte de la capability de la tentative précédente ;
- preuve SQL atomique de zéro lease exacte et zéro lease tenant ;
- diagnostic par classes fermées ;
- gate de recertification staging ciblé M1-B, borné au SHA et à la base ;
- suppression des appels transitifs aux mutateurs de protocoles étrangers ;
- conservation des trois déploiements API OFF → actif → OFF et du cleanup `always()`.

### Hors périmètre

- modification de la deadline UX Bob Live de 12 s ;
- activation M1-B en production ;
- suppression SQL directe d'une mission ou d'un brouillon et récupération d'une donnée utilisateur ;
- évolution du protocole ou des fonctions métier de mission ;
- suppression d'une certification générale de release ;
- cache d'un reçu de sécurité ou confiance dans un simple cache GitHub.

## 4. Invariants

### 4.1 Reprise du bootstrap

- Deux `POST /voice/realtime/calls` au maximum.
- Le second POST n'est autorisé que si le premier résultat correspond **exactement** au timeout
  local `HttpBobClient` attendu.
- Avant le second POST : peer fermé, hangup idempotent demandé, puis un seul snapshot PostgreSQL
  prouve simultanément :
  - zéro lease pour le `sessionId` de la première tentative ;
  - zéro lease de toute version pour le tenant technique ;
  - zéro mission active ;
  - zéro brouillon de devis.
- La seconde tentative emploie obligatoirement un nouveau UUID et un nouveau peer.
- Aucun retry pour conflit, validation, authentification, autorisation, rate limit, indisponibilité,
  annulation externe, résultat invalide ou autre dépendance.
- Un second timeout, une preuve de nettoyage absente ou un identifiant/peer réutilisé échoue fermé.
- La classification d'un timeout ne constitue jamais, seule, une autorisation de retry.

### 4.2 Confidentialité et diagnostic

- Les erreurs publiées n'exposent qu'une classe appartenant à une allowlist fixe et le numéro de
  tentative.
- Aucun message serveur, `cause`, `reason`, `issues`, email, token, URL, SDP, user/company/session ID
  n'entre dans les logs ou artefacts.

### 4.3 Release staging

- Ce gate est une **recertification stricte d'un staging déjà migré**. Il refuse toute migration
  locale en attente, tout checksum divergent et tout train M1-A/M1-B incomplet ; il n'exécute ni
  `prisma migrate deploy`, ni réparation d'ACL/RLS.
- Avant chaque transition, il recalcule l'identité complète : project ref Supabase,
  `system_identifier`, OID et nom de base exacts, runtime non-superuser/sans `BYPASSRLS` et
  déployeur Supabase `postgres` **non-superuser** avec `BYPASSRLS`. Tout drift invalide le run
  avant mutation.
- Aucun reçu, artefact ou cache n'est une autorité de cleanup. L'ownership durable reste fondé sur
  le `github.run_id`, stable entre reruns ; `github.run_attempt` n'est qu'une métadonnée de preuve.
- Chaque phase ferme et draine la capacité avant le writer et les certificats. Le postdeploy ne
  rouvre Bob Live qu'en dernier.
- Après le drain, le certificat read-only de l'autorité globale de capacité prouve encore owner,
  RLS, ACL, triggers, fonctions et absence de membership runtime avant toute mutation de writer.
- Chaque connexion `psql` et chaque key manager sont bornés au niveau processus, avec un
  `PGCONNECT_TIMEOUT` explicite ; la deadline de drain ne dépend jamais d'un enfant bloqué.
- Les transitions ne mutent que capacité M1-B, flag/override M1-B et keyspace HMAC AgentMission.
  Aucun appel direct ou transitif ne stage/retire Mistral, archive, settlement, outbox ou cabinet.
- Les autorités globales étrangères (keyspaces conversation/identité, protocoles archive et
  settlement) sont snapshotées avant/après chaque gate et doivent rester identiques.
- L'ordre reste : baseline OFF → déploiement OFF → preuve négative → activation bornée →
  déploiement actif → preuve positive → suppression override/variables → déploiement OFF →
  preuve négative et zéro lease final.
- Le job de cleanup reste autonome, `always()`, `cancel-in-progress=false` et fail-closed. Il
  revalide toujours la base et l'ownership durable, ferme et nettoie l'état possédé et ne dépend
  jamais d'un output/cache pour exercer son autorité.
- Avant de retirer l'override et les variables M1-B, le cleanup relit sous RLS l'état du compte
  technique. Un état propre est un no-op ; l'unique résidu technique autorisé est récupéré via
  une capability neuve pendant que le runtime actif existe encore. Un refus de récupération rend
  le job rouge mais n'empêche jamais la remise OFF indépendante qui suit.
- Après toute tentative de cleanup dont la suppression du bloc Railway M1-B est prouvée, une voie
  indépendante et limitée à la capacité globale remet Bob Live dans l'état configuré. Elle est
  sans effet si la capacité est déjà active **et** que sa configuration exacte est certifiée,
  attend un éventuel drain puis le certificat fermé avant réouverture, ne déploie aucun binaire
  et ne lit ni ne mute le keyspace AgentMission. Si l'ownership du bloc Railway reste indéterminé,
  elle ne rouvre rien et le cleanup échoue fermé.
- Les trois déploiements publient le même SHA exact. La réutilisation d'un artefact ou digest n'est
  admise que si Railway permet de le rattacher et de le vérifier explicitement ; sinon chaque
  déploiement reconstruit le même checkout exact.

### 4.4 Récupération bornée du compte technique

- La récupération est désactivée par défaut et n'est sélectionnable que par le purpose explicite
  `m1b-staging-recovery` ; le chemin `production` ne l'accepte pas.
- Avant toute mutation, une preuve PostgreSQL sous le rôle runtime RLS certifie exactement :
  un seul résidu `quote_creation` encore stocké `active`, phase `awaiting_quote_screen`,
  révision 1, sans binding, un seul événement initial `mission_started/no_slot`, un seul brouillon
  vide lié à cette mission et zéro lease pour tout le tenant technique.
- La preuve et l'authentification portent toutes deux les identifiants versionnés du compte
  technique. Toute donnée significative, mission supplémentaire, événement supplémentaire,
  binding, révision différente ou lease restante fait échouer la récupération sans mutation.
- Le run de récupération est distinct de la certification : il active temporairement le même SHA,
  récupère le résidu, puis remet M1-B OFF et prouve le compte propre. La certification suivante
  conserve intégralement son ordre normatif et ses preuves `clean` OFF → actif → OFF.
- Le même préflight HMAC anti-rotation précède l'activation en certification comme en récupération :
  une récupération ne peut ni élargir ni retirer silencieusement le writer floor.
- Après activation et création d'une nouvelle session WebRTC réelle, le client relit la mission
  par la capability négociée, rapproche tous ses champs de la preuve PostgreSQL, puis appelle
  l'annulation métier avec CAS. Si le TTL est déjà dépassé, seul le conflit exact `expired`,
  qui terminalise la mission et libère son slot dans le use case, est accepté.
- Une perte de réponse d'annulation autorise au plus deux appels avec le même `commandId`, puis une
  preuve terminale PostgreSQL exacte est repollée de façon bornée ; aucun champ libre de l'erreur
  serveur n'est publié pendant cette réconciliation.
- Le brouillon n'est supprimé que par l'API avec sa révision CAS, après vérification qu'il est
  toujours vide, lié au même `sessionId` et libéré de la mission. Le smoke n'appelle jamais
  `startQuoteCreation` pendant la récupération.
- Peer, capability et lease sont fermés même en cas d'échec. Le workflow ne poursuit vers le
  smoke positif nominal qu'après preuve `clean` (zéro mission active, zéro brouillon, zéro lease).
- Les diagnostics et artefacts ne publient aucun identifiant, email, token, SDP ou payload.

### 4.5 Autorité unique du digest de contexte

- Pour un contexte non nul, `prepareRealtimeContext(...).digest` est l'unique
  `contextDigest` public et durable.
- La réponse de `PUT /voice/realtime/calls/:sessionHandle/context`, la notification au sideband,
  `realtime_session_leases.contextDigest`, `contextAppliedDigest`, les fences de tour, les
  contrôles et l'ACK écran portent exactement cette même valeur.
- Version et révision restent des fences séparées ; elles ne modifient pas l'algorithme du digest.
- Aucun composant ne recalcule une seconde empreinte sémantiquement appelée `contextDigest`.
- Un test de contrat compare les octets exacts du digest retourné, notifié et recalculé à partir
  du snapshot canonique. Une simple validation de forme hexadécimale ne satisfait pas ce critère.

## 5. Critères d'acceptation binaires

- [ ] Timeout exact → nettoyage prouvé → un seul retry → succès avec UUID et peer neufs.
- [ ] Second timeout → exactement deux POST puis échec fermé.
- [ ] Chaque erreur non rejouable → exactement un POST.
- [ ] Nettoyage non prouvé, UUID dupliqué ou peer réutilisé → aucun second POST.
- [ ] Les tests injectent token/email/IDs/SDP dans toutes les branches d'erreur et n'en retrouvent
      aucun dans le diagnostic.
- [ ] Les preuves `clean` et `negative-final` comptent toutes les leases du tenant sans filtre de
      version de protocole.
- [ ] Le workflow M1-B n'appelle plus transitivement de mutateur étranger.
- [ ] Une garde statique transitive interdit `release.sh`, `prisma migrate deploy`, `rls.sql` et
      tout mutateur étranger depuis le lane M1-B.
- [ ] Une garde statique prouve le nombre et l'ordre des états, trois déploiements API, deux smokes
      négatifs, un positif et un cleanup `always()`.
- [ ] Le gate refuse un déployeur staging superuser ainsi qu'un runtime superuser ou `BYPASSRLS`.
- [ ] Le gate refuse toute migration en attente et toute divergence de checksum ; le cleanup reste
      rejouable sous le même `run_id` avec un nouvel `run_attempt`.
- [ ] Le certificat read-only de capacité passe après chaque drain et avant le writer ; tous les
      sous-processus DB ont une deadline dure testée.
- [ ] Une panne injectée après fermeture de capacité, avant ou pendant le cleanup M1-B, déclenche
      la restauration indépendante : capacité déjà active = certificat de configuration exact +
      no-op ; capacité fermée = drain + certificat fermé + réouverture ; aucun key manager et
      aucun déploiement API.
- [ ] Le mode de récupération est staging-only, opt-in, distinct de la certification et refuse
      fermé toute forme autre que l'unique résidu technique exact.
- [ ] La récupération négocie une capability neuve, ne démarre aucune mission, annule ou expire
      l'exact résidu via le use case, supprime le seul brouillon vide par CAS, ferme la session et
      obtient la preuve `clean` avant le scénario positif nominal.
- [ ] Après tout échec du smoke positif, le cleanup tente et prouve la récupération bornée avant
      de retirer l'override/les variables ; la remise OFF continue même si cette récupération
      échoue et le job conserve alors un verdict rouge.
- [ ] Un brouillon significatif, un binding, une seconde mission/lease, une révision ou un
      événement inattendu, une capability discordante ou une erreur CAS empêchent toute suite.
- [ ] Le recovery exécute le préflight HMAC anti-rotation avant activation ; deux réponses
      d'annulation perdues suivies d'un commit tardif convergent par polling vers la preuve
      terminale, sans fuite de `cause`, `reason`, payload ou identifiant dans stderr.
- [ ] Le digest retourné par `updateContext`, appliqué par le sideband, relu par le fence de tour
      et présenté à l'ACK écran est exactement `prepareRealtimeContext(...).digest`.
- [ ] Une divergence entre deux algorithmes de digest casse un test de contrat avant déploiement.
- [ ] Les tests ciblés, typecheck/build concernés et tests de release safety sont verts.
- [ ] Le SHA exact passe la vraie certification Supabase/Railway staging puis rend global OFF,
      zéro override possédé, zéro lease et zéro mission/brouillon.
- [ ] La durée réelle du run est consignée ; la cible est inférieure à 30 minutes, sans déclarer le
      lot `certified` si cette mesure ou l'état OFF final manque.

## 6. Definition of Done

Le lot passe de `specified` à `implemented` uniquement lorsque le code et les tests locaux couvrent
tous les invariants. Il passe à `certified` uniquement après le workflow staging au SHA exact,
avec artefact de preuve non-PII, durée mesurée et rollback OFF final. Il n'est pas `released` et
n'autorise aucune activation production.
