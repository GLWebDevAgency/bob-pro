# SPEC — Bob Live : capacité, saturation maîtrisée et preuve de charge

**Statut** : en implémentation. Aucune capacité publique n'est revendiquée avant exécution des
profils de charge sur le SHA et la topologie exacts de release.

| Lot | État au 22 juillet 2026 | Autorise une cohorte ? |
|---|---|---|
| C1 — maintenance équitable | Livré et certifié PostgreSQL 17 (15/15) | Non, seul |
| C2 — plafond global distribué | Implémenté ; certificat local PostgreSQL 17 vert (8/8), CI distante à rejouer | Non, seul |
| C3 — charge, Jarvis et soak | Contrat de preuve en implémentation ; 0/8 mission exécutée sur cible | Non |
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

La voix est une **interface vers les capacités de l'application**, pas une capacité parallèle. Une
mission Jarvis n'est finie que lorsque Bob a appelé les mêmes use cases métier que le parcours
tactile, traversé les écrans nécessaires, conservé son état après chaque navigation, demandé
uniquement les informations ou confirmations réellement manquantes, puis relu l'effet autoritaire.
Une réponse parlée correcte sans cet effet réel est un échec.

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

- [x] Aucun chemin runtime du reaper n'appelle `ScheduledTenantDirectory` ou `companies.list()`.
- [x] Chaque lane ne matérialise qu'une occurrence par tenant et au plus `limit + 1` ; les plans
      PostgreSQL naturels restent sous la borne et ne lisent jamais les historiques. Les requêtes
      restent indexables par le PK keyset ou l'index partiel de leur lane ; définition, validité et
      readiness exactes des deux indexes partiels sont certifiées séparément dans le catalogue
      (le planner peut légitimement préférer un scan de la seule projection à faible cardinalité).
- [x] Deux schedulers concurrents ne traitent jamais simultanément la même page vivante.
- [x] Sans ACK, la page est relivrée après expiration ; avec ACK, le curseur avance exactement une
      fois ; un ancien claim ne peut ni renouveler ni ACKer.
- [x] Plus de 100 tenants dus sont tous atteints sans famine, y compris sous arrivée continue.
- [x] Un tenant possédant des centaines d'événements ne compte qu'une fois par cycle, et une
      lease due apparaît dès la première page même sous backlog massif d'admission.
- [x] Un tenant ou provider indisponible reste rejouable mais ne bloque jamais l'avancement du
      curseur vers les autres tenants de la page et du cycle.
- [x] Toute transaction globale et tenantée porte `statement_timeout`, `lock_timeout` et une borne
      côté Prisma ; aucune terminaison provider n'est exécutée sous transaction.
- [x] Le kill-switch ferme les nouvelles admissions sans désenregistrer l'adapter de terminaison
      du provider sélectionné ; les leases déjà persistées restent drainables jusqu'au zéro.
- [x] RLS, ownership, ACL, fonctions, indexes et curseur sont certifiés sur PostgreSQL réel.
- [x] Le certificat de release est metadata-only, `READ ONLY` et sans fixture ni DDL.
- [x] La projection A/B est certifiée fonctionnellement sous FORCE RLS, DML cross-tenant refusé.
- [x] Le certificat CI/RLS utilise uniquement des fixtures transactionnelles annulées sur un
      PostgreSQL isolé ; il ne modifie jamais le curseur d'une release en activité.
- [x] Une vraie course trigger conservatif/réconciliation exacte à deux connexions PostgreSQL ne
      perd jamais l'échéance la plus ancienne.
- [x] Découvrir globalement un tenant ne confère aucun droit de lecture ou mutation hors de son
      contexte tenant.

## 4. Lot C2 — admission globale distribuée

Une réservation consomme atomiquement une place globale avant création de l'appel provider. La
place reste liée au lease durable et est rendue par release, expiration ou reaper. Le plafond est
configuré explicitement par environnement et son absence en mode Live est un échec de boot.

L'autorité est une ligne singleton FORCE RLS, possédée par un rôle `NOLOGIN` non assumable par le
runtime. Deux triggers `AFTER ... FOR EACH STATEMENT`, activés `ALWAYS`, projettent les INSERT et
DELETE de leases dans la même transaction. Ils protègent également un binaire N-1 qui ignorerait
le preflight. `TRUNCATE` est interdit et la FK société → lease est `ON DELETE RESTRICT` : une place
ne peut pas être rendue tant qu'un appel provider pourrait encore vivre.

Le groupe `GLOBAL_MAX / PROVIDER_MAX / CONFIG_VERSION` est tout-ou-rien. Toute reconfiguration
différente exige `closed`, drain à zéro et version strictement supérieure. Une release ferme
l'autorité avant ses preuves, certifie projection/ownership/ACL en `REPEATABLE READ READ ONLY`,
retire ses fixtures puis exécute l'activation réelle comme dernier geste mutationnel.

