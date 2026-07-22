# ADR-0006 : autorité distribuée pour les sessions et la montée en charge

## Statut

Accepted — 2026-07-22, décision fondateur.

## Contexte

Bob Pro doit servir une première cohorte d'environ 100 utilisateurs, puis 1 000 comptes actifs,
sans que Bob Live, les missions Jarvis ou les mutations métier dépendent de la mémoire d'un seul
processus. La topologie de publication actuelle reste volontairement mono-réplique : plusieurs
protections historiques — notamment le throttling général et certains chemins de notification
sideband — sont encore process-locales.

Cette topologie convient à une bêta bornée, mais elle ne constitue ni de la haute disponibilité ni
une preuve de capacité. Une session audio possède forcément une connexion réseau locale à une
réplique ; cela ne doit jamais transformer cette réplique en source de vérité de la mission, d'un
ACK, d'une confirmation ou d'un effet métier.

Les cibles et SLO de charge sont définis dans
[`SPEC_BOB_LIVE_CAPACITY.md`](../../design_handoff_bob_pro/SPEC_BOB_LIVE_CAPACITY.md). Le présent ADR
fige l'architecture qui permet de les atteindre ; il ne déclare aucun palier certifié.

## Décision drivers

- reprise après crash, déploiement ou changement de réplique sans duplication silencieuse ni
  action incertaine rejouée aveuglément ;
- parité voix/tap fondée sur les mêmes use cases et les mêmes révisions ;
- admission et saturation globales exactes, même avec plusieurs répliques ;
- isolation tenant et idempotence conservées sous concurrence ;
- augmentation progressive de capacité sans réécriture du domaine ;
- refus borné et explicite avant épuisement d'une ressource ;
- observabilité sans exposer de contenu métier ou d'audio.

## Options considérées

### Une grosse réplique et tout l'état en mémoire

Acceptable uniquement comme étape de bêta explicitement bornée. Rejeté comme architecture cible :
un crash perd l'état, un déploiement coupe les sessions et la capacité ne peut pas progresser sans
augmenter le rayon d'impact.

### Sessions collantes avec état local

Rejeté comme mécanisme de sûreté. L'affinité peut réduire la latence, mais une reconnexion, un
rebalance ou une panne l'annule. Elle ne peut pas garantir un ACK, une confirmation ou une mutation
exactement une fois.

### Autorité durable partagée et répliques applicatives stateless

Retenu. PostgreSQL reste l'autorité transactionnelle initiale. Un broker ou un stockage spécialisé
ne sera ajouté que lorsqu'une mesure montre que PostgreSQL ne satisfait plus le SLO ; il devra
implémenter les mêmes ports et les mêmes fences.

## Décision

### 1. Une vérité durable pour chaque cycle critique

Les états suivants **doivent devenir** durables, tenant-scopés lorsqu'ils portent une donnée
métier, versionnés et modifiés par compare-and-swap ou verrou explicite :

- `AgentMission`, événements de mission, interactions en attente et reçus d'outils ;
- admission Live, lease de session, owner sideband, génération et expiration ;
- préparation, complétion, annulation et ACK de chaque restitution vocale ;
- propositions, confirmations, idempotency keys et audit des effets métier ;
- quotas globaux/provider/tenant et comptage d'usage ;
- outbox et jobs de livraison, archivage, relance, notification et maintenance.

Ce paragraphe décrit la cible. À la date de l'ADR, plusieurs objets Live disposent déjà de leur
autorité PostgreSQL, mais l'annuaire des tenants planifiés, certains déclenchements de jobs et
certains fast paths sideband restent locaux ou configurés manuellement. Ils n'autorisent donc pas
encore une topologie multi-réplique.

Une map, une promesse, un timer ou une socket locale peut accélérer le chemin nominal. Sa perte ne
peut ni perdre un effet accepté, ni transformer un état inconnu en succès, ni empêcher la reprise
sur une autre réplique.

Les garanties sont nommées sans promettre un « exactly once » physique impossible à imposer à un
fournisseur externe :

| Frontière | Garantie |
|---|---|
| état Bob/PostgreSQL | au plus une transition logique par clé d'idempotence, CAS et révision |
| exécution worker | at-least-once, claim par lease/fence, finalisation idempotente |
| effet externe | clé d'idempotence fournisseur si disponible ; sinon `uncertain`, réconciliation ou quarantaine, jamais retry aveugle |
| ACK Bob | un reçu durable canonique par delivery + corps exact ; les replays restituent ce reçu |

