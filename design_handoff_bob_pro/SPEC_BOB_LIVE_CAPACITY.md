# SPEC — Bob Live : capacité, saturation maîtrisée et preuve de charge

**Statut** : en implémentation. Aucune capacité publique n'est revendiquée avant exécution des
profils de charge sur le SHA et la topologie exacts de release.

| Lot | État au 22 juillet 2026 | Autorise une cohorte ? |
|---|---|---|
| C1 — maintenance équitable | En certification PostgreSQL | Non |
| C2 — plafond global distribué | Non implémenté | Non |
| C3 — charge et soak | Non exécuté | Non |
| C4 — drain mono-provider | Non certifié | Non si la release change de provider |

La fermeture de C1 ne certifie donc ni 100 ni 1 000 comptes : C2 doit fermer la saturation avant
que C3 certifie d'abord la cohorte 100, puis la cohorte 1 000. C4 est en plus obligatoire pour
toute release qui change de provider.

## 1. Résultat produit

Bob Live doit rester fluide et sûr quand Bob devient le second canal d'exécution de toute
l'application. La capacité ne se résume donc pas à ouvrir des sockets : une mission vocale doit
continuer à lire les données réelles, naviguer, composer plusieurs use cases et demander les
désambiguïsations ou confirmations nécessaires, sans perdre une action ni affaiblir les invariants
métier sous charge.

La cible V1 est **1 000 comptes actifs représentatifs**, avec des paliers à certifier de 50, 100 puis
250 sessions Live simultanées. Ce contrat ne signifie pas « 1 000 voix simultanées ».

## 2. Invariants de capacité

1. Toute file, boucle, transaction et concurrence possède une borne explicite.
2. Une saturation refuse une nouvelle session avant épuisement des ressources ; elle ne dégrade
   jamais une session admise, une preuve durable ou une action déjà confirmée.
3. L'admission globale est atomique et partagée entre les répliques. Une limite process-local ne
   constitue pas une limite de capacité.
4. Les quotas utilisateur et tenant restent appliqués en plus du plafond global ; aucun plafond ne
   peut en masquer ou en contourner un autre.
5. La maintenance ne dépend ni de `JOB_COMPANY_IDS`, ni d'une liste de tenants chargée en mémoire,
   ni de l'ordre stable des sociétés.
6. Toute découverte globale est strictement minimale, lease/renew/ACK, rejouable après crash et
   séparée des mutations tenantées sous FORCE RLS.
7. Aucun appel fournisseur, stockage objet ou autre I/O externe ne reste sous transaction SQL.
8. Les métriques de capacité sont agrégées et sans identifiant métier : sessions actives,
   admissions refusées par motif, backlog borné, latences, pool, erreurs et reprises.
9. Les données de test et doubles fournisseur n'entrent jamais dans un artefact de production.
10. La certification s'exécute sur un environnement isolé et représentatif ; elle ne fabrique pas
    de charge sur la production.

## 3. Lot C1 — maintenance des leases équitable

Le reaper historique énumère une liste de sociétés puis coupe les 100 premières. Il est remplacé
par une projection matérialisée `realtime_reaper_tenant_schedule`, d'au plus une ligne par tenant,
qui conserve `oldestAdmissionAt`, `nextLeaseDueAt` et une révision. Des triggers statement-level
abaissent conservativement ces minima dans la transaction de chaque writer : un update/delete
concurrent ne peut donc jamais fabriquer de faux négatif. Après chaque traitement tenanté, le
reaper recalcule les minima exacts sous verrou tenant + verrou de la ligne projection et supprime
la ligne devenue vide.

L'autorité globale ne lit ainsi **jamais** les historiques d'admission ou de leases. Elle ne lit
que cette projection minimale via un curseur PostgreSQL durable à **deux lanes indépendantes** :
leases arrivées à échéance et événements d'admission à purger. Ainsi, un journal de quota ancien
ou un tenant bruyant ne peut jamais retarder la terminaison d'une vraie session fournisseur :

- scan keyset par tenant, chaque lane projetant au plus la limite de page `+ 1`, avec borne haute
  **et cutoff temporel** figés par cycle, et une seule occurrence par tenant quel que soit son
  nombre d'événements ;
- partage équitable de la page : au moins `floor(limit / 2)` places pour les leases lorsque les
  deux lanes sont pleines, unité impaire alternée, puis redistribution intégrale du reliquat ;
