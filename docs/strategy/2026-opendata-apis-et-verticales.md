# Note — APIs Open Data FR & nouvelles verticales métiers

**Bob Pro — copilote admin/financier artisans/indépendants/TPE**
*Synthèse opérationnelle (juin 2026), issue d'un panel de recherche multi-agents avec recherche web live.*

---

## 1. APIs Open Data FR retenues

| API | URL | Auth | Coût | Usage Bob Pro | Priorité |
|---|---|---|---|---|---|
| **Recherche d'entreprises** | `recherche-entreprises.api.gouv.fr` | Aucune | Gratuit (7 req/s) | Autofill SIRET onboarding + création client : renvoie **en 1 appel** dénomination, NAF/APE, adresse, **n° TVA intracom**, dirigeants, **RGE** | **P1 — pilier** |
| **BAN (Base Adresse Nationale)** | `api-adresse.data.gouv.fr` (→ migration IGN/Geoplateforme) | Aucune | Gratuit (50 req/s) | Autocomplétion adresse société/client/**chantier** | **P1** |
| **VIES (TVA intracom UE)** | `ec.europa.eu/taxation_customs/vies/` (SOAP) | Aucune | Gratuit | **Confirmer** l'activité d'un n° TVA + Consultation Number (preuve e-invoicing) | **P1** |
| **INSEE Sirene** | `portail-api.insee.fr` (v3.11) | Token portail INSEE | Gratuit (30 req/**min**) | Fallback autoritatif si Recherche d'entreprises manque/KO | **P2** |
| **ADEME — Professionnels RGE** | `data.gouv.fr/dataservices/api-professionnels-rge` | Aucune | Gratuit | Vérif qualification RGE pro/sous-traitant (Pack BTP, éligibilité MaPrimeRénov/CEE) | **P2** |
| **INPI / RNE** | `data.inpi.fr` | Compte INPI | Gratuit | Enrichissement avancé : forme juridique, dirigeants, bénéficiaires effectifs, bilans publics | **P3** |
| ~~API Entreprise~~ | `entreprise.api.gouv.fr` | **Habilitation administration** | — | **NON éligible SaaS privé** — à exclure | **Exclue** |

> **Insight clé** : le n° TVA FR est **dérivable hors-ligne** depuis le SIREN (déjà Luhn-validé dans le domaine, fonction `frenchVatNumber` déjà présente) : `FR + (12 + 3×(SIREN mod 97)) mod 97 + SIREN`. On pré-remplit instantanément, sans réseau ; VIES sert uniquement à confirmer l'activité réelle.

---

## 2. Architecture d'intégration (pattern Ports + Adapters)

Réutilisation stricte du pattern déjà en place (`OcrPort`, `PaymentGatewayPort`, `LlmPort`) : un port domaine dans `@bob/core`, un adapter **demo déterministe** (offline/tests) + un adapter **réel** sélectionné par env, exposés via la façade `@bob/api-client`.

### Ports à créer
```
company-lookup.ts        → lookupBySiret(siret): CompanyLookupResult
                            { siren, siret, denomination, nafApe, trade, address, tvaIntracom, rge }
vat-validation.ts        → derive(siren): string (pur)  +  confirm(tva): VatStatus (VIES + consultationNumber)
address-autocomplete.ts  → search(query): AddressSuggestion[]
rge-verification.ts      → verifyBySiret(siret): RgeQualification[]   (Pack BTP)
```

### Adapters
| Port | Adapter réel | Adapter demo |
|---|---|---|
| CompanyLookup | `RechercheEntreprisesAdapter` (+ fallback `InseeSireneAdapter`) | `DemoCompanyLookupAdapter` |
| VatValidation | `ViesVatAdapter` + dérivation pure | `DemoVatAdapter` |
| AddressAutocomplete | `BanAddressAdapter` (**base URL env-driven**) | `DemoAddressAdapter` |
| RgeVerification | `AdemeRgeAdapter` | `DemoRgeAdapter` |

### Use cases
- `AutofillCompanyFromSiret` — Luhn → CompanyLookup → mappe NAF→`resolveTradeConfig` (pré-sélection métier) + défaut TVA.
- `ValidateVatNumber` — dérive → VIES confirm → statut `verifie | non_verifie | invalide` (jamais bloquant).
- `EnrichClientOnCreate` — SIRET optionnel : si fourni, autofill silencieux.
- `VerifyRgeQualification` — Pack BTP.

### Branchements UX
- **Onboarding** : champ SIRET → autofill dénomination/adresse/TVA **et pré-sélection du profil métier via NAF**.
- **Création client** : SIRET optionnel → enrichit dénomination + adresse.
- **Adresse** (société/client/chantier) : autocomplétion BAN.
- **Facturation/Factur-X** : n° TVA dérivé + statut VIES + Consultation Number archivé (~7 ans) pour autoliquidation BTP.

### Anti-quota / anti-panne (transverse)
- **Luhn AVANT tout appel** (VO domaine déjà présente) — économise le quota.
- **Cache** `SIRET→profil` / `TVA→statut` avec TTL.
- Respect `429 / Retry-After` (Recherche d'entreprises) et 30 req/min (INSEE).
- VIES instable (`MS_UNAVAILABLE` 15-60 min) → retry + cache + **dégradation gracieuse** (`non_verifie`, jamais de blocage facturation).
- Adapters demo en fallback si une API étatique tombe (pas de SLA).

---

## 3. Quick wins à coder d'abord (ROI)

| # | Quick win | Effort | ROI |
|---|---|---|---|
| **1** | **Autofill SIRET onboarding** (`CompanyLookupPort` + Recherche d'entreprises) | Faible (1 API, sans token, 1 appel) | **Élevé** : supprime la saisie manuelle, pré-sélectionne le métier via NAF, réduit le drop-off. Renvoie déjà TVA + RGE. |
| **2** | **Dérivation + validation TVA** (`VatValidationPort`) | Faible (dérivation) + moyen (VIES) | **Élevé** : pré-remplit la TVA hors-ligne ; alimente Factur-X + autoliquidation BTP ; Consultation Number = preuve. |
| **3** | **Autocomplétion adresse BAN** | Faible | **Moyen-élevé** : adresses normalisées, moins d'erreurs de facture. |

---

## 4. Nouveaux métiers / verticales

> Cibler les profils par **NAF** (déjà renvoyé par Recherche d'entreprises). Brique transverse à mutualiser : **indemnités kilométriques** (port + adapter barème URSSAF versionné par millésime) → réutilisée par VTC, taxi, IDEL/kiné, beauté à domicile, mandataire immo.

| Métier | Volume FR (2024-25) | Profil gratuit | Add-on payant | Modules clés |
|---|---|---|---|---|
| **VTC** | ~78k inscrits, ~71k actifs (+27%/an) | Oui | **Pack Mobilité/VTC** | Frais km, carburant/péages, redevance plateforme, rapprochement Uber/Bolt, arbitrage franchise vs réel (déduction TVA véhicule) |
| **Beauté** (coiffure/esthétique/onglerie) | >140k établ. (31k coiffeurs micro + >50k esthé à domicile) | Oui | **Pack Beauté** | Caisse/TPE mobile, double seuil TVA vente+service, RDV, prestations à domicile + IK, fidélité |
| **Santé libérale** (IDEL/kiné) | ~145k IDEL + kinés | Oui — bascule **exonération TVA** | **Pack Tournées Santé** | IK/IFA tournées, rétrocessions/remplacements, BNC déclaration contrôlée |
| **Immobilier** (mandataire) | ~48-60k, CA moyen ~40k€ | Oui | **Pack Mandataire** | Commissions par mandat, encaissement à l'acte, rétrocessions réseau à paliers, prévisionnel tréso sur pipeline |
| **Taxi** | Marché distinct du VTC | Oui | **Extension** du Pack Mobilité | Réutilise 90% du code VTC + module Licence ADS (amortissement/cession/location-gérance TVA 20% récup.) |
| Chauffagiste / menuisier / couvreur / carreleur / plaquiste | — | Oui | **Pack BTP existant** | m²/surfaces, RGE, décennale par upload+OCR |
| **Livreurs/coursiers** | Forte croissance mais churn massif (2/3 inactifs <2 ans) | Oui (léger, acquisition) | **PAS d'add-on dédié** | Convertir vers Pack Mobilité s'ils montent en VTC |

**Ordre de lancement** : 1) VTC → 2) Beauté → 3) Santé libérale → 4) Immobilier mandataire → 5) Taxi (extension) → BTP étendu en parallèle.

---

## 5. Ce qu'il NE faut PAS faire
- **Ne pas viser API Entreprise** : habilitation administration, non éligible SaaS privé.
- **Ne jamais bloquer la facturation sur un VIES KO** : marquer `non_verifie`.
- **Ne pas hardcoder l'URL BAN** : migration IGN/Geoplateforme, garantie seulement jusqu'à janv. 2026 → base URL env-driven.
- **RGE ≠ décennale** : la décennale n'a pas d'API publique → upload + `OcrPort` existant.
- **TVA dérivée ≠ TVA active** : croiser avec le régime TVA du domaine et/ou VIES avant usage e-invoicing.
- **Santé : pas de télétransmission/NGAP/cotation** (marché verrouillé par logiciels agréés).
- **E-commerce : pas un add-on léger** (achat-revente, seuil 85k€, stock, OSS intracom) → roadmap V2 séparée.
- **Food-truck / artisans de bouche : hors-cible court terme** (volume modeste, caisse certifiée anti-fraude).
- **Livreurs : pas d'add-on payant** (churn + faible solvabilité). Suivre le **LTV par profil**.
- **RGPD** : dirigeants, bénéficiaires effectifs, adresses = données personnelles → conservation/base légale/minimisation.

---

## 6. Roadmap priorisée
- **Phase 1 — MVP enrichissement (gratuit, sans habilitation)** : `CompanyLookupPort` (Recherche d'entreprises) + `AddressAutocompletePort` (BAN) + `VatValidationPort` (dérivation + VIES). Quick wins #1/#2/#3.
- **Phase 2 — Métier & BTP** : pré-sélection profil métier via NAF + `RgeVerificationPort` (ADEME). Brique transverse indemnités km. Lancement **VTC** puis **Beauté**.
- **Phase 3 — Enrichissement avancé & verticales** : INPI/RNE + agent enrichissement par lot. Lancement **Santé libérale** → **Immobilier mandataire** → **Taxi**.
- **V2 séparée** : e-commerce (OSS/achat-revente).

---

## Annexe — détails APIs vérifiés
- **Recherche d'entreprises** : `GET /search?q=<siret|nom>` → `results[]` avec `siren`, `nom_complet`, `activite_principale` (NAF), `tva` (array, ex `["FR39356000000"]`), `siege{siret, code_postal, libelle_commune, numero_voie, type_voie, libelle_voie, adresse}`, `complements.est_rge`, `dirigeants`. Rate limit 7 req/s (429 + Retry-After).
- **VIES** : SOAP `checkVatService`, gratuit, instable par pays. Numéro de consultation à archiver ~7 ans.
- **BAN** : `GET /search?q=...` (50 req/s) ; migration IGN/Geoplateforme (URL à rendre configurable).
- **ADEME RGE** : `api-professionnels-rge`, open, MAJ quotidienne ; ~95% des établissements ; RGE ≠ décennale.
- **INSEE Sirene** : `portail-api.insee.fr` v3.11, token, 30 req/min, source autoritative (pas de TVA/dirigeants).

*Statut du panel : 2 lentilles (catalogue APIs, verticales) ancrées par recherche web ; architecture + priorisation consolidées en synthèse.*
