# Espace Cabinet — Architecture cible (V3)

> Plan technique du bounded context `cabinet`, assimilé au monorepo réel Bob Pro.
> Rédigé le 2026-07-12 (session A) après gap analysis complète — source de vérité de reprise
> pour tout agent (avec `SLICES.md` et `PROGRESS.md`). Le protocole inter-sessions du repo
> reste `design_handoff_bob_pro/CLAIMS.md` : chaque slice y est aussi tracée (claim `CAB-n`).

## 1. Découverte — l'existant qui change le plan

Le cahier des charges V3 suppose un produit « gestion/facturation vocale » à étendre. La réalité
est plus favorable : Bob Pro possède déjà une **comptabilité en partie double complète** (PCG,
FEC Latin-9, balance, compte de résultat, bilan, revue et dossier de clôture), un **moteur
d'échéances fiscales audité** (`deriveFiscalCalendar` — IS/TVA/CFE/URSSAF/dépôt des comptes,
règles sourcées article par article), un **moteur Invoice complet** (PDF, Factur-X, écritures),
une **GED avec coffre** (Supabase Storage, RLS, versioning), une **infra notifications**
(cron, e-mail Brevo, push Expo, in-app), une **infra signature publique** (apps/sign-web),
un **agent vocal** avec registre d'outils/confirmations, un **multi-tenant Postgres RLS**
éprouvé (rôle `bob_app`, GUC tenant, FORCE RLS), et un **front cabinet v1** (apps/web, Next 16,
100 % local, moteurs core réutilisés).

Conséquence : la mission n'est pas de construire un produit, mais d'ériger le **bounded context
cabinet** au-dessus d'un socle riche — en réutilisant par **ports/ACL** et en ne construisant à
neuf que ce qui est propre au cabinet (tenancy cabinet, référentiel, workflow, temps, CRM,
relation client↔cabinet).

## 2. Décisions structurantes (ADR courts)

### ADR-1 — Où vit le code
- **Domaine + application cabinet** : `packages/core/src/cabinet/{domain,application}` —
  PURS (zéro framework/ORM), testables seuls, conformes aux règles du repo (Result typé,
  TS strict complet). Le core est déjà le foyer de la vérité métier partagée mobile/web/api ;
  le contexte cabinet y est un sous-arbre isolé qui n'importe RIEN des autres contextes
  (billing, expenses…) sauf via ses ports.
- **Infrastructure + interface API** : `apps/api/src/cabinet/` (module NestJS séparé,
  controllers + repositories Prisma + jobs). Schéma Prisma : tables préfixées `cabinet_*`.
