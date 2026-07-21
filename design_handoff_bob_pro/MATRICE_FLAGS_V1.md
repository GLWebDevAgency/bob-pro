# MATRICE FLAGS V1 — Bob Pro

Document de référence — figé le 2026-07-20 (branche `hardening/integrity-rls-conformite-deps`).

> **Écart de cible consigné le 21/07/2026** — cette matrice décrit encore l'état réellement
> configuré avant la bascule. La cible de publication est GPT Realtime conformément à
> [OBJECTIFS_SPECS_DOD_PUBLICATION.md](OBJECTIFS_SPECS_DOD_PUBLICATION.md) et à l'ADR-0004.
> Les valeurs et le bloc machine-readable ne seront changés que dans le lot atomique qui livre les
> gardes runtime, les profils EAS et les tests anti-drift correspondants. Jusqu'alors, ne pas lire
> cette matrice comme la preuve que GPT Realtime est déjà actif.

## Préambule

Ce document **fige la matrice des flags et variables d'environnement de la build V1 publiée** de Bob Pro, sur les quatre plans où un flag peut se poser :

- **API Railway** (`apps/api`, schéma `apps/api/src/config/env.ts`) ;
- **Mobile EAS** (`apps/mobile/eas.json`, profils `preview` et `production`, garde `app.config.ts`) ;
- **Web Vercel** (`apps/web` cabinet, `apps/sign-web`) ;
- **CI GitHub** (`.github/workflows/*`, scripts de release).

Règles non négociables :