### 2. La connexion reste locale, son autorité ne l'est pas

La réplique qui détient une socket audio conserve seulement les ressources éphémères impossibles à
partager : socket, buffer, contrôleur d'annulation et secret d'owner en mémoire. PostgreSQL conserve
leur identité non secrète, leur génération, leur lease et leurs empreintes.

Toute commande susceptible d'arriver sur une autre réplique est **d'abord** écrite durablement avec
`commandId`, cible, `ownerEpoch` attendu, révisions de contexte/mission attendues et TTL. Un bus ou
RPC peut réveiller l'owner, mais il ne transporte jamais l'unique copie de la commande. L'owner
recharge, compare ses fences, applique par CAS et écrit un reçu ; polling borné et reaper restent le
fallback lorsque le réveil est perdu.

Une réponse HTTP ne déclare pas `applied` avant le reçu durable de l'owner. À l'expiration, le
système fence ou ferme la session et le client désactive son microphone jusqu'à une reconnexion
sûre. Une notification process-locale peut rester un fast path, jamais l'unique chemin. L'affinité
de session est une optimisation facultative, jamais une précondition de correction.

### 3. Répliques stateless et backpressure globale

- L'API authentifie puis recharge l'état réel à chaque requête ; aucun cache local ne confère un
  droit ou une révision.
- L'admission Live suit un ordre strict : réservation locale atomique, réservation globale
  durable, puis appel fournisseur. Toute frontière échouée compense immédiatement et de manière
  idempotente les réservations déjà acquises ; après crash, le TTL et le reaper libèrent la
  réservation globale, tandis que la disparition du processus libère la réservation locale. Une
  réplique localement saturée ne peut donc pas consommer puis immobiliser une place globale.
- Le throttling de sécurité et les limites globales deviennent partagés avant tout passage à plus
  d'une réplique. Les buckets indépendants sujet, tenant, endpoint/global et IP grossière sont
  empilés ; une clé composite unique ne doit ni mutualiser tous les utilisateurs derrière un
  CGNAT, ni permettre de contourner le quota en changeant d'IP. Un compteur local ne peut autoriser
  qu'une topologie mono-réplique certifiée.
- Chaque file, retry, page, transaction et boucle possède une borne. La saturation refuse les
  nouveaux travaux avec un motif et un délai de reprise ; elle ne dégrade pas les travaux admis.
- Les schedulers ne possèdent pas le job : ils réclament des lignes durables avec lease,
  `SKIP LOCKED`, ACK et reprise après crash. Les appels externes s'exécutent hors transaction.
- Chaque cron process-local possède un inventaire de migration explicite. OCR, PDF, archives et
  autres charges lourdes utilisent des workers, pools DB et limites de concurrence séparés afin
  qu'une saturation documentaire ne dégrade ni HTTP courant ni Bob Live.
- Chaque réplique possède aussi ses propres plafonds de sockets Live, mémoire, descripteurs de
  fichiers et event-loop lag. Le load balancer peut être déséquilibré : le plafond global ne suffit
  donc jamais à protéger une instance.
- Les renouvellements d'owners ajoutent jitter et lots bornés afin qu'un redémarrage ou une reprise
  réseau ne provoque pas de thundering herd sur PostgreSQL.
- Chaque cohorte possède un budget fournisseur et un disjoncteur de coût ; dépasser le budget ferme
  les nouvelles admissions sans interrompre une session déjà admise.

### 4. Budget PostgreSQL explicite

Chaque réplique possède un pool borné. Le preflight de release vérifie :

```text
apiReplicas × apiPool + workerReplicas × workerPool + listeners + admin/migrations
  ≤ floor(effectiveDbCapacity × 0,70)
```

`effectiveDbCapacity` est le minimum entre les connexions PostgreSQL réellement utilisables et le
plafond du pooler souscrit. Le boot vérifie l'allocation locale ; seul le preflight connaît et
valide la topologie entière. Le pool, les timeouts de transaction et les attentes de verrou sont
des paramètres de release, pas des valeurs implicites d'un SDK.

Les listes de production sont paginées et indexées sur leur clé tenant + curseur métier. Une lecture
qui charge toutes les entités d'un tenant ou produit un N+1 bloque le palier suivant jusqu'à
correction. RLS reste forcée avec le rôle runtime réel pendant les tests de concurrence.

