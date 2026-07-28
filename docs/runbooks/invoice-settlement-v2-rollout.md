# Runbook — activation monotone du règlement facture V2

## But

Le protocole V2 persiste la créance légale, la retenue, les allocations `411/4117`, les lignes
sources et les antécédents immuables. Un binaire N-1 ne connaît pas tous ces faits. Il peut lire et
écrire les pièces V1 pendant la phase `expand`, mais il ne doit jamais recevoir une pièce V2.

La migration `20260721133600_invoice_settlement_semantics_v2` installe donc un singleton global
`invoice_settlement_protocol_state` en version active `1`. Tant que ce rail est fermé, PostgreSQL
refuse toute insertion V2, y compris par un writer privilégié. La migration reste additive et les
writers N-1 continuent à fonctionner.

## Séquence obligatoire

Le seul chemin normatif est le workflow GitHub **Railway API**, `purpose=release`, sur le ref exact
à livrer. Il porte lui-même `github.sha`, `github.run_id`, `github.run_attempt` et l'environnement
attendu ; une activation isolée lancée à la main est interdite.

1. Le workflow exécute le predeploy avec
   `BOB_RELEASE_SHA`, `BOB_RELEASE_RUN_ID`, `BOB_RELEASE_RUN_ATTEMPT` et
   `BOB_RELEASE_EXPECTED_ENV`. Il ferme Bob Live, applique les migrations, certifie les writers
   N-1 et écrit le reçu privé/public du run.
2. Il déploie la révision N, puis refuse de poursuivre tant que la topologie mono-réplique,
   `/health/ready`, le SHA, l'environnement, les capacités et la source d'IP ne correspondent pas.
3. Après l'audit archive, il revalide la même révision et appelle une seule fois
   `activate-release-protocols-v2.sh`. Cet opérateur prouve la paire `DATABASE_URL`/`DIRECT_URL`,
   vérifie le reçu et active Archive, Settlement puis Outbox dans le même snapshot Railway.
4. Il revalide immédiatement la révision, puis exécute le finaliseur postdeploy avec le même
   contexte. Celui-ci prouve l'état terminal et, uniquement si ce SHA vient d'activer Settlement
   V2 en staging, rejoue le certificat comportemental ciblé. Il ne relance pas la suite complète.

Le pipeline Railway suit cet ordre : migration/certification gate fermé → déploiement → readiness
du SHA → topologie mono-réplique → audit → opérateur d'activations unique → certificat final ciblé.

## Propriétés et arrêts obligatoires

- L'activation `1 → 2` est transactionnelle, auditée par SHA et irréversible.
- Une base sans singleton, avec une version inconnue ou avec une ligne V2 préexistante refuse
  l'activation.
- Une fois V2 activé, ne jamais redéployer N-1. Un rollback binaire est interdit : corriger en
  roll-forward avec un writer comprenant V2.
- Si readiness, topologie ou certification échoue avant activation, conserver le gate V1 et
  remettre N-1 en service si nécessaire.
- Si un échec survient après activation, ne pas modifier le singleton. Couper les écritures de
  facturation et livrer un correctif N+1.
- `DIRECT_URL` est l'unique autorité d'activation. Le rôle runtime peut lire l'état mais ne peut
  ni l'insérer, ni le modifier, ni le supprimer.

## Preuves attendues

- reçu predeploy du même SHA/run/environnement/base/configuration, plus sa liaison secrète privée ;
- `RUN_POSTGRES_INVOICE_SETTLEMENT_ROLLOUT_CERT=true` dans le predeploy staging ;
- certificat Settlement V2 postactivation seulement lors du cutover de ce SHA en staging ;
- SHA activé identique à celui renvoyé par `/health/ready` ;
- zéro P0/P1 sur la persistance et le parcours domaine réel.
