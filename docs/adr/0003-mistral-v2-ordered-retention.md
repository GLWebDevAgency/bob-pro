# ADR-0003 : Bob Live Mistral v2 — rétention ordonnée et fail-closed

## Statut

Accepted — 2026-07-19. Le candidat final a été certifié depuis une base PostgreSQL vierge selon
deux preuves complémentaires. Le rituel réel, avec son autorité de migration `DIRECT_URL` réservée
au déploiement, passe 71/71 migrations puis 67/67 scénarios de mutation et de concurrence avec
le rôle runtime réel sous RLS forcée. Le sous-rituel de provisioning/ACL est en plus rejouable avec
un administrateur `CREATEROLE`, non-superuser et sans `BYPASSRLS`, après installation du schéma.
La capacité live v2 reste néanmoins fermée selon les gates distincts de
l'[ADR-0001](0001-bob-live-mistral-conversation-v2.md).

## Contexte

Les preuves d'une conversation Mistral v2 partagent un horizon de rétention mais résident dans
plusieurs tables : bootstrap initial, Mission, capacités de reprise, outbox chiffrée et ledger de
commandes. Le SQL historique purgeait uniquement les bootstraps expirés. La cartographie du schéma
a révélé trois risques bloquants :

- `Mission.initialBootstrapId` était unique sans FK vers le bootstrap tenant-bound ; une preuve
  bootstrap pouvait donc disparaître alors que sa Mission restait conservée ;
- le DELETE d'un lease `mcv2:` exige la Mission fermée et ses deux événements terminaux exacts.
  Supprimer l'outbox ou la Mission avant ce lease le rendrait orphelin et indélébile.
- un mobile peut rester hors ligne au-delà de la grâce et de la rétention. Si la Mission et son
  outbox disparaissent sans preuve terminale survivante, son checkpoint sécurisé ne peut plus
  distinguer une fermeture certaine d'une session inconnue et bloque toute nouvelle mission.

Les artefacts vocaux audités, grants/consommations de contrôle, événements d'usage/facturation et
événements d'admission ont des horizons propres (jusqu'à 31, 36 ou 400 jours selon la table). Ils
ne sont pas des enfants de Mission et ne doivent pas être supprimés par ce chantier.

## Décision

### Intégrité et éligibilité

Une FK composite `Mission(companyId, initialBootstrapId) -> Bootstrap(companyId, id)` avec
`ON DELETE RESTRICT` est ajoutée en expand-only (`NOT VALID`, puis validation séparée). Aucun
bootstrap référencé par une Mission ne peut ensuite être supprimé, même par l'ancien reaper.

Une Mission est éligible uniquement si toutes les conditions suivantes sont vraies selon
`clock_timestamp()` PostgreSQL :

1. `phase = 'closed'` avec les invariants terminaux existants ;
2. `replayGraceExpiresAt <= now` ;
3. `retentionExpiresAt <= now` ;
4. son bootstrap exact est lui aussi arrivé à rétention ;
5. un reçu terminal minimal existe et correspond exactement à son tenant, propriétaire HMAC,
   protocole, epoch, curseur final, raison et horodatage de fermeture ;
6. aucun lease d'admission portant le `sessionId` initial ne subsiste.

Une Mission expirée mais non fermée, ou encore liée à un lease, reste conservée et produit un
signal d'observabilité. Le reaper de rétention ne termine jamais un fournisseur et ne supprime
jamais un lease : cette autorité reste celle du reaper d'admission avec confirmation de hangup.

### Ordre transactionnel

Chaque racine est purgée atomiquement dans cet ordre :

1. verrou bootstrap tenant-bound ;
2. verrou advisory de la Mission, identique aux writers ;
3. verrou de toutes les capacités de reprise ;
4. verrou et revalidation de la Mission ;
5. vérification du reçu terminal exact ;
6. preuve d'absence du lease initial ;
7. DELETE `resume_tickets`, `commands`, `outbox` ;
8. DELETE Mission ;
9. DELETE bootstrap initial, en conservant le reçu.