- **Interface web** : `apps/web` (l'existant GPT) — migre du localStorage vers l'API slice par
  slice ; le mode « 100 % local » reste un mode dégradé/démo assumé.
- **Côté artisan (slices 12-14)** : apps/mobile + packages/ai, aux points d'intégration définis.

### ADR-2 — Référentiel d'obligations paramétrable × moteur codé (LA réconciliation)
Le cahier des charges interdit toute règle fiscale hardcodée ; le repo possède un moteur codé,
testé et sourcé. Réconciliation : **le référentiel (tables) est l'autorité d'exécution ; le
moteur codé est l'autorité de seed et de contrôle.**
1. `ObligationType` + `RegimeProfile` + `RègleEchéance` vivent en base, CRUD admin (slice 1).
2. Le **seed** du référentiel est GÉNÉRÉ depuis `deriveFiscalCalendar` (les règles légales par
   défaut, marquées `source: 'moteur-bob'` et `aValiderParExpert: true` — exigence du cahier).
3. La génération d'échéances (slice 3) lit le référentiel. Un job de **contrôle de dérive**
   compare périodiquement référentiel ↔ moteur codé et signale les écarts (le moteur reste la
   vigie réglementaire versionnée ; le cabinet garde la main).
4. Aucune date fiscale en dur dans le contexte cabinet : conformité totale au cahier, sans
   jeter deux mois de moteurs audités.

### ADR-3 — Tenancy cabinet
Deux tenants orthogonaux coexistent : `company_id` (artisan) et `cabinet_id` (cabinet).
Même mécanique éprouvée : RLS Postgres par GUC (`app.current_cabinet_id`), policies
`tenant_isolation` sur toutes les tables `cabinet_*`, transactions tenant via l'interceptor
existant (généralisé). Un JWT porte soit un company_id (artisan), soit un cabinet_id + rôle
(collaborateur), soit les deux (dirigeant qui est aussi son cabinet — hors périmètre V3).
La `RelationClientCabinet` (slice 12) est LE pont contrôlé entre les deux mondes — jamais de
lecture croisée sans relation `accepted` + scopes (spec : `mobile-cabinet-synergy.md`).

### ADR-4 — RBAC
Rôles portés par `CabinetMember.role` (admin/manager/collaborateur), vérifiés dans les use
cases (jamais seulement dans les controllers). Matrice testée par slice. Le collaborateur ne
voit que ses dossiers assignés (option cabinet « tout voir »). Référentiel, honoraires et
membres : admin/manager.

### ADR-5 — Feature flags & environnements
Flags minimaux en base (`cabinet_feature_flags` : clé, tenant nullable, on/off) lus par l'API
et le front — pas de SaaS externe. Environnements : la prod Railway existe ; un service
**staging** Railway (même projet, env séparé + base Supabase de staging) est un prérequis
(§8 du cahier) — demandé au fondateur avant la slice 0. Chaîne : CI verte → staging → smoke →
prod (flag off) → smoke → activation progressive.

### ADR-6 — Notifications, GED, signature, honoraires : réutilisation par ports
- Notifications cabinet (slice 6) : port `CabinetNotificationPort` → implémenté par l'infra C25
  (Brevo + push + in-app). Rappels paramétrables J-90/60/30/7 par cabinet et par obligation.
- GED (slice 7) : port `DossierPermanentStoragePort` → `StoreDocument`/bucket existants ;
  nouvelles catégories + rattachement échéance.
- Lettre de mission (slice 8) : cycle signé via l'infra sign-web (tokens publics) — précédent
  `SignQuote`. PDF via le renderer existant.
- Honoraires (slice 10) : port `HonorairesInvoicePort` → `IssueInvoice` (ACL : le domaine
  cabinet ne connaît pas `Invoice`, il émet une demande de facturation).

### ADR-7 — Gouvernance agents
`PROGRESS.md` (ici) = état des slices, lu en début de session par tout agent. `CLAIMS.md` =
protocole inter-sessions inchangé (claim `CAB-n` par slice, logs append-only). Les deux sont
synchronisés à chaque merge de slice. Sessions : A (Claude, coordination + api/core), B (Claude,
en parallèle sur ses claims), C (GPT, apps/web) — périmètres par slice définis dans SLICES.md.

## 3. Contrats API (préfixe `/cabinet`, JWT cabinet + RLS)

```
POST   /cabinet                          crée le cabinet (bootstrap admin)
POST   /cabinet/members  · GET /cabinet/members          invitations + rôles
CRUD   /cabinet/obligations · /cabinet/regime-profiles   référentiel (admin)
CRUD   /cabinet/dossiers                                  DossierClient (+ overrides obligations)
GET    /cabinet/dossiers/:id/echeances                    échéancier matérialisé
POST   /cabinet/echeances/:id/{statut,assignee,commentaire,piece}
GET    /cabinet/dashboard                                 agrégats portefeuille (paginé serveur)
CRUD   /cabinet/rappels                                   config + export ICS
CRUD   /cabinet/dossiers/:id/documents                    dossier permanent
CRUD   /cabinet/lettres-mission                           modèles + cycle + signature
CRUD   /cabinet/temps                                     TimeEntry
POST   /cabinet/honoraires                                temps → facture (port Invoice)
CRUD   /cabinet/prospects  · POST /cabinet/prospects/:id/convertir
POST   /cabinet/relations  · POST /relations/:id/{accepter,refuser,suspendre,cloturer}
```
Erreurs : Result → mapping HTTP existant (`unwrap`), erreurs métier typées.

## 4. Schéma cible (tables `cabinet_*`, RLS partout)

`cabinets` · `cabinet_members` (role, invitedBy, statut) · `cabinet_obligation_types` ·
`cabinet_regime_profiles` (+ table de jointure règles) · `cabinet_dossiers` (siren, forme,
régime, clôture, assignés) · `cabinet_dossier_obligations` (overrides) · `cabinet_echeances`
(dossier, obligation, dueDate, statut, assignee, generationKey UNIQUE — idempotence) ·
`cabinet_echeance_events` (audit append-only : transition, acteur, horodatage) ·
`cabinet_rappels_config` · `cabinet_documents` (catégorie, version, lien échéance nullable) ·
`cabinet_lettres_mission` (modèle, cycle, lien signature) · `cabinet_time_entries` ·
`cabinet_prospects` · `client_cabinet_relations` (statuts spec synergy, scopes JSON,
consentements horodatés) · `cabinet_feature_flags`.
Migrations : expand → migrate → contract, additives d'abord (précédent : toutes les migrations
du repo). Index d'unicité métier systématiques (précédent : `uniq_expense_supplier_invoice`).

## 5. Observabilité & qualité

Logs structurés + `logger.audit` par événement de domaine ; métrique métier par slice
(échéances générées/jour, taux de retard, délai de traitement) via l'endpoint `/metrics`
existant ; couverture domaine cabinet ≥ 90 % (seuil CI — le moteur d'échéances hérite des
tests du moteur core ET ajoute idempotence/changement de régime/bissextiles/fins de mois) ;
**tests d'isolation tenant dédiés par table** (précédent : pont-serveur/subscription-tenant).
NOTE héritée : le logger http écrit parfois 500 quand le filtre renvoie 422 — à corriger en
slice 0 (observabilité de base).

## 6. Risques & garde-fous

1. **Dérive référentiel ↔ loi** : couvert par ADR-2 (job de contrôle + moteur vigie).
2. **Fuite inter-tenant cabinet/artisan** : RLS + tests d'isolation par slice + la relation
   comme unique pont (jamais de lecture directe cross-tenant).
3. **Deux gouvernances (PROGRESS vs CLAIMS)** : ADR-7, synchronisation à chaque merge.
4. **Slices web sans session C** : la session A peut livrer l'API d'une slice et documenter le
   contrat ; le front suit (le flag reste off tant que le parcours e2e n'est pas complet).
5. **Staging inexistant à ce jour** : prérequis bloquant de la slice 0 (voir checkpoint §8).
6. **Seed fiscal** : chaque valeur marquée `aValiderParExpert` — validation par l'experte-
   comptable (la sœur du fondateur) AVANT activation du flag en prod. [STOP] du cahier respecté.