Les autorités globales singleton sont des hot rows assumées seulement tant que la charge les
valide. Leur lock-wait p95/p99, taux de deadlock, débit et temps de transaction ont des SLO. Un
seuil binaire défini par le profil C3 déclenche leur partition en slots/chunks déterministes avant
qu'elles ne deviennent le verrou global de toute l'application.

### 5. Déploiement et reprise

Le passage à plusieurs répliques exige :

- readiness du nouvel artefact avant routage ;
- états de réplique explicites `ready → draining → dead`, heartbeat avec TTL et transitions
  idempotentes ;
- arrêt des nouvelles admissions sur la réplique drainée, avec backoff+jitter côté client ;
- renouvellement ou transfert fencé des leases ;
- budget et deadline de drain bornés ; après la deadline, le reaper reprend les états durables ;
- reprise de transport WebRTC par un nouvel appel/session lorsque le fournisseur ne sait pas
  reprendre une socket, distincte de la reprise de l'`AgentMission` durable ;
- reconnexion client idempotente sur une autre réplique et rollout expand/contract ;
- aucune transition logique Bob perdue ou dupliquée ; aucun reçu ACK durable perdu et réponse HTTP
  rejouable ; toute livraison externe suit la matrice
  `idempotent | uncertain | reconciled/quarantined`.

L'arrêt commence par fermer l'admission, puis draine par pages bornées selon les budgets
DB/fournisseur. Il n'attend jamais sans limite un `Promise.all` sur toutes les sessions.

Une release qui change de provider suit en plus le drain mono-provider de C4. Aucun cross-routing
silencieux vers un autre fournisseur n'est autorisé.

Une perte de PostgreSQL échoue fermée : aucune autorité locale de secours et aucune mutation en
mémoire. Dès l'échec ou l'expiration d'un renouvellement d'owner, la réplique refuse les nouveaux
tours et outils, annule et réduit au silence l'audio local, puis ferme la connexion fournisseur au
plus tard à l'expiration du lease courant. Le barge-in local reste disponible pendant cette
fermeture afin que l'utilisateur puisse toujours interrompre Bob. Les objectifs RTO/RPO,
réplication, sauvegardes et restauration PITR seront figés dans un ADR haute disponibilité distinct
avant ouverture publique ; ils devront être testés, pas seulement configurés chez l'hébergeur.

## Gates binaires

- [ ] Deux managers distincts convergent sur le même ACK durable, quel que soit celui qui reçoit
      la requête HTTP.
- [ ] Kill -9 de l'owner à chaque phase d'une mission et d'un tour Live : reprise bornée, aucun
      commit logique Bob perdu ou dupliqué ; chaque effet externe aboutit à
      `idempotent | uncertain | reconciled/quarantined`.
- [ ] Le produit reste correct sans affinité de session ; l'activer ou la désactiver ne change que
      la latence.
- [ ] Deux répliques n'excèdent jamais les plafonds globaux ; chaque job suit la matrice de
      garanties ci-dessus et toute issue fournisseur incertaine est réconciliée ou mise en
      quarantaine sans replay aveugle.
- [ ] Une commande de contexte reçue par B n'est jamais déclarée appliquée avant que l'owner A ait
      écrit le reçu portant `contextAppliedRevision`, digest et owner epoch exacts ; timeout,
      partition réseau ou owner mort ferment la session et le micro.
- [ ] L'annuaire des jobs découvre automatiquement tous les tenants éligibles, avec pages, équité,
      lease, non-chevauchement et métriques de backlog ; aucun onboarding ne dépend d'une liste
      d'environnement maintenue à la main.
- [ ] Aucun appel fournisseur, génération PDF, stockage objet ou autre I/O externe n'est exécuté
      sous la transaction tenant qui porte le GUC RLS ; les claims et finalisations SQL restent
      courts et testés après perte de réponse.
- [ ] Toute liste de production est paginée et indexée sur tenant + curseur ; les parcours de
      charge prouvent l'absence de N+1, y compris pour un tenant ancien avec des milliers de pièces.
- [ ] Upload, OCR, PDF et intelligence documentaire possèdent admission, concurrence, taille,
      timeout et mémoire bornés ; une saturation n'épuise ni le processus API ni le pool DB.