1. **Toute modification de ce document — ou d'un défaut de code qu'il fige — exige l'accord explicite Claude + GPT.** Le feature freeze V1 est acté (`PROGRAMME_V1_PUBLICATION.md`) : plus aucun ajout ni changement de valeur sans décision commune.
2. **Aucune valeur secrète n'apparaît ici.** Les secrets sont désignés par leur **nom** uniquement ; leurs valeurs vivent exclusivement dans les gestionnaires d'environnement (Railway, environnements GitHub, Vercel).
3. Le **bloc machine-readable** en fin de document (marqueurs `FLAGS_V1_JSON_START` / `FLAGS_V1_JSON_END`) est la **source du test anti-drift** `apps/api/src/flags-matrix-v1.test.ts`. Couverture mécanique réelle : **scope `api`** (défauts résolus par `env.ts` + liste de noms verrouillée en dur — supprimer une entrée du bloc fait aussi échouer la suite), **scope `mobile`** (comparaison aux blocs `env` des profils `preview` ET `production` de `eas.json`) et **`MUSTANG_VERSION`** (comparé à `ci.yml`). Les scopes `web` (Vercel) et les variables de service Railway (`RUN_RLS_CERT`, `RLS_CERT_CLEANUP`) ne sont **pas vérifiables depuis le repo** : contrôle humain (À confirmer #2).

Légende de la colonne « Valeur V1 figée » :

- **défaut** — la variable n'est **pas posée** ; la valeur provient du défaut du code (le test anti-drift verrouille ce défaut) ;
- **posée = X** — la variable est **explicitement posée** à X dans l'environnement cible ;
- **ABSENTE** — la variable ne doit exister nulle part ;
- **INTERDITE** — sa simple présence fait échouer build ou boot (voulu).

---

## 1. Voix & IA — clés fournisseurs, STT/TTS tour-par-tour, OCR

La voix V1 = **Voxtral tour-par-tour** (STT + TTS via `MISTRAL_API_KEY`), périmètre C1 révisé (`PROGRAMME_V1_PUBLICATION.md` l.69-76 — ne pas citer le §B6 brut) : décision fondateur 15/07, **accord GPT en attente** (cf. À confirmer #10). Le full-duplex Bob Live reste OFF (famille 2).

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| `MISTRAL_API_KEY` (secret) | Railway | absente (`env.ts:135`) | **posée, réelle** | LLM chat, STT Voxtral, TTS Voxtral, OCR `mistral-ocr`, satisfait à elle seule les gardes boot « ≥1 LLM » et « OCR » ; endpoint EU + Zero Data Retention actés | Absente = voix et OCR morts (cœur « papa vocal ») ; si Anthropic aussi absente = refus de boot |
| `ANTHROPIC_API_KEY` (secret) | Railway | absente (`env.ts:12`) | **posée** | Tâches critiques (`agent.plan`, `mentions.phrase`, `diagnostic.explain`) routées Claude en premier ; OCR de secours | Absente = fallback Mistral pour les tâches critiques (dégradé mais viable) |
| `OPENAI_API_KEY` / `GLM_API_KEY` / `DEEPSEEK_API_KEY` (secrets) | Railway | absentes (`env.ts:13-15`) | **ABSENTES** | Optionnelles ; pas de clé OpenAI prod actée (D3 bloqué fondateur) ; moins de surface de secret | Une clé inutile posée = surface d'attaque gratuite |
| `STT_PROVIDER` | Railway | absent → Voxtral si clé Mistral présente (`env.ts:138`, `providers.ts:777-783`) | **posée = `mistral`** | Ferme explicitement le chemin Whisper ; cohérent `.env.example:121` | `openai` sans `OPENAI_API_KEY` = transcription en échec |
| `MISTRAL_STT_MODEL` | Railway | `voxtral-mini-latest` (`env.ts:139`) | **défaut** | LA voix de Bob | Modèle invalide = erreurs 400 à chaque tour |
| `MISTRAL_STT_CONTEXT_BIAS` | Railway | absent au schéma (`env.ts:140`, `optional()`) ; `''` appliqué par le consommateur (`providers.ts:594`) | **défaut** (optionnel jargon BTP) | Biais vocabulaire métier à la transcription | Aucun (optionnel) |
| `MISTRAL_TTS_MODEL` | Railway | `voxtral-mini-tts-2603` (`env.ts:153`) | **défaut** | TTS Voxtral | Bob muet côté audio |
| `MISTRAL_TTS_VOICE_ID` | Railway | absent = voix Mistral par défaut (`env.ts:154`) | **défaut** | — | Voice ID invalide = 400 Mistral |
| `MISTRAL_OCR_MODEL` / `MISTRAL_OCR_EXTRACT_MODEL` | Railway | `mistral-ocr-latest` / `mistral-small-latest` (`env.ts:156-157`) | **défauts** | Intake documentaire (factures fournisseurs) | Modèle invalide = intake en échec |
| `ANTHROPIC_DOCUMENT_MODEL` | Railway (HORS schéma zod, `document-intelligence.ts:426`) | `claude-opus-4-8` | **défaut — ne rien poser** | Moteur document-intelligence de secours | Var non validée : typo silencieuse |
| Overrides hors schéma : `ANTHROPIC_MODEL`, `MISTRAL_URL`/`MODEL`, `OPENAI_URL`/`MODEL`, `GLM_URL`/`MODEL`, `DEEPSEEK_URL`/`MODEL`, `WHISPER_MODEL`, `REALTIME_SPEECH_AUDIT_STT_MODEL` | code (`providers.ts:416-460,466,526,763,837`) | endpoints officiels + modèles codés | **AUCUN posé** | L'absence garantit les endpoints officiels ; les `*_URL` chat n'ont **aucun épinglage d'host** (contrairement à Bob Live) | URL détournée = **exfiltration silencieuse** des prompts vers un tiers |
| `AI_ROUTER_DEFAULT` | Railway | `claude` (`env.ts:136`) | **défaut — ne rien poser** (VAR MORTE, lue nulle part) | Le ModelRouter ne la consulte pas | Aucun effet runtime — fausse impression de contrôle |
| Overrides d'URL Open Data : `BAN_URL`, `VIES_URL`, `RECHERCHE_ENTREPRISES_URL` | code, HORS schéma (`ban-address.adapter.ts:19`, `vies-vat.adapter.ts:12`, `recherche-entreprises.adapter.ts:36`) | endpoints officiels (`api-adresse.data.gouv.fr`, `ec.europa.eu`, `recherche-entreprises.api.gouv.fr`) | **AUCUN posé** | https exigé (throw) mais **host non épinglé** — même classe de risque que les `*_URL` chat (incohérence n°6) | URL https détournée = adresses/TVA/SIRET servis par un tiers sans erreur visible |
| `RoutingContext.euOnly` + `envOverrides` (`<PROVIDER>_MODEL_<TIER>`) | code (`packages/ai/src/router/model-router.ts:26-28`) | jamais passés par aucun appelant | **non câblés en V1** | Mode souveraineté UE inatteignable ; catalogue `MODEL_CATALOG` en dur | Les poser sur Railway = no-op silencieux ; écart promesse/réalité RGPD |

---

## 2. Bob Live (temps réel full-duplex) & Mistral v2 — tout OFF

Décision actée : ADR-0001 rollout fermé + **garde liveness `nextServerSequence`** (challenge Claude 20/07, GO_AVEC_CORRECTIFS) — ne **jamais** flipper le replay v2 avant le fix livré par GPT.

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| `BOB_LIVE_ENABLED` | Railway | absent → repli `OPENAI_REALTIME_ENABLED` (`false`) (`env.ts:19,481`) | **posée = `false`** | Interrupteur maître du live ; gates d'ouverture (p95, 7j SLO) non franchis | `true` sans les ~7 secrets/sidecar = refus de boot ; `true` configuré = promesse duplex non certifiée |
| `BOB_LIVE_PROVIDER` | Railway | `openai` au schéma (`env.ts:20`) — `.env.example:20` pose `mistral` | **posée = `mistral`** | Ferme le chemin d'un flip accidentel vers OpenAI ; le replay v2 exige `mistral` (`env.ts:687`) ; inerte tant que live OFF | Switch sans drainage viole le runbook `BOB_LIVE.md` |
| `OPENAI_REALTIME_ENABLED` + ~16 alias legacy `OPENAI_REALTIME_*` + `OPENAI_TTS_MODEL` | Railway | `ENABLED='false'`, secrets absents (`env.ts:99-134`) | **AUCUN posé** (défaut `false` verrouillé par le test anti-drift) ; **audit Railway requis : purger tout résidu** | Alias de repli uniquement ; un `true` résiduel activerait Bob Live à l'insu du flag canonique | `true` oublié = live activé ou boot-fail sur secrets manquants |
| `BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED` | Railway | `false` (`env.ts:39`) | **défaut = `false`** — GARDE LIVENESS ACTÉE | Fermeture précoce de Mission (seq 1-2) lèverait un 23514 (`mistral_terminal_receipt_cursor_check`) avortant la clôture | ON avant le fix = Missions inclôturables en prod |
| `BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED` | Railway | `false` (`env.ts:41`) | **défaut = `false`** | Même garde ; `true` seul = refus de boot (couplage voulu, `env.ts:700-707`) | `true` avec replay = chaîne v2 sous bug de liveness |
| `BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION`/`_KEYRING` + `..._IDENTITY_ENCRYPTION_KEY_VERSION`/`_KEYRING` (secrets) | Railway | absents (`env.ts:62-79`) | **ABSENTS — interdits tant que replay OFF** (`env.ts:681,708`) | Dormance couplée bidirectionnelle ; ne pas pré-provisionner | Posés avec replay OFF = boot **et** release refusés ; recopier les fixtures `ci.yml` = chiffrement avec des clés publiques du repo |
| `BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS` / `_BATCH_SIZE` / `_MAX_BATCHES` | Railway | 60000 / 10 / 4 (`env.ts:44-61`) | **défauts** (inertes v2 OFF) | Purge bornée ADR-0003 | Hors bornes = refus de parse zod au boot |
| Chaîne secrets Bob Live : `BOB_LIVE_SUBJECT_HMAC_SECRET`/`_KEY_VERSION`/`_KEYRING`, `BOB_LIVE_PROOF_SECRET`/`_KEY_VERSION`, `BOB_LIVE_USAGE_HMAC_SECRET`/`_KEY_VERSION`, `BOB_LIVE_CONTROL_ENCRYPTION_SECRET`/`_KEY_VERSION` (secrets) | Railway | absents (`env.ts:21-37`) | **ABSENTS** (live OFF) ; préparer le keyring sujet AVANT toute activation | Requis seulement si live ON ; unicité inter-clés vérifiée (`env.ts:775`) | Rotation sans keyring = pseudonymes des preuves cassés ; clés partagées = boot refusé |
| Budgets/quotas/baux/gateway (`BOB_LIVE_PROVIDER_TIMEOUT_MS`, `MAX_CALLS_*`, `RESERVATION_TTL`, `GATEWAY_TLS_MODE`, …) | Railway | 4000/3000/900 ; quotas 3/30/50/1000 ; baux 15/30/10/30 ; gateway 500/1500/`direct` (`env.ts:80-93`) | **défauts** (déjà verrouillés par `config/realtime-env.test.ts`) | Contraintes croisées fatales (`env.ts:828-856`) | `trusted-proxy` avec backend exposé en direct = downgrade TLS accepté |
| `BOB_LIVE_AUDIT_PROVIDER` / `BOB_LIVE_LOCAL_AUDIT_BASE_URL` / `_TOKEN` | Railway | `local-whisper` / absents (`env.ts:96-98`) | **défaut / ABSENTS** | Si live ON : `openai` refusé au boot (`env.ts:736-741`), URL loopback only | Sans sidecar = live impossible par construction (voulu) |
| `BOB_LIVE_MISTRAL_WEBSOCKET_URL` + `MISTRAL_REALTIME_STT_MODEL` / `_BASE_URL` / `_TARGET_DELAY_MS` | Railway | loopback ws / `voxtral-mini-transcribe-realtime-2602` / `wss://api.mistral.ai` / 240 (`env.ts:141-152`) | **défauts** (inertes live OFF) | Host épinglé `api.mistral.ai` en prod live (`env.ts:791-796`) | Host détourné = refusé au boot (fail-closed) |
| `bob.voiceMode` (préférence AsyncStorage mobile — pas une env) | code mobile (`settings.ts:30-49`) | `native` | **aucune action** — arbitre du live = exclusivement serveur | Garder v2 OFF ne requiert AUCUN rebuild mobile | Aucun (repli sûr) |

---

## 3. Fiscal

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| `FISCAL_PUBLICODES_SIMULATIONS_ENABLED` | Railway | `false` (`env.ts:195`) | **défaut = `false`** (SHADOW) | Décision actée (SPEC_EXPERT_FISCAL, contre-revue GPT : NO-GO exposition prod ; PROGRAMME_V1 §C3) ; trous de couverture documentés | ON prématuré = conseils fiscaux erronés engageant la responsabilité |
| `FISCAL_PUBLICODES_MAX_CONCURRENCY` | Railway | 4 (clamp 1-32) (`env.ts:201`) | **défaut = 4** | Protège l'event loop partagée avec `/voice` | 32 sous rafale = latence vocale dégradée |

---

## 4. E-invoicing / PDP

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| PDP / e-invoicing | **AUCUN flag d'environnement n'existe** | n/a | rien à poser | Factur-X import/réception et guide Chorus en dur ; canaux PDP/e-reporting = **stubs structurels** derrière ports (`architecture-blueprint.md` l.734,770) — le mode « démo » PDP n'est PAS pilotable par env. ⚠️ Échéance légale dure : choix du partenaire **Plateforme Agréée + inscription annuaire avant le 01/09/2026** (cf. À confirmer #12) | Croire qu'une env var contrôle le mode démo PDP : la bascule vers un PDP agréé sera un **chantier code** |
| `MUSTANG_VERSION` | CI (`.github/workflows/ci.yml:137`) | `2.16.1` en dur | **posée = `2.16.1`** (épinglée) | Validateur Factur-X ; Schematron EN 16931 = gate bloquant | Version retirée de Maven = job facturx rouge ; jamais `latest` |

---

## 5. Observabilité

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| `ERROR_REPORTER_WEBHOOK_URL` (secret) | Railway | absent → fatal au boot live (`env.ts:189,567`) | **posée = webhook réel supervisé** (remplacer le placeholder suspecté AVANT V1 — correctif prioritaire) | Seule télémétrie d'erreur V1 ; aucun contrôle ne détecte un placeholder pour CETTE var, et le reporter **s'auto-désactive** après échecs (`error-reporter.ts:55-67`) | Placeholder qui parse = incidents prod invisibles, en silence total |
| `METRICS_TOKEN` (secret) | Railway | absent (requis live, ≥32 chars) (`env.ts:181`) | **posée**, aléatoire, distincte par environnement | `/metrics` fail-closed, comparaison timing-safe (`auth.guard.ts:57`) | Placeholder crochets = boot refusé (voulu) |
| `LOG_LEVEL` | Railway (HORS schéma, `logger.ts:48`) | `info` | **défaut** | Niveau pino | `debug` en prod = verbosité/coût ; `silent` = perte de diagnostic |
| `PRODUCT_ANALYTICS_ENDPOINT` (secret) | Railway (HORS schéma, `analytics.ts:44`) | absent → Noop | **ABSENTE** sauf décision fondateur (question ouverte) | Fire-and-forget, jamais une condition d'exploitation | Faible |

---

## 6. Socle API — NODE_ENV, base de données, Supabase, Railway

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| `NODE_ENV` | Dockerfile:25 (figé dans l'image) + Railway | `production` dans l'image | **`production`** sur staging ET production | Pivot de TOUTES les gardes live (`env.ts:550,669,792,812`) ; `check-release-env.sh:78` l'exige même pour staging | ≠production en prod réelle = CORS ouvert + gardes URL relâchées |
| `DEMO_MODE` | Railway | `false` au schéma (`env.ts:11`) ; toute valeur ≠`false` en prod = refus de boot (`env.ts:550-553`) | **posée = `false`** (défaut également verrouillé) — ⚠️ le Railway live est encore `DEMO_MODE=true` : passage prod = préalable V1 | `false` déclenche la liste des dépendances obligatoires au boot (`env.ts:555-668`) | Publier la V1 contre l'instance démo = données in-memory perdues |
| `PORT` | injecté par Railway | 3000 (`env.ts:8`) | **ne pas figer** — laisser l'injection Railway | Healthcheck `/health` (timeout 120s) | Valeur en dur divergente = deploy rollback |
| `DATABASE_URL` (secret) | Railway | absent — requis live (`env.ts:165,569`) | **posée = rôle `bob_app` via pooler session 5432**, jamais superuser | RLS FORCE ; release gate : user ≠ postgres, port 6543 interdit, distincte de `DIRECT_URL` | Rôle postgres au runtime = BYPASSRLS, tout le modèle d'isolation tombe |
| `DIRECT_URL` (secret) | Railway (releases via `railway run`) | absent (`env.ts:166`) | **posée = postgres direct 5432**, réservée migrations/certifications/rotations | Jamais utilisée par le runtime métier | Identique à `DATABASE_URL` = release gate en échec |
| `APP_DATABASE_ROLE` | Railway | `''` — grants skippés avec warning (`release.sh:21-87`) | **posée = `bob_app`** (staging et production) | Cible des GRANT/REVOKE append-only | Vide = ACL dérivant release après release, en silence |
| `SUPABASE_URL` + `SUPABASE_JWKS_URL` + `SUPABASE_SERVICE_ROLE_KEY` (secret) + `SUPABASE_JWT_AUD` | Railway | absents ; `JWT_AUD` hors schéma, défaut `authenticated` (`auth.guard.ts:120`) | **posées = projet `cvdkqjczgqoeshputacl`** ; `JWT_AUD` **défaut** ; service-role JAMAIS côté client | Guard JWT fail-closed | JWKS d'un autre projet = 100 % des logins rejetés ; service-role fuitée = contournement RLS total |
| `SUPABASE_STORAGE_BUCKET` / `SUPABASE_REALTIME_AUDIO_BUCKET` | Railway | `bob-documents` / `bob-live-audio` (`env.ts:170-171`) | **défauts** (prod ; suffixe `-staging` en staging) — distincts obligatoires si live ON (`env.ts:780`) | Buckets documents vs preuves audio | Même bucket + live ON = refus de boot |
| `RAILWAY_PROJECT_ID` / `_ENVIRONMENT_ID` / `_SERVICE_ID` / `_DEPLOYMENT_ID` / `_REPLICA_ID` | injectées par Railway (`client-ip.ts:10-28`) | absentes hors Railway → mode `socket` | **ne JAMAIS les poser à la main** | Les 5 UUID valides ensemble = confiance `X-Real-IP` (anti-spoof) | Posées à la main hors Railway = rate-limiting spoofable |

---

## 7. Paiements, emails, jobs

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| Bloc Stripe tout-ou-rien : `STRIPE_SECRET_KEY`, `STRIPE_PRICE_SOLO`/`PRO`/`BUSINESS`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_LIVEMODE`, `PAYMENT_RETURN_BASE_URL` (secrets) | Railway | 7 absentes = early-access assumé (`DisabledPaymentGateway`) ; bloc ENTAMÉ incomplet = fatal (`env.ts:592-625`) | **ABSENTES** (early-access = option Claude, PROGRAMME §B2, **À TRANCHER fondateur** — cf. À confirmer #1) — ⚠️ exige d'abord d'amender `check-release-env.sh` (voir Incohérences) | CTA d'achat gelés côté UI | Bloc partiel = boot refusé ; clé test + `LIVEMODE=true` = paiements fantômes |
| `BREVO_API_KEY` (secret) / `BREVO_SENDER_EMAIL` / `BREVO_API_BASE_URL` / `BREVO_SENDER_NAME` | Railway | KEY/SENDER absentes (requises live) ; `https://api.brevo.com/v3` ; `Bob Pro` (`env.ts:176-179`) | **KEY et SENDER_EMAIL posées** (domaine définitif, SPF/DKIM vérifiés, restriction IP levée) ; BASE_URL et NAME **défauts** | Invitations cabinet, relances | Sender non vérifié = emails rejetés en silence côté provider |
| `JOB_COMPANY_IDS` | Railway | absent → `[]` = crons inertes (`env.ts:175,876-887`) — release gate exige non vide | **posée = companyId des pilotes réels** (aujourd'hui `company-mercier`) | Onboarding = ajouter l'ID ici | Tenant oublié = aucune relance planifiée pour lui, sans signal |
| `DIGEST_WORKER_ENABLED` | Railway (VAR FANTÔME : hors schéma, hors `.env.example`, hors gate — `digest.service.ts:247`) | ≠`true` → OFF | **à décider fondateur** ; dans tous les cas l'intégrer au schéma + gate | Digest hebdo (cron Paris) | Oubliée = digest silencieusement absent en prod |

---

## 8. Build mobile (EAS)

Valeurs identiques dans **les deux profils** `preview` et `production` de `eas.json` (drift vérifié nul au 20/07).

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| `EXPO_PUBLIC_API_URL` | `eas.json` (2 profils) — garde `app.config.ts:61-63` | aucune — build refusé si absente | **`https://bob-pro-api-production.up.railway.app`** — ⚠️ confirmer passage prod (bob_app, `DEMO_MODE=false`) AVANT build store | HTTPS non-loopback exigé au build en profil release | App store pointant un backend démo = données réelles inaccessibles |
| `EXPO_PUBLIC_SUPABASE_URL` | `eas.json` (2 profils) | aucune — build refusé | **`https://cvdkqjczgqoeshputacl.supabase.co`** (MÊME projet que l'API) | Auth PKCE | Mauvais projet = login OK mais JWT rejetés par l'API |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `eas.json` (2 profils) | aucune — build refusé | **clé anon du projet** (publique par design, versionnée dans `eas.json` = acceptable ; protection = RLS) | — | Ne JAMAIS y mettre la service-role |
| `EXPO_PUBLIC_TERMS_URL` / `EXPO_PUBLIC_PRIVACY_URL` | `eas.json` (2 profils) | aucune — build refusé | **`https://bob-pro-sign-web.vercel.app/legal/conditions-utilisation`** / **`.../legal/confidentialite`** — migrer les DEUX profils ensemble vers le domaine définitif le jour J | Exigence Apple/Google | Privacy policy injoignable = rejet store quasi certain |
| `EXPO_PUBLIC_SUPPORT_EMAIL` | `eas.json` (2 profils) | aucune — build refusé | **`ghassenelimame@gmail.com`** (Gmail perso — décision produit : prévoir `support@` de marque avant soumission publique, non bloquant) | Email support in-app | Image non professionnelle |
| `EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL` | `eas.json` (2 profils) — validation RUNTIME seulement (`email-confirmation.ts:67-94`) | absente → repli SILENCIEUX deep link nu | **`https://bob-pro-sign-web.vercel.app/auth/confirme`** + allowlistée dans les Redirect URLs Supabase — **correctif V1 : l'ajouter au garde `required()` de `app.config.ts`** (seul gap de garde mobile) | Corrige le bug fondateur « Fly Services » | Retirée d'un profil = inscriptions cassées depuis desktop, sans échec de build |
| `EXPO_PUBLIC_DEMO_MODE` + `EXPO_PUBLIC_API_TOKEN` | nulle part | leur ABSENCE est le seul état valide (`app.config.ts:55-60`, `mobile-data-mode.ts:69-83`) | **INTERDITES** (pas « OFF » : interdites) — double verrou build + runtime, couvert par tests | Aucun binaire Bob ne peut devenir une app à fixtures ni embarquer une identité statique | Le vrai risque serait de retirer le garde |
| `EAS_BUILD_PROFILE` (+ `allowPreviewDemo`) | posée par EAS Build cloud | `undefined` en local ET dans le binaire | **rien à poser** — l'enforcement HTTPS-release est **100 % build-time** (`app.config.ts`) ; le miroir runtime est du code mort (piège d'inlining confirmé) ; supprimer `allowPreviewDemo` une fois le domaine définitif live | babel-preset-expo n'inline que `EXPO_PUBLIC_*` | Forcer `development` sur un build distribué = API http locale acceptée |
| `extra.eas.projectId` | `apps/mobile/app.json` | fallback fragile | **`c45313b8-9aa1-4776-bf37-31fd0482701a`** (conserver) | Token push Expo (`push.tsx:66-71`) | Notifications push silencieusement inopérantes |

---

## 9. Web cabinet / sign-web

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | env Vercel (production ET preview) — gates pré-build workflows | null → API/auth cabinet désactivées côté client | **origine Railway** (= var GitHub `API_BASE_URL`) + **même projet Supabase que l'API** + clé anon UNIQUEMENT | Double consommation : inlinées au build ET lues au runtime (CSP `connect-src` via `proxy.ts`) — toute rotation exige un redeploy complet | Service-role collée par erreur = compromission totale (inlinée dans le bundle public) |
| `SIGN_WEB_BASE_URL` | Railway | absent — requis live ; localhost/demo/HTTP fatals (`env.ts:180,626-639`) | **posée = URL sign-web prod** (domaine définitif = décision fondateur NICO, cf. À confirmer #5 ; valeur transitoire `vercel.app` admise jusqu'au jour J) ; équivalent staging dédié | Liens publics de signature envoyés aux clients finaux ; ajoutée d'office au CORS | Liens de signature morts ou pointant l'environnement de test |
| `CORS_ORIGINS` | Railway | absent → prod : allowlist réduite à `SIGN_WEB_BASE_URL` (`cors.ts:15-66`) | **posée = origines cabinet web + sign-web HTTPS** de l'environnement, exactement | Prod fail-closed ; wildcard interdit au gate | Origine oubliée = cabinet web bloqué par CORS |
| `CABINET_RELEASE_ENV` | Railway | `development` — FATAL en prod (`env.ts:182,669-672`) | **posée = `production`** sur prod, **`staging`** sur staging — jamais copiée entre les deux | Environnement d'évaluation des release flags DB (ADR-06, fail-closed, kill-switch prioritaire) | `staging` sur prod = flags évalués contre les mauvaises lignes DB |
| `CABINET_INVITATION_TOKEN_ENCRYPTION_KEY` (secret) / `_KEY_VERSION` / `CABINET_INVITATION_WEB_BASE_URL` | Railway | clé absente (requise live, ≥32) / 1 / URL absente (`env.ts:183-185`) | **clé aléatoire PAR environnement** / **version 1** / **URL = origine cabinet web** de l'environnement | Chiffrement versionné des jetons d'invitation | Rotation sans bump = invitations en vol invalidées ; clé partagée staging/prod = token staging déchiffrable en prod |
| `CABINET_INVITATION_WORKER_ENABLED` + `CABINET_INVITATION_WORKER_USER_ID` + `JOB_CABINET_IDS` | Railway | `false` / absents — couplage bidirectionnel fatal (`env.ts:640-652`) | **staging : `true` + cabinet E2E + pilotes ; production : `false` en PURGEANT physiquement USER_ID et JOB_CABINET_IDS** | Anti-config zombie ; scope certifié contre la base (`release.sh:630-719`) | Vars orphelines = boot et release refusés (voulu) |
| `CABINET_PILOT_BOOTSTRAP_CONFIG` | Railway (temporaire) | absente = no-op | **ABSENTE** ; posée uniquement le temps d'onboarder un pilote, puis retirée | Provisionnement déclaratif pendant `release.sh` | Incohérente avec le scope worker = release refusée |

---

## 10. CI / Release

| Flag | Où il se pose | Défaut code | Valeur V1 figée | Pourquoi | Risque si dévié |
|---|---|---|---|---|---|
| `RAILWAY_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_CABINET_WEB_PROJECT_ID`, `VERCEL_SIGN_WEB_PROJECT_ID` (secrets) | secrets GitHub scoped par environnement | aucun | **présents dans les DEUX environnements GitHub** (staging, production) ; tokens scoped projet/équipe ; ne jamais fusionner les deux projets Vercel | CLIs épinglés (Railway 5.26.0 sha256, Vercel 50.4.5) | Mauvais PROJECT_ID = déploiement sur le mauvais domaine |
| `RAILWAY_API_SERVICE`, `API_BASE_URL`, `CABINET_WEB_BASE_URL`, `EXPECTED_RELEASE_SHA` (vars GitHub) | workflows | aucun ; `EXPECTED_RELEASE_SHA` = `github.sha`, jamais manuel | **`bob-pro-api` + une origine par environnement** ; ne rien changer au mécanisme SHA (postmortem 17/07) | Chaîne de custody `.bob-release.json` → `/health/ready` → smoke → E2E | Alias sur le mauvais host = utilisateurs sur une ancienne révision |
| `RELEASE_ENVIRONMENT` | workflow (`railway-api.yml:97,116`) | `production` si absent (défaut du script) | **piloté par le workflow, jamais posé en dur** ; doit égaler STRICTEMENT `CABINET_RELEASE_ENV` du service | Cible du gate | Run manuel sans la var = validation contre le profil prod par défaut |
| `RUN_RLS_CERT` + `RLS_CERT_CLEANUP` | **variables de service Railway** (contre-intuitif : `release.sh` y tourne via `railway run`) | absents — release ÉCHOUE (`:?`) | **posées = `true`/`true`** sur staging ET production | Cérémonie assumant la certification RLS adversariale + cleanup | Absents = release bloquée ; cert sans cleanup = résidus de test en base prod |
| Famille `RUN_POSTGRES_*_CERT` (~28 gates destructrices) + auxiliaires | inline CI/`release.sh` uniquement | absents → suites skippées ; ⚠️ le gate n'en interdit que **2 sur ~28** (`RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT`, `RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT` — `check-release-env.sh:192-200`), le reste de la famille n'est PAS gaté (incohérence n°15) | **JAMAIS en variables de service Railway** | Suites de certification DESTRUCTRICES réservées au Postgres éphémère CI | Var de service oubliée à true + run direct = données réelles tronquées |
| Fixtures CI Mistral v2 (`ci.yml:62-69`) | CI uniquement | valeurs déterministes publiques du repo | **ne JAMAIS recopier sur Railway** ; en V1 les vars homonymes doivent être ABSENTES du service | Certification de rotation contre la DB CI sans secret externe | Recopiées en prod = conversations chiffrées avec des clés publiques |
| `CABINET_E2E_*` + `VERCEL_AUTOMATION_BYPASS_SECRET` (secrets) | environnement GitHub staging | aucun (job E2E throw si manquants) | **boîtes Mailosaur dédiées staging, jamais d'emails réels** ; couplage manuel : le cabinet E2E primaire DOIT figurer dans `JOB_CABINET_IDS` du service Railway staging | Gate bloquant la promotion production | Désalignement = reset refusé = promotion production impossible |
| Entrypoints `/testing` + gardes d'artefact (`assert-production-artifact.mjs`) | build des packages | n/a — mécanisme de build | **conserver tel quel** ; jamais publier un `dist/` construit en `build:testing` ; le mapping tsconfig api des paths `/testing` pour les tests est **voulu**, ne pas « corriger » | LE mécanisme remplaçant les flags « demo » dans les packages (zéro `process.env` dans `packages/*`) | Contourner la garde = données fabriquées dans un artefact prod — interdit absolu |

---

## Gardes en place (couplages fatals au boot)

Ces gardes font partie du contrat V1 : elles doivent survivre à tout refactoring. Références vérifiées le 20/07 dans `apps/api/src/config/env.ts` :

1. **DEMO_MODE en production** — `env.ts:550-553` : en `NODE_ENV=production`, toute valeur ≠ `'false'` refuse le boot.
2. **Dépendances live obligatoires** — `env.ts:555-591` : `DEMO_MODE=false` exige `DATABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CABINET_INVITATION_TOKEN_ENCRYPTION_KEY`, `SIGN_WEB_BASE_URL`, `CABINET_INVITATION_WEB_BASE_URL`, `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `METRICS_TOKEN`, `ERROR_REPORTER_WEBHOOK_URL`, ≥1 clé LLM, et Mistral OU Anthropic pour l'OCR.
3. **Stripe tout-ou-rien** — `env.ts:592-625` : bloc entamé mais incomplet = fatal ; bloc totalement absent = early-access assumé.
4. **Worker cabinet anti-zombie** — `env.ts:640-652` : ON exige liste + identité ; OFF interdit toute liste/identité résiduelle.
5. **CABINET_RELEASE_ENV** — `env.ts:669-672` : `development` interdit en `NODE_ENV=production`.
6. **Keyring v2 interdit si replay OFF** — `env.ts:681-685` (persistance) et `env.ts:708-712` (identité) : dormance couplée bidirectionnelle — aucune clé v2 résiduelle tolérée.
7. **Replay v2 = chaîne complète** — `env.ts:686-699` : replay ON exige `BOB_LIVE_ENABLED=true` + `BOB_LIVE_PROVIDER=mistral` + keyring persistance complet + keyring sujet (`BOB_LIVE_SUBJECT_HMAC_KEYRING`).
8. **Bootstrap-sans-replay interdit** — `env.ts:700-707` : `BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED=true` sans replay actif = refus de boot. *(prouvé par le test anti-drift)*
9. **Live ON = configuration certifiée** — `env.ts:713-858` : secrets dédiés et uniques (`:775`), anti-placeholder (`:749`), auditeur ≠ fournisseur TTS (`:736-741`), buckets distincts (`:780-781`), hosts épinglés en prod (`:791-796`), WSS canonique (`:797-814`), sidecar audit loopback only (`:816-827`), budgets ≤ 8500 ms (`:828-838`), cohérence quotas/baux (`:839-858`).
10. **Cohérence secret legacy / keyring sujet** — `env.ts:337-343` : un secret `OPENAI_REALTIME_SAFETY_SECRET` résiduel divergent du keyring = boot refusé.

Verrouillage par tests : les défauts quotas/baux sont déjà figés par `apps/api/src/config/realtime-env.test.ts` ; la présente matrice est verrouillée par `apps/api/src/flags-matrix-v1.test.ts` (bloc JSON ci-dessous) pour les scopes `api` et `mobile` + `MUSTANG_VERSION` — les scopes `web` et vars de service Railway restent à contrôle humain.

---

## Incohérences à solder

1. **MAJEURE — Stripe vs early-access** (vérifiée code 20/07) : `check-release-env.sh:39-45` exige les 7 vars Stripe (+ `STRIPE_LIVEMODE='true'` l.81-82, `whsec_` réel l.84-85) pour TOUTE release, alors que `env.ts`/`payment-gateway.ts` admettent le bloc totalement absent (early-access) et que `ci.yml` certifie le boot « sans Stripe ». **En l'état, la release V1 sans paiement est mécaniquement impossible via le workflow.** À acter avant la première release (variante early-access du gate, ou Stripe live).
2. **VAR MORTE `AI_ROUTER_DEFAULT`** : validée au schéma, documentée, lue nulle part. Supprimer ou câbler.
3. **Contrats morts `@bob/ai`** : `RoutingContext.euOnly` et `envOverrides` jamais passés — mode souveraineté UE inatteignable ; risque d'écart promesse/réalité RGPD (`docs/compliance/sous-traitants.md`).
4. **`ERROR_REPORTER_WEBHOOK_URL` sans détection de placeholder** + auto-désactivation du reporter = trou noir d'alerting silencieux. Correctif V1 prioritaire.
5. **`DIGEST_WORKER_ENABLED` fantôme** : hors schéma, hors `.env.example`, hors gate. À intégrer.
6. **Vars hors schéma zod** (lues sans validation) : `SUPABASE_JWT_AUD`, `LOG_LEVEL`, `DIGEST_WORKER_ENABLED`, `PRODUCT_ANALYTICS_ENDPOINT`, `ANTHROPIC_DOCUMENT_MODEL`, `WHISPER_MODEL`, `REALTIME_SPEECH_AUDIT_STT_MODEL`, ~10 overrides `{PROVIDER}_URL`/`{PROVIDER}_MODEL`. Les `*_URL` chat n'ont **aucun épinglage d'host** — envisager le même épinglage que Bob Live post-V1.
7. **Alias legacy `OPENAI_REALTIME_*` vivants** (16 vars) : `OPENAI_REALTIME_ENABLED` est le fallback de `BOB_LIVE_ENABLED` (`env.ts:481`). Auditer Railway, purger post-V1.
8. **Gap de garde mobile unique** : `EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL` absente du `required()` de `app.config.ts` — dégradation silencieuse possible. L'ajouter.
9. **Piège d'inlining EAS confirmé** : `process.env.EAS_BUILD_PROFILE` vaut `undefined` dans tout binaire — l'enforcement HTTPS-release est 100 % build-time.
10. **Placeholders embarqués en profil production `eas.json`** (non bloqués par les gardes) : support = Gmail perso, URLs légales sur `bob-pro-sign-web.vercel.app`, API pointant un Railway encore en mode démo.
11. **État réel vs cible** : Railway live encore `DEMO_MODE=true` (`store-readiness.md:131`), staging sur une ancienne révision — la matrice décrit la **cible** prod.
12. **Divergences code/gate volontaires mais piégeuses** : `JOB_COMPANY_IDS` optionnel au runtime mais requis au gate ; `NODE_ENV=production` exigé même pour une release staging ; `DATABASE_URL` placebo dans les jobs CI verify/facturx.
13. **Hardening workflows** : `vercel-sign-web.yml` = seul workflow sans bloc `permissions` ; `vercel-sign-web.yml` ET `ci.yml` (13 actions) = seuls sans épinglage SHA des actions.
14. **Piège de lecture doc** : PROGRAMME_V1 §B6 « Bob Live Mistral (OFF) » ne vise QUE le full-duplex v2 — citer le §C1 révisé (voix Voxtral tour-par-tour = ON).
15. **Gate `RUN_POSTGRES_*_CERT` incomplet** : `check-release-env.sh:192-200` n'interdit que 2 variables nommées sur ~28 gates destructrices — étendre à un motif générique (`RUN_POSTGRES_*` posé ≠`false` = release refusée). Petit patch fail-closed, à faire dans un lot dédié (le chemin de release est co-touché par la lane GPT en ce moment).

---

## À confirmer (fondateur / prod)

1. **FONDATEUR — Stripe/release gate** : mode de résolution de l'incohérence n°1 (bloquant première release).
2. **RAILWAY PROD — audit des vars réelles** (accès dashboard) : aucun résidu `OPENAI_REALTIME_*` ni clé `BOB_LIVE_*`/v2 ; valeur réelle d'`ERROR_REPORTER_WEBHOOK_URL` (placeholder suspecté) ; `DATABASE_URL` = `bob_app` pooler session 5432 + `DIRECT_URL` distincte ; `RUN_RLS_CERT`/`RLS_CERT_CLEANUP='true'` posés.
3. **FONDATEUR — passage prod du Railway actuel** (`DEMO_MODE=false`, secrets `bob_app`) : GO explicite requis AVANT tout build EAS store (règle : jamais de build sans GO fondateur).
4. **FONDATEUR — digest hebdo** : `DIGEST_WORKER_ENABLED='true'` dans le périmètre V1 ?
5. **FONDATEUR — domaine définitif (Nico)** : date de bascule TERMS/PRIVACY/SIGNUP_CONFIRMATION/SIGN_WEB + `support@` de marque avant soumission store.
6. **FONDATEUR — analytics produit** : `PRODUCT_ANALYTICS_ENDPOINT` en V1 ou Noop ?
7. **FONDATEUR + GPT — garde Mistral v2** : levée conditionnée à la confirmation par GPT du merge du fix liveness `nextServerSequence` (hors périmètre V1, à tracer).
8. **BREVO — action humaine** : lever la restriction IP + vérifier SPF/DKIM du sender.
9. **VÉRIF PRE-RELEASE — ids `MODEL_CATALOG`** (`claude-opus-4-8`, `claude-sonnet-5`, `mistral-large-latest`, …) encore valides ? Non surclassables sans release de `@bob/ai`.
10. **GPT — accord sur le périmètre C1 révisé** (voix V1 = Voxtral tour-par-tour ON, full-duplex OFF), noté PROGRAMME_V1 l.76.
11. **STAGING — contenu réel de `JOB_COMPANY_IDS` / `JOB_CABINET_IDS`** (couplage manuel avec `CABINET_E2E_PRIMARY_CABINET_ID`).
12. **FONDATEUR — partenaire Plateforme Agréée (PDP)** : choix + inscription annuaire **avant le 01/09/2026** (échéance légale dure, ~6 semaines ; décision cadre actée le 19/07 via AUDIT_INDISPENSABLES). La bascule technique est un chantier code (famille 4), mais le choix du partenaire et l'inscription sont administratifs et ne dépendent d'aucun code.

---

## Bloc machine-readable (source du test anti-drift)

Flags **non sensibles** à valeur figée. `enforcement` : `"default"` = la valeur V1 est le défaut du code (le test vérifie le défaut résolu, var non posée) ; `"posed"` = la valeur V1 est posée explicitement dans l'environnement cible (le test vérifie qu'elle est acceptée et résolue telle quelle). Le test `apps/api/src/flags-matrix-v1.test.ts` fait autorité pour `scope: "api"`.

<!-- FLAGS_V1_JSON_START -->
{
  "flags": [
    { "name": "DEMO_MODE", "v1Value": "false", "scope": "api", "enforcement": "default" },
    { "name": "OPENAI_REALTIME_ENABLED", "v1Value": "false", "scope": "api", "enforcement": "default" },
    { "name": "BOB_LIVE_ENABLED", "v1Value": "false", "scope": "api", "enforcement": "posed" },
    { "name": "BOB_LIVE_PROVIDER", "v1Value": "mistral", "scope": "api", "enforcement": "posed" },
    { "name": "STT_PROVIDER", "v1Value": "mistral", "scope": "api", "enforcement": "posed" },
    { "name": "CABINET_RELEASE_ENV", "v1Value": "production", "scope": "api", "enforcement": "posed" },
    { "name": "BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED", "v1Value": "false", "scope": "api", "enforcement": "default" },
    { "name": "BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED", "v1Value": "false", "scope": "api", "enforcement": "default" },
    { "name": "BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS", "v1Value": 60000, "scope": "api", "enforcement": "default" },
    { "name": "BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_BATCH_SIZE", "v1Value": 10, "scope": "api", "enforcement": "default" },
    { "name": "BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_MAX_BATCHES", "v1Value": 4, "scope": "api", "enforcement": "default" },
    { "name": "BOB_LIVE_AUDIT_PROVIDER", "v1Value": "local-whisper", "scope": "api", "enforcement": "default" },
    { "name": "BOB_LIVE_GATEWAY_TLS_MODE", "v1Value": "direct", "scope": "api", "enforcement": "default" },
    { "name": "MISTRAL_STT_MODEL", "v1Value": "voxtral-mini-latest", "scope": "api", "enforcement": "default" },
    { "name": "MISTRAL_TTS_MODEL", "v1Value": "voxtral-mini-tts-2603", "scope": "api", "enforcement": "default" },
    { "name": "MISTRAL_OCR_MODEL", "v1Value": "mistral-ocr-latest", "scope": "api", "enforcement": "default" },
    { "name": "MISTRAL_OCR_EXTRACT_MODEL", "v1Value": "mistral-small-latest", "scope": "api", "enforcement": "default" },
    { "name": "MISTRAL_REALTIME_STT_MODEL", "v1Value": "voxtral-mini-transcribe-realtime-2602", "scope": "api", "enforcement": "default" },
    { "name": "MISTRAL_REALTIME_BASE_URL", "v1Value": "wss://api.mistral.ai", "scope": "api", "enforcement": "default" },
    { "name": "MISTRAL_REALTIME_TARGET_DELAY_MS", "v1Value": 240, "scope": "api", "enforcement": "default" },
    { "name": "FISCAL_PUBLICODES_SIMULATIONS_ENABLED", "v1Value": "false", "scope": "api", "enforcement": "default" },
    { "name": "FISCAL_PUBLICODES_MAX_CONCURRENCY", "v1Value": 4, "scope": "api", "enforcement": "default" },
    { "name": "SUPABASE_STORAGE_BUCKET", "v1Value": "bob-documents", "scope": "api", "enforcement": "default" },
    { "name": "SUPABASE_REALTIME_AUDIO_BUCKET", "v1Value": "bob-live-audio", "scope": "api", "enforcement": "default" },
    { "name": "CABINET_INVITATION_WORKER_ENABLED", "v1Value": "false", "scope": "api", "enforcement": "default" },
    { "name": "BREVO_API_BASE_URL", "v1Value": "https://api.brevo.com/v3", "scope": "api", "enforcement": "default" },
    { "name": "BREVO_SENDER_NAME", "v1Value": "Bob Pro", "scope": "api", "enforcement": "default" },
    { "name": "EXPO_PUBLIC_API_URL", "v1Value": "https://bob-pro-api-production.up.railway.app", "scope": "mobile", "enforcement": "posed" },
    { "name": "EXPO_PUBLIC_SUPABASE_URL", "v1Value": "https://cvdkqjczgqoeshputacl.supabase.co", "scope": "mobile", "enforcement": "posed" },
    { "name": "EXPO_PUBLIC_TERMS_URL", "v1Value": "https://bob-pro-sign-web.vercel.app/legal/conditions-utilisation", "scope": "mobile", "enforcement": "posed" },
    { "name": "EXPO_PUBLIC_PRIVACY_URL", "v1Value": "https://bob-pro-sign-web.vercel.app/legal/confidentialite", "scope": "mobile", "enforcement": "posed" },
    { "name": "EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL", "v1Value": "https://bob-pro-sign-web.vercel.app/auth/confirme", "scope": "mobile", "enforcement": "posed" },
    { "name": "NEXT_PUBLIC_API_URL", "v1Value": "https://bob-pro-api-production.up.railway.app", "scope": "web", "enforcement": "posed" },
    { "name": "NEXT_PUBLIC_SUPABASE_URL", "v1Value": "https://cvdkqjczgqoeshputacl.supabase.co", "scope": "web", "enforcement": "posed" },
    { "name": "MUSTANG_VERSION", "v1Value": "2.16.1", "scope": "ci", "enforcement": "posed" },
    { "name": "RUN_RLS_CERT", "v1Value": "true", "scope": "ci", "enforcement": "posed" },
    { "name": "RLS_CERT_CLEANUP", "v1Value": "true", "scope": "ci", "enforcement": "posed" }
  ]
}
<!-- FLAGS_V1_JSON_END -->
