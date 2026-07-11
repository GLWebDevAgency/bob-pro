# Boucle Bob Pro — indépendant ↔ cabinet

## Intention produit

Le mobile et l’espace cabinet ne sont pas deux produits isolés. Le mobile est le cockpit administratif de l’indépendant, avec parité stricte entre actions manuelles et commandes vocales de Bob. Le web est le poste de production et de révision du cabinet. Les deux surfaces doivent travailler sur les mêmes dossiers versionnés, les mêmes moteurs comptables et un historique commun.

La valeur de la boucle est bidirectionnelle :

1. L’indépendant prépare, contrôle et partage un dossier depuis le mobile.
2. Le cabinet l’accepte dans son portefeuille, le révise et formule des réserves ou demandes de pièces.
3. Bob transforme ces retours en tâches explicables et, lorsque l’action existe, exécutables depuis le mobile par le même use case que l’interface manuelle.
4. Une nouvelle version du dossier est produite ; le cabinet voit précisément ce qui a changé.
5. L’expert-comptable reste le seul acteur qui valide ou signe les travaux relevant de sa responsabilité.

## Relation métier future

La relation ne doit pas être déduite d’un simple accès utilisateur. Elle devient un agrégat métier explicite `ClientCabinetRelationship` :

- `requested` : le client sollicite un cabinet ou accepte une invitation ;
- `accepted` : le cabinet accepte le client et les périmètres de mission ;
- `refused` : le cabinet refuse, avec un motif visible mais sans accès aux données comptables ;
- `suspended` : les échanges sont temporairement gelés sans effacer l’historique ;
- `terminated` : la relation est close, les droits sont retirés et les durées de conservation s’appliquent.

Chaque transition est horodatée, attribuée à un acteur et journalisée. Une acceptation porte sur une mission et des scopes précis, pas sur « toutes les données » par défaut.

## Rôles et scopes

- `client_owner` : choisit le cabinet, consent au partage, révoque les accès compatibles avec la mission et répond aux demandes.
- `cabinet_admin` : gère l’organisation, les collaborateurs, l’acceptation des dossiers et les politiques internes.
- `accountant` : révise les dossiers qui lui sont assignés et émet des demandes.
- `chartered_accountant` : porte les validations et signatures réservées à l’expert-comptable.
- `bob_agent` : prépare, explique et exécute uniquement les actions autorisées, sous les planchers de confirmation existants.

Scopes minimaux envisagés : identité société, pièces, FEC, états financiers, échéancier, demandes de pièces, commentaires, lettre de mission, validation de clôture. Les droits de lecture, contribution, validation et signature restent distincts.

## Dossier partagé versionné

Le partage futur porte sur un `ClosingPackageVersion`, pas sur un dossier mutable sans trace :

- identité et période ;
- FEC matérialisé avec empreinte, encodage et avertissements ;
- note de synthèse et états dérivés ;
- résultat des contrôles de Bob ;
- inventaire des justificatifs sans dupliquer inutilement les pièces ;
- auteur, date, version précédente et motif du nouvel envoi.

Le cabinet répond avec une `ReviewResponse` structurée : contrôle concerné, sévérité, demande, pièce ou compte visé, responsable, échéance et statut. Le mobile projette cette réponse en tâches ; Bob peut les expliquer et proposer les actions disponibles, mais ne masque jamais l’origine cabinet du retour.

## Frontières Clean Architecture

- Le cœur comptable et les machines d’état restent framework-free dans `@bob/core`.
- L’identité, les relations cabinet-client et les politiques d’autorisation deviennent des use cases dédiés, indépendants de Supabase, Next ou Expo.
- Le backend applique le multi-tenant et les scopes à chaque requête ; le client web ne constitue jamais une frontière de sécurité.
- Web et mobile consomment les mêmes contrats d’application via `@bob/api-client`.
- L’agent vocal invoque les mêmes use cases que les boutons, avec journal, dry-run et confirmations.
- Les projections diffèrent par surface : tâches simples et explicables sur mobile ; portefeuille dense, affectations et révision sur web.

## Consentement, sécurité et audit

- Consentement explicite avant le premier partage et lors de toute extension de périmètre.
- Isolation tenant et relationnelle : un cabinet ne découvre pas un client avant demande ou invitation valide.
- Refus = aucune copie persistante du FEC côté cabinet hors obligations légales établies.
- Journal append-only des consultations, téléchargements, demandes, décisions et signatures.
- Révocation des sessions et liens lors d’une suspension ou clôture de relation.
- Chiffrement, durées de conservation, export des données et suppression définis par catégorie de document.
- Authentification renforcée et séparation des rôles pour les actions de validation/signature.

## Modèles de distribution compatibles

Le cœur ne doit dépendre d’aucun des trois modèles suivants :

1. **Cabinet choisi par le client** : annuaire ou invitation, demande puis acceptation bilatérale.
2. **Cabinet partenaire Bob** : Bob propose des partenaires selon critères déclarés ; le client garde le choix et le cabinet garde le droit de refuser.
3. **Marque blanche** : identité visuelle et domaine du cabinet configurables, mais règles comptables, sécurité, traçabilité et responsabilités restent communes et non contournables.

Le modèle commercial devient une configuration et une politique d’entitlements ; il ne change ni le dossier, ni la relation, ni les contrôles comptables.

## Ce lot et les étapes suivantes

Livré dans le lot C-WEB-EC : import FEC local, dérivation des états, portefeuille local versionné, échéancier et lettre de mission. Aucune identité ou synchronisation factice n’est introduite.

Étapes futures nécessaires avant la boucle connectée :

1. ADR domaine pour `ClientCabinetRelationship`, `ClosingPackageVersion` et `ReviewResponse`.
2. Authentification cabinet et modèle RBAC/scopes.
3. API multi-tenant, journal d’accès et stockage documentaire médiatisé.
4. Parcours demande/acceptation/refus et consentement mobile.
5. Projection des retours cabinet en tâches Bob avec parité d’action.
6. Pilote fermé avec un cabinet avant annuaire, marketplace ou marque blanche.
