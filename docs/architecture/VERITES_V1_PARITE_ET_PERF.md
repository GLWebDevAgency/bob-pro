# Vérités écrites V1 — Parité voix↔manuel & baseline perf

Statut : référence V1 (feature freeze) · Rédigé le 2026-07-18 · Documentation uniquement, zéro code.

Ce document consigne deux vérités assumées pour la publication V1 :

1. les **exceptions de parité voix↔manuel** — actions volontairement laissées « au doigt » malgré la philosophie « tout doit réussir à la voix » ;
2. la **baseline de performance prod** relevée le 2026-07-18 — référence des prochains audits.

Cadre de publication : voir `design_handoff_bob_pro/PROGRAMME_V1_PUBLICATION.md` (liste unique de clôture V1, règle du feature freeze, critères « publiable »).

---

## 1. Exceptions de parité voix↔manuel assumées pour la V1

Principe général (philosophie « papa vocal ») : toute action du quotidien doit réussir à la voix, avec parité d'actions humain↔Bob. Les exceptions ci-dessous sont **assumées** pour la V1 — chacune tient en une ligne de justification. Toute levée d'exception après le gel exige l'accord commun Claude+GPT (cf. programme V1).

| # | Exception (reste au doigt) | Justification |
|---|---|---|
| 1 | Config, réglages, onboarding, diagnostic | Parcours ponctuels de mise en route, pas des gestes du quotidien : la voix n'y apporte rien et multiplierait les risques d'erreur de saisie. |
| 2 | Signature de devis | Acte juridique du **client** (page sign-web dédiée), jamais de l'artisan ni de Bob : ne peut par nature pas être vocal. |
| 3 | Achat d'abonnement | Le tap est imposé par la conformité stores (Apple/Google) : le flux de paiement in-app ne peut pas être déclenché vocalement. |
| 4 | Marquage d'une notification unitaire | Couvert vocalement par le batch `marquer_notifications_lues` + `contexte_ecran` : le geste unitaire au doigt n'a pas d'équivalent vocal utile. |
| 5 | Refuser un devis / supprimer des brouillons | Gestes rares et réversibles : le coût d'une commande vocale dédiée dépasse son usage réel. |
| 6 | Avoir sur facture | Opération comptable rare et sensible : confirmation manuelle exigée, pas de raccourci vocal en V1. |
| 7 | Fiche client multi-champs | La création complète s'appuie sur les lookups SIREN/adresse (sélection dans des listes) : interaction de désambiguïsation mieux servie au doigt. |

Tout ce qui n'est pas listé ici reste soumis à l'exigence de parité : une action du quotidien sans chemin vocal est un écart, pas une exception.

---

## 2. Baseline perf prod — 2026-07-18

### 2.1 Source et méthode

- Source : logs prod Railway de `bob-pro-api` du 2026-07-18 (fichiers `prod-logs-audit.txt`, `prod-logs2.txt`, `prod-logs3.txt`).
- Extraction : lignes `http` (méthode, route, status, ms), **déduplication par `correlationId`** — `prod-logs3.txt` est intégralement contenu dans `prod-logs-audit.txt` (93/93 doublons), `prod-logs2.txt` n'apporte que 2 health checks.
- p50 = médiane des `ms` relevées par route ; max = pire valeur relevée.
- Fenêtre observée : 2026-07-18, 04:11 → 13:21 UTC. Environnement : `data=postgresql, auth=jwt` ; démarrage `PublicodesEvaluationService` : 290–514 ms, +18,5–28,9 MB heap, 19 règles validées (`modele-social@11.0.0`).

### 2.2 Volumétrie et taux d'erreur