- [ ] Le throttling partagé reste équitable derrière NAT/CGNAT et combine au minimum identité
      authentifiée, tenant et signal réseau sans permettre à un utilisateur de bloquer les autres.
- [ ] Le boot vérifie le pool maximal de sa seule réplique ; le preflight vérifie l'allocation
      totale de la topologie. Sous charge, utilisation ≤ 80 % et marge mesurée ≥ 30 %.
- [ ] La formule de preflight couvre toutes les répliques/pools et réserve au moins 30 % de la
      capacité DB effective ; le hot singleton respecte ses SLO de lock-wait, deadlock et débit ou
      la release exige son partitionnement.
- [ ] Chaque réplique refuse localement avant dépassement de ses plafonds sockets, RSS, FD et
      event-loop, y compris lorsque le load balancer concentre les 250 sessions sur une instance.
- [ ] Readiness réelle, drain, reconnexion et arrêt brutal sont injectés pendant un rollout ; zéro
      requête acceptée, job réclamé ou mission reconnue n'est perdu silencieusement.
- [ ] Le drain est testé à 250 sessions avec kill de l'owner et partition réseau : deadline bornée,
      nouvel appel transport si nécessaire et même `AgentMission` reprise sans double commit
      logique ; tout effet fournisseur incertain est réconcilié ou mis en quarantaine.
- [ ] Les quotas empilés laissent travailler 100 utilisateurs derrière le même CGNAT et empêchent
      un seul sujet de contourner ses limites par rotation d'IP.
- [ ] Une panne PostgreSQL ferme admissions et mutations sans fallback local ; restauration et
      reprise respectent les RTO/RPO/PITR certifiés par l'ADR haute disponibilité. Une partition DB
      injectée pendant transcript, outil et lecture audio arrête nouveaux tours/outils, silence et
      ferme le provider avant l'expiration du lease sans empêcher le barge-in local.
- [ ] Sous déséquilibre du load balancer, l'admission réserve localement puis globalement avant le
      provider ; une faute injectée à chaque frontière prouve la compensation idempotente immédiate
      et le reaper prouve zéro réservation globale durable échouée.
- [ ] Renouvellements d'owners avec jitter/lots et disjoncteur de coût fournisseur résistent à une
      reconnexion massive sans pic non borné ni dépassement du budget de cohorte.
- [ ] Les profils `cohort-100`, puis `cohort-1000`, passent trois fois sur le SHA et la topologie
      exacts, suivis du soak et de la fenêtre d'observation exigés par C3.
- [ ] Les huit missions Jarvis relisent leurs effets réels sous charge ; ouvrir des sockets ou
      produire du texte ne compte pas comme réussite.
- [ ] Une dérive vers une autorité process-locale critique fait échouer un test de contrat ou le
      pipeline de topologie.

## Conséquences

### Positives

- montée en charge horizontale sans modifier les invariants métier ;
- reprise déterministe après panne et déploiement ;
- capacité mesurable et saturation maîtrisée ;
- même source de vérité pour la voix, le toucher et les workers.

### Négatives

- davantage de CAS, de lectures autoritaires et de métrologie ;
- PostgreSQL devient un composant critique dont le pool et les hot rows doivent être surveillés ;
- une vraie haute disponibilité demande plus qu'augmenter `numReplicas` ;
- la bêta reste mono-réplique tant que les gates ci-dessus ne sont pas fermés.

## Plan d'adoption

1. Fermer les chemins ACK, mission, contrôle et job dont la vérité est encore locale.
2. Certifier la cohorte 100 sur une topologie isolée représentative.
3. Remplacer le throttling local, migrer chaque cron inventorié, isoler les workers lourds,
   expliciter le budget de connexions et certifier deux répliques avec pannes et rollouts injectés.
4. Certifier la cohorte 1 000, puis seulement publier cette capacité.

## Liens

- [ADR-0002](0002-boucle-agentique-vocale-outils-types.md) — missions Jarvis et outils typés ;
- [ADR-0004](0004-gpt-realtime-publication-mistral-v3-post-v1.md) — fournisseur de publication ;
- [`SPEC_AGENT_MISSIONS_JARVIS.md`](../../design_handoff_bob_pro/SPEC_AGENT_MISSIONS_JARVIS.md) ;
- [`SPEC_BOB_LIVE_CAPACITY.md`](../../design_handoff_bob_pro/SPEC_BOB_LIVE_CAPACITY.md).