La saturation renvoie un motif `global_capacity` avec un `retryAt` borné ; elle n'appelle jamais le
provider. La jauge active est dérivée de l'autorité durable et les événements provider
`rate_limits.updated` alimentent la métrologie sans devenir seuls juges de l'admission.

### Critères binaires C2

- [x] N réservations concurrentes sur plusieurs repositories ne dépassent jamais le plafond N.
- [x] La N+1e réservation est refusée avant tout appel au provider sélectionné et expose un retry
      explicite.
- [x] Crash entre réservation et création provider : la place est récupérée après TTL.
- [x] Release, reaper et répétition idempotente ne décrémentent jamais deux fois.
- [x] Les quotas user/tenant et la limite globale restent tous testés en courses PostgreSQL.
- [x] Une fermeture de release concurrente d'une admission déjà préflightée converge sans deadlock,
      conserve exactement la lease commitée puis peut rouvrir la même configuration.
- [x] Le démarrage Live échoue fermé si plafond, quota provider ou configuration de mesure sont
      partiels.

## 5. Lot C3 — harness et gates de publication

Deux passages sont obligatoires : fournisseur déterministe pour charger Bob/API/DB sans coût
externe, puis provider cible réel — GPT Realtime pour cette release — afin de mesurer quotas et
latence de bout en bout.

| Gate | Population seedée | API | Live | Soak |
|---|---:|---:|---:|---:|
| Cohorte 100 | 100 comptes représentatifs | 25 VU soutenus, 75 burst | 10 → 25 → 50 | 50 Live 1 h + mixte 2 h |
| Cohorte 1 000 | 1 000 comptes représentatifs | 100 VU soutenus, 250 burst | 50 → 100 → 250 | 250 Live 1 h + mixte 4 h |

Chaque run embarque un `capacity-profile.json` signé et lié au SHA. Il fixe la topologie, les pools,
les plafonds par réplique (`liveSockets`, RSS, FD, event-loop lag), les lots et le jitter de
renouvellement, ainsi que le budget fournisseur. Le profil est refusé si une valeur est implicite,
illimitée ou incompatible avec la formule de budget DB de l'ADR-0006. Le coût déclenche une alerte
à 80 % du budget et ferme les nouvelles admissions à 100 %, sans interrompre les sessions déjà
admises. Le plafond local sockets/FD/RSS doit laisser au moins 30 % de marge mesurée au pic, y
compris lorsque le load balancer concentre le palier entier sur une réplique ; sinon la topologie
doit limiter ou redistribuer le trafic avant certification.

Les autorités singleton PostgreSQL sont acceptées seulement si, sur chacun des trois runs :

- attente de verrou p95 ≤ 10 ms et p99 ≤ 50 ms ;
- zéro deadlock et zéro transaction abandonnée ;
- transaction de claim/finalisation p95 ≤ 50 ms et p99 ≤ 100 ms ;
- débit soutenu mesuré avec une marge ≥ 2× le pic observé du profil.

Un dépassement bloque la release et exige partitionnement en slots/chunks ou réduction du palier ;
une moyenne globale ne peut pas masquer un dépassement d'une autorité singleton. L'event-loop lag
par réplique reste p95 ≤ 50 ms et p99 ≤ 100 ms. Les renouvellements d'owners utilisent des lots
bornés à 100 et un jitter uniforme d'au moins 20 % de la période de renouvellement ; une autre
valeur exige un profil signé justifiant par mesure une charge PostgreSQL inférieure ou égale.

Répartition minimale du trafic mixte : 55 % lectures, 15 % cycle Live/contexte/contrôle, 15 %
écritures idempotentes, 5 % mutations financières confirmées, 5 % upload/OCR et 5 % jobs.
La part Live exécute des missions représentatives complètes — navigation, recherche dans les
données réelles, désambiguïsation, composition de plusieurs use cases, diff et confirmation — et
pas uniquement l'ouverture/fermeture d'un transport audio.
Cette spec certifie la capacité des missions déjà acceptées individuellement ; elle ne vaut pas
encore certification fonctionnelle exhaustive de la parité Jarvis sur toute l'application.

### Missions Jarvis obligatoires dans C3

Le harnais ne considère pas une mission réussie parce qu'un LLM a produit du texte. Il exige les
effets réels relus dans la base, via les mêmes use cases que le geste manuel, avec journal d'outil,
révisions et confirmations exactes.

