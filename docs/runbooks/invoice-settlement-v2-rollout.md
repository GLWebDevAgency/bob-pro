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

1. Appliquer les migrations et RLS avec l'ancien processus encore disponible. `release.sh`
   certifie alors que V1 reste insérable et que V2 est fermé.
2. Déployer la révision N. Ne pas activer V2 tant que `/health/ready` ne renvoie pas son SHA exact.
3. Certifier qu'une seule réplique applicative est active et que l'ancienne révision est retirée.
4. Exécuter, avec le SHA complet de la révision certifiée :

   ```sh
   INVOICE_SETTLEMENT_V2_ACTIVATION_RELEASE_SHA="$RELEASE_SHA" \
     sh apps/api/scripts/activate-invoice-settlement-v2.sh
   ```

5. Rejouer `release.sh`. Il détecte V2 et exécute la certification PostgreSQL complète avec le
   rôle runtime `NOSUPERUSER/NOBYPASSRLS`.

Le pipeline Railway suit cet ordre : migration/certification gate fermé → déploiement → readiness
du SHA → topologie mono-réplique → activation → certification V2.

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

- `RUN_POSTGRES_INVOICE_SETTLEMENT_ROLLOUT_CERT=true` avant activation ;
- `RUN_POSTGRES_INVOICE_SETTLEMENT_CERT=true` après activation ;
- SHA activé identique à celui renvoyé par `/health/ready` ;
- zéro P0/P1 sur la persistance et le parcours domaine réel.