Le verrou bootstrap ferme les nouvelles réconciliations. Le verrou advisory ferme les nouveaux
writers standard. Si une capacité est déjà verrouillée, le candidat est abandonné via une
sous-transaction afin de libérer immédiatement tous ses verrous. La sélection est bornée et utilise
`SKIP LOCKED` ; plusieurs répliques peuvent donc travailler sans double suppression.

La sélection sépare deux pools bornés. Le premier cherche directement des racines réellement
purgeables (reçu exact, aucun lease, aucun enfant dont la rétention est future) et passe avant le
préfixe diagnostique des plus anciennes racines bloquées. Plus de huit batches de lignes
empoisonnées ne peuvent donc pas affamer indéfiniment une racine saine plus récente. Toutes les
conditions du préfiltre restent revalidées sous verrous : il améliore la progression sans devenir
une nouvelle autorité de suppression.

Les bootstraps expirés sans Mission sont purgés dans le reliquat du même batch. Toute violation de
FK, dérive de rôle ou résultat SQL incohérent échoue fermée ; aucune exception FK n'est avalée.

### Reçu terminal durable et convergence hors ligne

La fermeture `closed` grave atomiquement une projection append-only dans
`realtime_mistral_conversation_terminal_receipts`. Elle ne contient ni audio, ni transcription,
ni commande, ni payload agent, ni identifiant utilisateur brut : uniquement tenant, handle opaque,
pseudonyme propriétaire versionné, protocole, epoch, curseur terminal exclusif, raison et dates.
Le backfill des Missions déjà fermées utilise le même contrat exact et bloque la migration à la
première divergence.

Le trigger de capture est créé avant le backfill. Le verrou DDL acquis sur Mission sérialise cette
installation avec toute fermeture concurrente : une transaction déjà engagée devient visible au
backfill, et une fermeture ultérieure exécute obligatoirement le trigger. Il n'existe ainsi aucune
fenêtre de déploiement entre la photographie historique et l'activation de la capture.

Le reçu est immuable : le runtime n'a qu'un SELECT tenant-bound, le trigger `SECURITY DEFINER` est
la seule autorité d'insertion, et UPDATE, DELETE direct et TRUNCATE sont refusés. Il survit à la
purge Mission ; seule la suppression de la société peut le retirer par cascade. Aucun TTL autonome
n'est appliqué dans ce lot : une expiration silencieuse recréerait le checkpoint mobile
irrécupérable que cette preuve supprime. Une éventuelle politique de durée devra donc livrer dans
le même lot une preuve serveur de péremption owner-bound consommable par le mobile.

Après disparition de Mission, la route HTTP authentifiée relit le reçu sous RLS et ne renvoie
`terminal_complete` que si le tenant, le sujet HMAC/versionné, le handle, le protocole et les bornes
monotones correspondent. Le mobile revalide encore cette forme exacte, écrit d'abord un checkpoint
`closed`, puis efface SecureStore avec cette preuve. Une réponse perdue reste ainsi rejouable.

### Autorité et audit

Le rôle NOLOGIN existant `bob_mistral_bootstrap_reaper` devient l'autorité minimale de cette
rétention ordonnée et possède, dans cette base, exactement les deux fonctions de purge. La
connexion API reste le rôle runtime non privilégié : elle n'est jamais membre du reaper, ne peut
pas faire `SET ROLE` et ne reçoit aucun DELETE direct sur les six registres de rétention ni aucun
`TRUNCATE` sur les sept
tables concernées. Elle possède seulement EXECUTE sur les deux fonctions, après révocation de
PUBLIC. Ces fonctions `SECURITY DEFINER` ont un `search_path` réduit à `pg_catalog`
et forcent `row_security=on` ; leur owner NOLOGIN reçoit seulement les colonnes SELECT nécessaires,
`UPDATE(id)` pour les row-locks et DELETE sur les cinq tables de preuve. Il ne reçoit aucun accès
table ni colonne aux artefacts vocaux, contrôles, usages ou événements d'admission.

Le boot échoue fermé si l'owner, la configuration des fonctions, les ACL exactes de cette
frontière (owner/reaper, runtime et PUBLIC), l'absence de droits table/colonne accordés à PUBLIC,
les sept relations et leurs colonnes attendues, `USAGE` sans `CREATE` sur le schéma, FORCE RLS ou
l'absence de membership runtime — même sans droit `SET`
immédiat — dérivent. Le rituel de déploiement est rejouable : transfert d'ownership initial puis
reconfiguration en endossant uniquement l'owner via DIRECT_URL, sans réintroduire cette capacité
dans le processus API.

