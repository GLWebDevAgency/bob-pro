# Espace Cabinet — Carte des slices (V3) × existant réel

> Gap analysis du 2026-07-12 : chaque slice du cahier des charges, son **statut réel** dans le
> monorepo, ce qui reste à construire, et le claim protocole (`CAB-n`). Ordre du cahier conservé.
> Légende statut : ✅ couvert · 🟡 partiel · ⬜ à construire.

| # | Slice | Statut | Déjà là (réutiliser, ne pas dupliquer) | Reste à construire |
|---|---|---|---|---|
| 0 | Fondations & rails | 🟡 | Multi-tenant RLS éprouvé (précédent artisan), auth Supabase, CI verte, logs/audit/health/metrics, deploy Railway | Tables `cabinets`/`cabinet_members` + RBAC, GUC `app.current_cabinet_id` + policies, feature flags minimal, **env staging** (prérequis humain), fix log 500/422 |
| 1 | Référentiel d'obligations | 🟡 | `deriveFiscalCalendar` audité (TVA CA3/CA12, IS acomptes/solde, CFE, URSSAF micro, dépôt comptes — sourcé) = **seed** marqué « à valider par experte-comptable » | Tables ObligationType/RegimeProfile/RègleEchéance, CRUD admin (web), job de contrôle de dérive référentiel↔moteur (ADR-2) |
| 2 | Dossiers clients | 🟡 | `CabinetDossier` (web, localStorage — migrer), lookup SIRET public (fiche auto), types core LegalForm/VatRegime | `cabinet_dossiers` en base + activation d'obligations par régime + overrides + fiche client API |
| 3 | Génération d'échéances | 🟡 | Le moteur de dates (pur, testé : bissextiles, bornes, passage d'année) | Matérialisation `cabinet_echeances` (generationKey UNIQUE = idempotence), job 18 mois glissants, recalcul au changement de régime (tests exhaustifs exigés) |
| 4 | Workflow d'équipe | ⬜ | Précédents : machines à états du repo, `logger.audit`, coffre pour pièces jointes | Statuts a_faire/en_cours/fait/bloque + transitions horodatées/attribuées (audit append-only), assignation, commentaires, RBAC testé |
| 5 | Dashboard & alertes | 🟡 | Page portefeuille web v1, agrégats serveur (précédents dashboard mobile) | Calendrier global toutes échéances/clients, filtres serveur paginés (200 clients × 18 mois), alerte « orpheline J-30 » |
| 6 | Rappels & notifications | 🟡 | **Toute l'infra C25** : cron multi-tenant, e-mail Brevo (secret à poser), push Expo, in-app, deep links | Config par cabinet/obligation (J-90/60/30/7), export ICS, branchement des événements de domaine |
| 7 | GED dossier permanent | 🟡 | Coffre complet : `StoreDocument`, bucket RLS (storage RÉPARÉ le 11/07), versioning, kinds, liaison entités | Catégories dossier permanent (statuts/Kbis/RIB…), rattachement échéance↔déclaration, prévisualisation PDF web |
| 8 | Lettre de mission | 🟡 | `mission-letter.ts` (web, structurée+imprimable), renderer PDF, **infra signature publique** (sign-web, tokens) | Modèles paramétrables, cycle brouillon/envoyée/signée, archivage dossier permanent, validation juridique du modèle (humain) |
| 9 | Temps passé | ⬜ | — | TimeEntry (timer + manuel), flag facturable, récap client/mission/période |
| 10 | Facturation honoraires | 🟡 | **Moteur Invoice complet** (émission, PDF, Factur-X, écritures, numérotation) | Port/ACL `HonorairesInvoicePort` + parcours temps→facture (zéro duplication du moteur) |
| 11 | Mini-CRM prospects | ⬜ | Lookup SIRET public pour pré-remplir | Pipeline nouveau/relancé/RDV/gagné/perdu, rappels, conversion 1-clic → DossierClient |
| 12 | Liaison client↔cabinet | 🟡 | **Spec officielle écrite** : `mobile-cabinet-synergy.md` (RelationClientCabinet 5 états, scopes, consentement bilatéral) + directive marketplace fondateur (11/07) + dossier de clôture/FEC exportables côté mobile | Tables + API relations, invitation/acceptation/refus, partage de dossier par l'API (fin du pont FEC manuel), vue partagée |
| 13 | Vulgarisation & support | 🟡 | **Largement fait côté artisan** : explains voix Bob partout (dispo prudent, provision URSSAF, pénalités, prescription), pilotage SIG/DSO (session B) | Point d'entrée support humain visible (routage vers le cabinet lié — synergie avec slice 12) |
| 14 | Commande vocale étendue | 🟡 | **Agent Bob complet** : registre d'outils, intents, confirmations, parité humain↔IA éprouvée (10+ outils) | Actions cabinet (changer statut, note, saisir temps) + actions client liées au cabinet |

## Ordre d'exécution & sessions

L'ordre 0→14 du cahier est conservé (fondations d'abord). Attribution par défaut :
- **Session A (Claude)** : slices 0–4, 6, 10, 12 (api/core/prisma — cœur tenancy/moteurs).
- **Session C (GPT, apps/web)** : volet front des slices 1, 2, 5, 7, 8, 11 (+ corrections design
  ①–⑤ de la review C-WEB-EC en préalable : tokens, typo Schibsted/Hanken, CTA navy, tsconfig, i18n).
- **Session B (Claude)** : libre selon ses claims ; slices 13–14 (mobile/ai) en naturel.
Chaque slice = claim `CAB-n` au protocole CLAIMS.md + rapport dans PROGRESS.md (ADR-7).

## Écarts assumés vs cahier des charges

1. **Pas de télétransmission EDI/DGFiP** (interdit du cahier — conforme).
2. Le « moteur de règles 100 % données » est tempéré par l'ADR-2 (seed + vigie codée) : plus
   sûr que du pur paramétrable, conforme à l'esprit (l'admin modifie sans toucher au code).
3. Intégrations Google/Outlook : export ICS seulement (conforme au cahier).
4. La V1 web « 100 % local » reste un mode démo après migration API (décision produit tracée).