- page revendiquée sous `claimId` et lease de 30 secondes ;
- aucun avancement avant ACK ; page expirée relivrée à l'identique ;
- renouvellement avant chaque transaction tenantée ;
- mutation par le port d'admission existant, sous contexte tenant et `SKIP LOCKED` ;
- appel de terminaison provider après commit, puis complétion tenantée idempotente ;
- un échec tenant/provider conserve sa source due, mais n'empêche pas l'ACK du **scan** après que
  toute la page a été tentée ; il sera repris au cycle suivant sans affamer les tenants suivants ;
- fonctions globales possédées par un rôle NOLOGIN minimal, exécutables par le seul rôle applicatif
  configuré, sans droit de mutation sur les leases.

### Critères binaires C1

- [ ] Aucun chemin runtime du reaper n'appelle `ScheduledTenantDirectory` ou `companies.list()`.
- [ ] Chaque lane ne matérialise qu'une occurrence par tenant et au plus `limit + 1` ; les plans
      PostgreSQL naturels restent sous la borne et ne lisent jamais les historiques. Les requêtes
      restent indexables par le PK keyset ou l'index partiel de leur lane ; définition, validité et
      readiness exactes des deux indexes partiels sont certifiées séparément dans le catalogue
      (le planner peut légitimement préférer un scan de la seule projection à faible cardinalité).
- [ ] Deux schedulers concurrents ne traitent jamais simultanément la même page vivante.
- [ ] Sans ACK, la page est relivrée après expiration ; avec ACK, le curseur avance exactement une
      fois ; un ancien claim ne peut ni renouveler ni ACKer.
- [ ] Plus de 100 tenants dus sont tous atteints sans famine, y compris sous arrivée continue.
- [ ] Un tenant possédant des centaines d'événements ne compte qu'une fois par cycle, et une
      lease due apparaît dès la première page même sous backlog massif d'admission.
- [ ] Un tenant ou provider indisponible reste rejouable mais ne bloque jamais l'avancement du
      curseur vers les autres tenants de la page et du cycle.
- [ ] Toute transaction globale et tenantée porte `statement_timeout`, `lock_timeout` et une borne
      côté Prisma ; aucune terminaison provider n'est exécutée sous transaction.
- [ ] Le kill-switch ferme les nouvelles admissions sans désenregistrer l'adapter de terminaison
      du provider sélectionné ; les leases déjà persistées restent drainables jusqu'au zéro.
- [ ] RLS, ownership, ACL, fonctions, indexes et curseur sont certifiés sur PostgreSQL réel.
- [ ] Le certificat de release est metadata-only, `READ ONLY` et sans fixture ni DDL.
- [ ] La projection A/B est certifiée fonctionnellement sous FORCE RLS, DML cross-tenant refusé.
- [ ] Le certificat CI/RLS utilise uniquement des fixtures transactionnelles annulées sur un
      PostgreSQL isolé ; il ne modifie jamais le curseur d'une release en activité.
- [ ] Une vraie course trigger conservatif/réconciliation exacte à deux connexions PostgreSQL ne
      perd jamais l'échéance la plus ancienne.
- [ ] Découvrir globalement un tenant ne confère aucun droit de lecture ou mutation hors de son
      contexte tenant.

## 4. Lot C2 — admission globale distribuée

Une réservation consomme atomiquement une place globale avant création de l'appel provider. La
place reste liée au lease durable et est rendue par release, expiration ou reaper. Le plafond est
configuré explicitement par environnement et son absence en mode Live est un échec de boot.

La saturation renvoie un motif `global_capacity` avec un `retryAt` borné ; elle n'appelle jamais le
provider. La jauge active est dérivée de l'autorité durable et les événements provider
`rate_limits.updated` alimentent la métrologie sans devenir seuls juges de l'admission.

### Critères binaires C2

- [ ] N réservations concurrentes sur plusieurs repositories ne dépassent jamais le plafond N.
- [ ] La N+1e réservation est refusée avant tout appel au provider sélectionné et expose un retry
      explicite.
- [ ] Crash entre réservation et création provider : la place est récupérée après TTL.
- [ ] Release, reaper et répétition idempotente ne décrémentent jamais deux fois.
- [ ] Les quotas user/tenant et la limite globale restent tous testés en courses PostgreSQL.
- [ ] Le démarrage Live échoue fermé si plafond, quota provider ou configuration de mesure sont
      partiels.