| Indicateur | Valeur constatée |
|---|---|
| Requêtes HTTP uniques | 142 |
| Statuts | 200 ×134 · 201 ×8 |
| Erreurs 4xx/5xx | **0** (taux d'erreur constaté : 0 %) |
| Lignes WARN/ERROR applicatives | 0 |
| Sociétés actives | 1 (session de démo `company-mercier`) |
| Jobs planifiés observés | `relances.run` 06:00 UTC (scanned=0, sent=0) |

Limite : volumétrie faible (une session, une société) — cette baseline est **indicative** ; les percentiles hauts (p95/p99) ne sont pas significatifs et ne sont donc pas publiés.

### 2.3 Latences par route (ms relevées)

| Route | Vol. | p50 (ms) | max (ms) | Statuts |
|---|---|---|---|---|
| GET /cashflow | 15 | 120 | 207 | 200 |
| GET /documents | 15 | 47 | 114 | 200 |
| GET /document-folders | 14 | 29 | 52 | 200 |
| GET /customers | 7 | 80 | 154 | 200 |
| GET /invoices | 7 | 30 | 66 | 200 |
| GET /expenses | 6 | 15 | 27 | 200 |
| GET /bank-balance | 5 | 27 | 30 | 200 |
| GET /fiscal-profile | 5 | 43 | 50 | 200 |
| GET /quotes | 5 | 58 | 83 | 200 |
| GET /chantiers | 5 | 119 | 164 | 200 |
| PUT /documents/:id/folder | 5 | 54 | 89 | 200 |
| GET /health | 4 | 1 | 1 | 200 |
| GET /notifications | 4 | 30 | 32 | 200 |
| GET /quote-drafts/current | 4 | 95 | 103 | 200 |
| GET /diagnostic | 4 | 71 | 77 | 200 |
| GET /subscription | 4 | 28 | 29 | 200 |
| POST /documents/:id/analysis | 4 | 185 | 9740 | 201 |
| GET /documents/:id | 4 | 30 | 77 | 200 |
| GET /documents/:id/download-url | 4 | 217 | 317 | 200 |
| GET /document-folders/:id | 3 | 19 | 37 | 200 |
| GET /engagement/digest/latest | 2 | 112 | 118 | 200 |
| GET /engagement/trial-report | 2 | 50 | 84 | 200 |
| GET /company/me | 2 | 14 | 14 | 200 |
| POST /expenses/defaults | 2 | 31 | 35 | 201 |
| GET /payments | 2 | 31 | 32 | 200 |
| GET /accounting/entries | 2 | 106 | 139 | 200 |
| GET /fiscal-calendar | 2 | 71 | 82 | 200 |
| POST /documents/intakes | 1 | 826 | 826 | 201 |
| POST /documents/ocr | 1 | 9731 | 9731 | 201 |
| PUT /documents/:id/name | 1 | 57 | 57 | 200 |
| PUT /documents/:id/expense | 1 | 756 | 756 | 200 |

### 2.4 Points d'attention (à suivre aux prochains audits)

- **OCR / analyse documentaire** : `POST /documents/ocr` à 9 731 ms et `POST /documents/:id/analysis` à 9 740 ms max — la quasi-totalité est le moteur externe (`ocr.engine engine="mistral-ocr" ms=9545`, `degraded=false`, confidence 0,98). Latence externe attendue, mais à surveiller : c'est le chemin critique du scan de reçu.
- **Uploads** : `POST /documents/intakes` à 826 ms pour ~1,1 MB — cohérent avec la taille du fichier.
- **Routes de synthèse** : `GET /cashflow` (p50 120 ms) et `GET /chantiers` (p50 119 ms) sont les GET les plus lents du tableau de bord — premières candidates si le dashboard ralentit avec le volume.
- **Signed URLs** : `GET /documents/:id/download-url` (p50 217 ms) dépend du stockage externe.

Tout audit ultérieur doit être comparé route par route à ce tableau ; une dérive de p50 > ×2 sur une route du quotidien (dashboard, documents, devis/factures) déclenche une investigation.

---

## 3. Référence

- Programme et critères de publication V1 : `design_handoff_bob_pro/PROGRAMME_V1_PUBLICATION.md`.
