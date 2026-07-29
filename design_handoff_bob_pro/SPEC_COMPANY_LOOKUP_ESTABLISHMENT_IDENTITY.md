# SPEC — Identité d’établissement issue de l’annuaire

Date : 2026-07-29
Statut : `implemented`
Objectifs : O6 (vérité des données), O4 (même identité exploitable par tous les canaux), O7
(release reproductible)

## Pourquoi

Un SIREN identifie une unité légale. Un SIRET identifie l’établissement réellement facturé.
Renvoyer le siège quand l’utilisateur a choisi un établissement secondaire, reprendre l’adresse
de la fiche précédente, ou perdre le SIRET après l’enregistrement crée une identité incohérente
entre l’écran, la base et les futures pièces.

Le lookup public reste une aide à la saisie fondée sur l’annuaire officiel. Il ne prouve pas à lui
seul qu’une société contrôle l’établissement et ne remplace aucune vérification réglementaire.

## Périmètre

- Recherche exacte d’un SIREN ou SIRET dans l’adapter Recherche d’entreprises.
- Données de l’établissement retenu : SIRET, adresse, activité principale et état administratif.
- Application atomique et corrélée du résultat dans le formulaire client.
- Persistance additive du SIRET client dans le domaine, PostgreSQL, l’API et le client mobile.
- Avertissement accessible lorsqu’un établissement est déclaré fermé, dans le formulaire client,
  l’inscription et le provisioning.
- Décodage strict du résultat `/company/lookup` à la frontière HTTP.

## Invariants

1. Une requête SIRET rend exactement ce SIRET ou `not_found`. Elle ne retombe jamais sur le siège.
2. Le SIRET rendu commence par le SIREN rendu, quel que soit le type d’établissement. Toute
   contradiction amont devient une erreur de dépendance nommée.
3. L’adresse et le code NAF proviennent de l’établissement retenu. S’ils sont absents, la valeur
   est `null`; aucune donnée du siège ou d’une fiche précédente ne les remplace.
4. L’état d’un établissement suit le vocabulaire SIRENE : `A` = actif, `F` = fermé. `null` signifie
   que la source ne le publie pas. Un établissement fermé reste sélectionnable, mais l’interface
   l’annonce avant confirmation.
5. Une réponse asynchrone n’est appliquée que si le SIRET demandé, le SIRET encore affiché et le
   SIRET rendu sont identiques. Une réponse périmée est ignorée; une réponse contradictoire échoue
   fermée.
6. Un résultat sans adresse efface toute adresse précédemment liée au lookup, rouvre la saisie
   manuelle et affiche honnêtement l’absence. Le formulaire peut conserver le mode « fiche
   minimale » déjà autorisé par le produit, mais ne soumet jamais l’adresse d’une autre identité.
7. Le SIRET client est nullable pour les données historiques et les clients sans établissement
   connu. Il n’est jamais dérivé d’un SIREN. Lorsqu’il existe, le domaine et PostgreSQL garantissent
   sa forme et sa cohérence avec le SIREN.
8. L’état administratif n’est pas persisté : il peut changer. Toute interface qui l’affiche utilise
   la réponse courante de l’annuaire et ne transforme jamais une absence en état actif.
9. Le contrat HTTP accepte l’absence du nouveau champ d’état comme compatibilité N-1 (`null`), mais
   rejette toute forme ou valeur inconnue au lieu de caster le JSON.
10. Aucune fixture ou valeur d’annuaire n’entre dans un chemin de production. Les doubles restent
    cantonnés aux adapters locaux/tests et sont exclus des artefacts de production.

## Critères d’acceptation binaires

- [x] A1 — Un SIRET secondaire réel/fixture est résolu exactement avec son adresse et son NAF,
      différents de ceux du siège/unité légale.
- [x] A2 — `F` déclenche l’avertissement fermé; `A` ne le déclenche pas; une autre valeur devient
      `null` côté adapter et échoue au décodage HTTP si elle vient du serveur Bob.
- [x] A3 — Une incohérence SIREN/SIRET du siège ou d’un secondaire est refusée comme dépendance.
- [x] A4 — Une réponse tardive pour A ne modifie aucun champ après que l’utilisateur a saisi B.
- [x] A5 — Un lookup sans adresse efface l’ancienne adresse, rouvre la saisie et ne peut jamais
      soumettre l’adresse de l’identité précédente.
- [x] A6 — Le SIRET traverse création, mise à jour, persistance, liste, réhydratation et réouverture
      de la fiche sans être perdu ni inventé.
- [x] A7 — Les lignes historiques sans SIRET restent lisibles/éditables; un writer N-1 peut encore
      insérer une ligne sous le schéma final.
- [x] A8 — Formulaire client, inscription et provisioning affichent l’avertissement fermé avec une
      encre AA et une annonce VoiceOver/TalkBack.
- [x] A9 — Le client HTTP décode explicitement chaque champ du lookup et refuse les identités ou
      types malformés.
- [ ] A10 — Tests ciblés core, adapter, API client, mobile et PostgreSQL verts; typechecks concernés
      verts; CI complète verte sur le SHA rebasé.

## Migrations

1. `expand` : colonne `customers.siret CHAR(14) NULL`, contraintes de forme et de cohérence
   `NOT VALID`, avec `lock_timeout` et `statement_timeout`.
2. `validate` séparée : validation des contraintes sans réécriture ni valeur par défaut.
3. Aucun backfill : déduire un SIRET depuis le SIREN ou l’adresse fabriquerait une donnée.

## Non-objectifs de cette PR

- Recherche par raison sociale et création vocale de client : vertical distinct, à rebaser après
  fusion de cette PR.
- Rejet automatique d’un établissement fermé.
- Persistance d’un état administratif mutable.
- Déduction d’un SIRET depuis une adresse, un SIREN ou le contexte LLM.
- Déploiement production. La PR doit d’abord être fusionnée après CI; les migrations suivent le
  rituel staging puis production du train de release.

## Definition of Done

- Tous les critères A1–A10 sont prouvés par des tests appelés.
- Les migrations sont additives, séparées et testées avec un writer N-1.
- Aucune chaîne visible nouvelle hors i18n, aucun token visuel en dur, zones tactiles existantes
  conservées et alertes dynamiques annoncées.
- `git diff --check`, tests ciblés, typechecks concernés et CI GitHub complète sont verts sur le
  commit exact.
- La PR est rebasée sur `origin/main`, revue adversarialement, fusionnée, puis le claim est libéré.