## 5. Lot C3 — harness et gates de publication

Deux passages sont obligatoires : fournisseur déterministe pour charger Bob/API/DB sans coût
externe, puis provider cible réel — GPT Realtime pour cette release — afin de mesurer quotas et
latence de bout en bout.

| Gate | Population seedée | API | Live | Soak |
|---|---:|---:|---:|---:|
| Cohorte 100 | 100 comptes représentatifs | 25 VU soutenus, 75 burst | 10 → 25 → 50 | 50 Live 1 h + mixte 2 h |
| Cohorte 1 000 | 1 000 comptes représentatifs | 100 VU soutenus, 250 burst | 50 → 100 → 250 | 250 Live 1 h + mixte 4 h |

Répartition minimale du trafic mixte : 55 % lectures, 15 % cycle Live/contexte/contrôle, 15 %
écritures idempotentes, 5 % mutations financières confirmées, 5 % upload/OCR et 5 % jobs.
La part Live exécute des missions représentatives complètes — navigation, recherche dans les
données réelles, désambiguïsation, composition de plusieurs use cases, diff et confirmation — et
pas uniquement l'ouverture/fermeture d'un transport audio.
Cette spec certifie la capacité des missions déjà acceptées individuellement ; elle ne vaut pas
encore certification fonctionnelle exhaustive de la parité Jarvis sur toute l'application.

### Gates bloquants

- [ ] Premier audio p50 ≤ 900 ms, p95 ≤ 1 800 ms ; barge-in p50 ≤ 250 ms, p95 ≤ 500 ms.
- [ ] HTTP courant p95 ≤ 500 ms/p99 ≤ 1 s ; écriture critique p95 ≤ 750 ms/p99 ≤ 2 s.
- [ ] 5xx + timeouts ≤ 0,1 % ; setup Live admis ≥ 99,5 % ; zéro erreur silencieuse.
- [ ] CPU DB/API ≤ 70 % soutenu, mémoire ≤ 75 % sans pente, pool DB ≤ 80 %, marge mesurée ≥ 30 %.
- [ ] Zéro fuite tenant, exécution fantôme, double mutation, perte de contrôle ou reprise d'un audio
      annulé.
- [ ] Les scénarios N/N+1, crash après réservation, récupération TTL, panne provider, reconnexion
      massive et saturation DB/pool sont injectés et leurs refus/reprises restent bornés.
- [ ] Trois exécutions propres et reproductibles sur le SHA exact ; suivi des SLO sept jours avant
      élargissement de cohorte.
- [ ] Chaque preuve conserve SHA, topologie, plafond global, provider, modèle et quotas exacts.

## 6. Lot C4 — bascule mono-provider sans lease orpheline

La V1 reste volontairement mono-provider. Une seule génération de credentials reçoit de nouvelles
admissions ; l'ancienne ne peut subsister qu'en drain. Un changement de provider est une opération
drainée, jamais une simple modification de variable à chaud :

1. fermer les nouvelles admissions tout en conservant l'ancien provider configuré ;
2. garder son adapter et ses credentials tant qu'il existe une lease durable
   `reserved`/`active`/`reaping` ou un replay terminal en attente ;
3. laisser le reaper terminer chaque lease avec son `providerId` persisté ;
4. constater zéro lease/replay de l'ancien `providerId`, déployer le nouveau provider, puis rouvrir ;
5. si l'adapter d'une lease manque, conserver la lease sous fence : aucun cross-routing vers le
   provider courant et aucune fausse complétion.

Une bascule sans cette séquence reste hors promesse de publication.

### Critères binaires C4

- [ ] Les nouvelles admissions sont réellement refusées pendant toute la fenêtre de drain.
- [ ] Zéro lease `reserved`/`active`/`reaping` et zéro replay terminal de l'ancien `providerId`
      sont observés avant la bascule.
- [ ] Un adapter absent échoue fermé sans cross-routing ni fausse complétion.
- [ ] Les anciens credentials restent disponibles au drain jusqu'au zéro mesuré, jamais après.
- [ ] Le rollback du nouveau provider est testé avant la réouverture des admissions.

## 7. Hors promesse

- 1 000 sessions vocales simultanées ;
- haute disponibilité multi-réplique tant que les limites process-local restantes et le routage
  sideband n'ont pas été remplacés/certifiés ;
- capacité déduite d'un test unitaire, d'un health check ou du nombre d'inscrits.
