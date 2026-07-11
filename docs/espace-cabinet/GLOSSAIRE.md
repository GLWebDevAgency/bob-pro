# Espace Cabinet — Glossaire (ubiquitous language)

> Langage figé pour le bounded context `cabinet`. Colonne « Existant » : le symbole du repo qui
> porte déjà le concept (à réutiliser via port/ACL, jamais à dupliquer). Rédigé le 2026-07-12,
> source : cahier des charges fondateur (besoins recueillis auprès d'une experte-comptable) ×
> l'état réel du monorepo.

| Terme | Définition métier | Existant dans le repo |
|---|---|---|
| **Cabinet** | Structure d'expertise comptable, tenant racine de l'espace cabinet. Multi-tenant strict. | — (nouveau). Le multi-tenant artisan (RLS `bob_app`, GUC `app.current_company_id`) est le précédent à répliquer côté cabinet. |
| **Collaborateur** | Membre d'un cabinet avec un rôle (`admin` / `manager` / `collaborateur`). | — (nouveau : `CabinetMember`). Auth = Supabase existant (JWT ES256, app_metadata). |
| **DossierClient** | Le dossier d'un client DANS un cabinet : forme juridique, régime fiscal, date de clôture, obligations actives. | Partiel : `CabinetDossier` (apps/web, localStorage — à faire migrer vers l'API) ; `CompanyProps` (core) porte legalForm/vatRegime/dateCreation pour les clients Bob. |
| **RégimeFiscal** | Profil fiscal d'un dossier (micro, réel simplifié, réel normal, IS/IR…) qui active des obligations par défaut. | Partiel : `VatRegime`, `LegalForm` (core) ; `resolveTradeConfig`. Le « RegimeProfile » paramétrable est nouveau. |
| **Obligation** | Type d'obligation déclarative (TVA CA3, CFE, IS acompte, liasse…) défini au **référentiel paramétrable** — jamais hardcodé côté cabinet. | Partiel-fort : `deriveFiscalCalendar` (core) code les règles LÉGALES par défaut, testées et sourcées — il devient le **seed** du référentiel (marqué « à valider par experte-comptable »), le référentiel prend le dessus par overrides. |
| **RègleEchéance** | Règle de calcul d'une date (jour du mois, décalage vs clôture, date fixe, périodicité). Value object. | Partiel : les règles codées de `deriveFiscalCalendar` (art. 1668, 287, 1679 quinquies CGI…) sont les implémentations de référence. |
| **Échéance** | Occurrence datée d'une obligation pour un dossier, MATÉRIALISÉE en base, avec statut, assignation, audit. | Partiel : `FiscalDeadline` (core) est la valeur dérivée ; l'agrégat persisté avec workflow est nouveau. |
| **StatutÉchéance** | `a_faire` / `en_cours` / `fait` / `bloque` — chaque transition horodatée et attribuée. | — (nouveau). Précédent de machine à états : `INBOUND_EINVOICE_TRANSITIONS`, state-machines billing. |
| **Déclaration** | Le dépôt matérialisant une échéance faite ; rattachée en GED. | Partiel : le coffre documents (kinds, versioning, storage Supabase réparé) existe ; le kind « déclaration » et le lien échéance sont nouveaux. |
| **DossierPermanent** | GED par client : statuts, Kbis, RIB… par catégories. | Partiel-fort : `Document`/`DocumentKind`/`StoreDocument` + bucket `bob-documents` (RLS) ; catégories dossier permanent nouvelles. |
| **LettreDeMission** | Contrat cabinet↔client : modèle paramétrable, PDF, cycle brouillon/envoyée/signée, archivée. | Partiel : `mission-letter.ts` (apps/web, structurée+imprimable) ; l'infra signature existe déjà (apps/sign-web, tokens publics, `SignQuote`/`CreateQuoteSignatureToken` comme précédents). |
| **TempsPassé** | `TimeEntry` : timer ou saisie manuelle, flag facturable, par client/mission/période. | — (nouveau). |
| **Honoraires** | Facture du cabinet générée depuis le temps passé, via le **moteur Invoice existant** (port/ACL). | Le moteur complet existe : `Invoice`, `IssueInvoice`, PDF, Factur-X, écritures, numérotation. Zéro duplication. |
| **Prospect** | Pipeline commercial du cabinet : nouveau/relancé/RDV/gagné/perdu, conversion → DossierClient. | — (nouveau). Le lookup SIRET public (C24b) pré-remplira la fiche. |
| **RelationClientCabinet** | Liaison consentie entre un utilisateur Bob (artisan) et un DossierClient d'un cabinet : `requested`/`accepted`/`refused`/`suspended`/`terminated`, scopes par mission. | **Spécifiée** : `apps/web/design/mobile-cabinet-synergy.md` (actée spec officielle, review 2026-07-12) + directive marketplace fondateur (2026-07-11). |
| **Portefeuille** | L'ensemble des DossierClient d'un cabinet (vue dashboard). | Embryon : page `/cabinet` (apps/web). |
| **ÉchéanceOrpheline** | Échéance sans assigné à J-30 : remonte automatiquement au responsable. | — (nouveau). Infra d'alerte réutilisable : jobs cron + notifications C25 (in-app, email Brevo, push). |

## Événements de domaine (alimentent notifications + audit trail)

`ÉchéanceGénérée` · `ÉchéanceAssignée` · `ÉchéanceTerminée` · `ÉchéanceEnRetard` ·
`DéclarationDéposée` · `ProspectConverti` · `RelationDemandée` · `RelationAcceptée` ·
`RelationRefusée` · `LettreDeMissionSignée`.

Précédent d'audit du repo : `logger.audit(...)` structuré (api) — à brancher sur ces événements.