La release complète garde aujourd'hui l'autorité de migration dans son environnement pendant tout
le train ; cette autorité est nécessaire aux backfills historiques exécutés sous RLS forcée. Le
runtime ne reçoit jamais ce secret. Le durcissement opérationnel suivant devra isoler deux jobs et
deux injections de secrets : migration éphémère avec `BYPASSRLS`, puis provisioning non-superuser
sans secret de migration. Ajouter deux variables au même processus ne réduirait pas ce rayon
d'explosion.

Le rôle reaper ne peut que lire le reçu lié à une Mission effectivement éligible ; il ne peut ni
l'insérer, ni le modifier, ni le supprimer. Le rôle runtime ne reçoit aucune mutation sur cette
table et sa lecture reste soumise à `app.current_company_id` sous `FORCE ROW LEVEL SECURITY`.

Le scheduler émet un audit structuré avec les nombres supprimés, sans transcript, ciphertext,
identifiant utilisateur ni token. Les preuves cryptographiques sont conservées jusqu'à leur
`retentionExpiresAt`; les tables d'usage/facturation et d'audit distinctes conservent leur propre
cycle de vie après la suppression de Mission.

## Critères d'acceptation binaires

- [x] Une Mission sans bootstrap exact ne peut plus être créée ni validée historiquement.
- [x] Aucune Mission n'est supprimée avant grâce, rétention et fermeture terminale.
- [x] Aucune Mission n'est supprimée sans reçu terminal exact ; le reçu survit ensuite à la purge.
- [x] Le reçu est créé atomiquement à la fermeture, backfillé exactement et immuable hors cascade
      de suppression Company.
- [x] Un mobile hors ligne converge via le reçu owner-bound après purge Mission, sans fast-forward
      de curseur invalide ni suppression préalable de son checkpoint.
- [x] Un lease résiduel bloque Mission et outbox ; après sa suppression autorisée, le prochain
      sweep purge le groupe complet.
- [x] Deux reapers concurrents ne purgent chaque racine qu'une fois et ne produisent aucun trou FK.
- [x] Une écriture/reprise concurrente fait sauter le candidat, sans deadlock ni suppression.
- [x] Un préfixe supérieur à huit batches de racines bloquées n'affame pas une racine saine plus
      récente.
- [x] Une fermeture Mission concurrente à la migration reçoit toujours son reçu : par le backfill
      ou par le trigger déjà installé, jamais par aucun des deux.
- [x] Un tenant ne rend jamais les lignes d'un autre tenant visibles au rôle runtime.
- [x] Les anciens bootstraps orphelins expirés restent purgeables.
- [x] Artefacts vocaux, contrôles, usage/facturation et événements d'admission restent intacts.
- [x] La rotation des clés reste bloquée tant qu'une ligne conservée existe et se débloque seulement
      après le DELETE effectivement commité.
- [x] Migration, rôle, RLS, scheduler, circuit breaker et shutdown sont certifiés sur PostgreSQL réel.

## Conséquences

La suppression d'une Mission devient plus coûteuse mais atomique et bornée par un petit nombre de
racines. Un incident de terminalisation ou de hangup peut retarder la rétention ; c'est un choix
fail-closed explicite, visible dans les métriques/logs, plutôt qu'une perte de preuve. La FK peut
faire échouer sa validation si une ancienne purge a déjà créé un orphelin logique : aucune donnée
ne sera inventée automatiquement, une remédiation humaine sera alors obligatoire.

Le reçu terminal devient une donnée pseudonymisée de durée de vie Company. La rotation du secret
HMAC sujet ne doit pas rendre ces preuves inaccessibles : toute version encore référencée doit
rester disponible dans le keyring sujet, et son retrait doit être refusé tant que la base la retient.

## Relation

Complète [ADR-0001](0001-bob-live-mistral-conversation-v2.md), en particulier ses contrats de
replay terminal, d'outbox immuable et de terminaison provider-neutral.