| Mission | Entrée naturelle minimale | Preuve de fin |
|---|---|---|
| Devis complet d'une traite | client + plusieurs prestations + quantités/prix + échéance | client réel résolu, catalogue proposé/désambiguïsé, brouillon exact, diff confirmé, devis relu |
| Devis progressif multi-écrans | « crée un devis », puis réponses au fil du wizard | mission conservée après chaque navigation/ACK écran, aucune reprise à zéro |
| Facture depuis devis | devis réel puis conditions de règlement | lien source immuable, totaux/TVA réels, confirmation financière unique |
| Nouveau client | identité partielle puis complément demandé | aucune invention, doublon détecté, création idempotente et fiche relue |
| Catalogue | recherche approximative puis « le deuxième » ou « ajoute un nouveau » | candidats réels ordonnés, choix voix/tap équivalent, aucune sélection silencieuse |
| Briefing écran/home | « explique tout ce qui est en attente » | agrégation bornée d'entités réelles, navigation ciblée sans mutation |
| Notification | lecture, ouverture, proposition de relance | contexte facture/client rechargé, action destructive/communication confirmée |
| Interruption/reprise | barge-in pendant réponse puis correction d'une donnée | audio stoppé, ancien tour fenced, même mission/revision reprise sans double action |

Pour chaque mission, Bob extrait d'abord tous les faits fournis. Il ne pose une question que pour
une donnée indispensable absente, une ambiguïté réelle ou une confirmation réglementaire. Une
réponse vocale et un choix tactile alimentent la même machine à états ; navigation et changement
d'écran ne terminent jamais implicitement la mission.

### Chaîne de preuve anti-fausse-publication

Le validateur d'un run ne peut produire qu'un verdict de run ; il n'émet jamais une promesse
publique. Chaque verdict déterministe/GPT, le certificat C1/C2/C4 et chaque échantillon de suivi
sont ensuite enveloppés et signés par leur workflow protégé, avec SHA, profil, identité du workflow,
horodatage, digest du preflight et digest des preuves brutes. Runs, prérequis, monitoring et
publication possèdent quatre clés Ed25519 distinctes : empreinte SPKI, chemin, `keyId`, workflow et
SHA immuable sont épinglés par rôle. Une clé de run ne peut donc signer ni les prérequis ni le
certificat final. Le candidat de publication est dérivé uniquement après vérification
cryptographique de ces enveloppes ; un objet candidat construit en mémoire est refusé, même s'il
tente d'emprunter la dernière étape de signature.

La publication exige donc deux autorités successives : provenance signée des faits, puis signature
du certificat dérivé. Le suivi de sept jours commence après le dernier des six runs, porte des
échantillons horodatés toutes les cinq minutes sans trou, reste lié au même SHA et à la même
topologie, et se termine dans le passé. Le certificat expose séparément comptes actifs, VU API et
maximum de sessions Live ; il interdit explicitement d'interpréter « cohorte 1 000 » comme
« 1 000 voix simultanées ».

### Gates bloquants

- [ ] Premier audio p50 ≤ 900 ms, p95 ≤ 1 800 ms ; barge-in p50 ≤ 250 ms, p95 ≤ 500 ms.
- [ ] HTTP courant p95 ≤ 500 ms/p99 ≤ 1 s ; écriture critique p95 ≤ 750 ms/p99 ≤ 2 s.
- [ ] 5xx + timeouts ≤ 0,1 % ; setup Live admis ≥ 99,5 % ; zéro erreur silencieuse.
- [ ] CPU DB/API ≤ 70 % soutenu, mémoire ≤ 75 % sans pente, pool DB ≤ 80 %, marge mesurée ≥ 30 %.
- [ ] Le profil signé contient tous les plafonds locaux, pools, budgets et paramètres de
      renouvellement ; lock-wait, deadlock, durée de transaction, headroom singleton et event-loop
      respectent les seuils explicites ci-dessus sur chaque run.
- [ ] Zéro fuite tenant, exécution fantôme, double mutation, perte de contrôle ou reprise d'un audio
      annulé.
- [ ] Les huit missions Jarvis sont exécutées sur chaque palier Live avec reçus issus du journal
      serveur/DB : lecture autoritaire, use case exact, idempotence, confirmation, relecture et
      révisions ; aucune preuve synthétique fournie par le runner n'est acceptée.
- [ ] Pour toute décision disponible à la voix et au toucher, les deux entrées traversent la même
      transition métier et aboutissent au même hash de brouillon/entité ; la navigation et le
      redémarrage de l'app ne perdent pas la mission active.
- [ ] Le passage GPT utilise un vrai média audio `sendrecv`, une seule sortie distante, un micro
      encore ouvert pendant la parole de Bob et un barge-in qui coupe localement l'ancien audio
      avant le `cancel/clear` distant ; le transport historique uplink-only ne satisfait pas ce gate.
- [ ] Les scénarios N/N+1, crash après réservation, récupération TTL, panne provider, reconnexion
      massive et saturation DB/pool sont injectés et leurs refus/reprises restent bornés.
- [ ] Trois exécutions propres et reproductibles sur le SHA exact ; suivi des SLO sept jours avant
      élargissement de cohorte.
- [ ] Chaque preuve conserve SHA, topologie, plafond global, provider, modèle et quotas exacts.
- [ ] Six verdicts, prérequis et monitoring sont des enveloppes signées vérifiées avant construction
      du candidat ; un candidat simple, un monitoring futur ou une série contenant un trou sont
      refusés par tests négatifs.

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
