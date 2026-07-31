# SPEC SYSTÈME D'ERREUR — autorité dépôt entier

Statut : `implemented` (socle + cas de référence SIRET) · Portée : TOUT le dépôt, y compris les
surfaces revendiquées par l'agent pair (agent/realtime/live), qui APPLIQUE cette spec chez lui.
Mandat fondateur (verbatim) : « Il faut rendre le système d'erreur beaucoup plus puissant,
exhaustif et intelligent afin d'avoir ce qu'il faut pour nous développeurs. Pour l'utilisateur,
les choses doivent être différentes — on applique les meilleurs patterns du sujet. Mais pour
nous, on doit avoir TOUTES les informations nécessaires. »

## 0. Les trois cas terrain (cahier de recette)

Payés par le fondateur en 48 h — toute règle de cette spec se justifie par au moins l'un d'eux :

1. **SIRET** — `customer-form.tsx` faisait `onError: () => setSiretError(true)` : un booléen
   écrasait 404 introuvable / 422 invalide / 429 throttle / 502 annuaire en panne. Le fondateur a
   vu « non trouvé » pour un SIRET que le serveur servait en 200 (chemin plausible : décodage
   client `decode() → null` traduit en `dependency/api-contract`, affiché comme une panne), et
   personne ne pouvait trancher sans les logs Railway.
2. **GATE ENTREPRISE** — « Complète ta fiche » sans nommer le champ manquant (capital social,
   inédittable). Fix en vol sur une autre branche ; le PATTERN est contractualisé ici (§6).
3. **LIVE.ERROR** — « Oups, j'ai buté » écrase admission fermée (503) / session tuée < 1 s
   post-SDP / erreur de tour. Surfaces revendiquées par l'agent pair : contractualisées en §9,
   jamais modifiées ici.

**Le défaut commun** : à chaque frontière, l'information riche du serveur (`AppError` typé,
`correlationId` présent dans CHAQUE ligne de log Railway) est écrasée en booléen ou en phrase
unique. Le diagnostic terrain exige alors un accès aux logs serveur — inacceptable.

## 1. Principes (normatifs)

- **P1 — Deux faces, une vérité.** Toute erreur a une face UTILISATEUR (langage simple,
  actionnable, code court discret) et une face DÉVELOPPEUR (code, kind, correlationId, heure,
  route) accessibles SANS les logs serveur. Les deux faces décrivent le même `AppError`.
- **P2 — Anti-écrasement.** Aucun `onError` ne réduit un `AppError` à un booléen ou à une phrase
  unique. Le couple `kind` + code traverse jusqu'à l'i18n. Toute phrase générique (« Oups »,
  « réessaie ») sans discrimination amont est un DÉFAUT, au même titre qu'un test rouge.
- **P3 — Le mobile ne reformule JAMAIS un message serveur.** Doctrine existante
  (`app-error-message.ts`) : `domain.error.message` et `validation.issues[].message` s'affichent
  TELS QUELS. Le client discrimine et HABILLE (code, action, correlation) ; il ne réécrit pas.
- **P4 — Corrélation bout-en-bout.** Le client GÉNÈRE l'identifiant, l'envoie, le serveur le
  reprend dans ses logs et le REND dans toute réponse d'erreur. Un rapport terrain devient :
  « BOB-SIRET-404, corrélation 98f73810 » → grep direct côté Railway.
- **P5 — Jamais de PII dans les canaux techniques.** Journal local, Sentry, webhook, logs :
  listes blanches uniquement (politique partagée `@bob/core` telemetry-scrubbing). Les `issues`
  de validation, `DomainError`, ids métier (un SIRET est un id) ne sortent jamais de l'écran.
- **P6 — Fail-closed assumé n'alerte pas.** Décision prod 20/07 conservée : `unavailable` est un
  état NORMAL (warn, jamais error, jamais remonté au reporter) ; seul `dependency` (amont
  réellement en panne) est un signal d'exploitation.

## 2. Taxonomie — `AppError` + code court

### 2.1 L'existant (inchangé, fondation)

`packages/core/src/application/result.ts` — union discriminée de 9 kinds :
`domain` / `not_found` / `gone` / `conflict` / `forbidden` / `rate_limited` / `unavailable` /
`validation` / `dependency`. Sérialisée telle quelle par `apps/api/src/http/result.ts::unwrap`
dans le corps `{ ok: false, error }` avec le mapping HTTP :

| kind | HTTP | | kind | HTTP |
|---|---|---|---|---|
| `domain`, `validation` | 422 | | `forbidden` | 403 |
| `not_found` | 404 | | `rate_limited` | 429 |
| `gone` | 410 | | `unavailable` | 503 |
| `conflict` | 409 | | `dependency` | 502 |

### 2.2 Extension : transport (additif)

`AppError` devient `AppErrorTransport & (union inchangée)` avec :

```ts
interface AppErrorTransport {
  code?: string;          // « BOB-<CTX>-<statut> », posé par la frontière client
  correlationId?: string; // identifiant de corrélation, posé par la frontière client
}
```

Règles :
- Les CONSTRUCTEURS du domaine (`appNotFound`, …) ne posent JAMAIS ces champs : un test de
  fermeture le verrouille (`Object.keys` exacts) car `decodeHttpAppError` côté client valide les
  clés EXACTES de l'objet `error` — le serveur ne doit rien y ajouter.
- Seule la frontière HTTP CLIENTE (`req`/`reqText`/`reqRealtimeSpeech`) pose `code` et
  `correlationId`, après décodage. Un `AppError` fabriqué localement (client local, use case pur)
  n'en porte pas — l'affichage retombe sur `bobErrorCode(error, contexte)`.

### 2.3 Le code court — registre FERMÉ

Source d'autorité : `packages/api-client/src/error-codes.ts`. Patron :

```
BOB-<CONTEXTE>-<STATUT>     ex. BOB-SIRET-404, BOB-ADM-503, BOB-API-502
```

- **STATUT** = projection du `kind` (table §2.1, miroir exact de `unwrap`) + le statut `500`
  réservé aux erreurs NON typées (valeur jetée qui n'est pas un `AppError`).
- **CONTEXTE** ∈ registre fermé v1 : `API` (défaut), `SIRET` (annuaire), `ADM` (admission Bob
  Live), `LIVE` (session/tour Bob Live). Dérivé de la ROUTE par une table fermée :
  `POST /voice/realtime/calls → ADM` · `/voice/realtime/* → LIVE` · `/company/lookup → SIRET` ·
  sinon `API`.
- Le code est une **PROJECTION CALCULÉE**, jamais un état stocké ni transmis par le serveur :
  aucune dérive serveur/client possible ; le serveur reste diagnosticable par (kind,
  correlationId) et le développeur traduit code → kind en grep-ant le registre.
- **Fermeture** : `error-codes.test.ts` verrouille la liste littérale complète des codes, le
  patron `^BOB-[A-Z]{2,6}-\d{3}$`, l'unicité, la table kind→statut et la table route→contexte.
  Ajouter un contexte = éditer le registre + le test + cette spec (rituel conscient, jamais une
  chaîne libre dans un écran).
- Lisible AU TÉLÉPHONE : lettres majuscules + 3 chiffres, prononçable (« bob siret quatre cent
  quatre »).

### 2.4 Codes remarquables (v1)

| Code | Sens | Cas terrain |
|---|---|---|
| BOB-SIRET-404 | SIRET inconnu de l'annuaire | cas 1 |
| BOB-SIRET-422 | SIRET invalide (format/Luhn) | cas 1 |
| BOB-SIRET-429 | notre throttle du lookup (avec délai) | cas 1 |
| BOB-SIRET-502 | annuaire en panne OU réponse annuaire illisible (`api-contract`) | cas 1 — le « 200 vu comme non trouvé » |
| BOB-ADM-503 | admission Bob Live fermée | cas 3 |
| BOB-LIVE-410 | session Bob Live terminée côté serveur | cas 3 |
| BOB-LIVE-502 | tour Bob Live en échec (amont) | cas 3 |
| BOB-API-500 | erreur non typée (défaut de programmation) | filet |

## 3. Corrélation bout-en-bout (contrat de fil)

### 3.1 Sens client → serveur

- Chaque requête des trois chemins (`req`, `reqText`, `reqRealtimeSpeech`) génère un
  `correlationId` (UUID v4 ; repli non cryptographique documenté si `crypto.randomUUID` absent —
  c'est un identifiant de corrélation, pas un secret) et l'envoie en header **`x-correlation-id`**.
- `CorrelationMiddleware` (apps/api) reprend, PAR PRIORITÉ : `x-correlation-id` valide, sinon
  `x-request-id` valide (legacy), sinon `randomUUID()`. VALIDE = `^[A-Za-z0-9-]{8,64}$` — un
  header hors patron (injection de logs, taille) est REMPLACÉ, jamais propagé.
- L'identifiant vit dans `AsyncLocalStorage` et sort dans CHAQUE ligne pino (`http`, refus,
  warn/error, audit) — mécanique existante inchangée.

### 3.2 Sens serveur → client

- Headers réponse : `x-request-id` (existant, conservé) + `x-correlation-id` (nouveau), sur
  TOUTES les réponses.
- **Corps de toute réponse d'erreur** : `AllExceptionsFilter` enrichit le corps objet en
  `{ ...body, correlationId }` (et un corps chaîne en `{ message, correlationId }`) quand un
  contexte de requête existe. ADDITIF au niveau RACINE du corps, jamais DANS `error` :
  `decodeHttpAppError` (client déployé) valide les clés exactes de `error` et rejetterait un
  champ intrus — la rétro-compat des décodeurs est prouvée par test.
- Le client attache au `Result` d'erreur : `correlationId = corps.correlationId ??
  header x-request-id ?? id généré localement`. Ainsi : nouveau serveur → id unique partagé ;
  ancien serveur → id serveur via header ; aucune réponse (réseau) → id local (identité de
  l'événement dans le journal et Sentry, même sans ligne serveur).

### 3.3 Affichage

- L'écran montre la forme COURTE (8 premiers caractères, `shortCorrelationId`) sur la face
  développeur ; la forme longue part dans le texte de partage. Grep Railway : la forme courte
  suffit (préfixe d'UUID).

## 4. La frontière client (`packages/api-client`)

- `req()` lit désormais le STATUT AVANT de dépendre du JSON : une réponse d'erreur au corps
  non-JSON (page HTML d'un 502 Railway/edge) devient
  `dependency/api « HTTP <status> (réponse non JSON). »` — plus jamais confondue avec une
  coupure réseau. Les sentinelles locales (timeout, annulation) gardent leurs messages EXACTS
  (`isRealtimeBootstrapTimeoutError` en dépend) via une classe d'interruption locale dédiée.
- Un `decode()` nul sur un 2xx reste `dependency/api-contract` mais porte désormais code +
  correlationId — le « 200 vu comme non trouvé » du cas 1 devient diagnosticable à l'écran.
- `HttpBobClientOptions.onError?: (report: ApiErrorReport) => void` : chaque Result d'échec émet
  un rapport `{ at, method, path EXPURGÉ, status|null, durationMs, code, error }`. L'émission ne
  jette JAMAIS (un observateur défaillant ne casse pas la requête). Le chemin (`path`) est
  expurgé par `redactPathForDiagnostics` : query string SUPPRIMÉE (elle peut porter un SIRET),
  segments UUID/numériques/jetons remplacés (`:id`, `:num`, `:token`).

## 5. Le socle mobile (`apps/mobile`)

### 5.1 Journal local (`src/data/error-journal.ts`)

- Ring buffer BORNÉ (50 entrées, clé `bob.errorJournal.v1`, AsyncStorage) alimenté par le hook
  `onError` du client (`src/observability/api-failure-reporter.ts`, branché dans
  `data/client.tsx`).
- Entrée = `{ at, code, kind, correlationId|null, method, path expurgé, status|null,
  durationMs|null }`. **JAMAIS** de cause, message, issues, entity/id (liste blanche par
  construction, ré-expurgation défensive du chemin à l'entrée).
- Logique pure testée seule (append borné, parse tolérant — une entrée corrompue est écartée,
  jamais le journal entier), persistance sérialisée (file d'écriture), échec de stockage
  silencieux (best-effort, patron `settings.ts`).

### 5.2 Écran « Diagnostic technique » (`app/diagnostic-technique.tsx`)

- Nouvelle route (le `/diagnostic` existant est le diagnostic COMPTABLE — intouché), entrée
  depuis Mon compte. Sobre : les N derniers échecs (code fort, corrélation courte, heure,
  méthode+route, statut), état du canal de crash (actif/dormant — répond à « la télémétrie de ce
  build est-elle vivante ? »), actions **Partager** (texte composé SANS PII :
  `journalShareText`) et **Vider**.

### 5.3 Sentry (existant, complété)

- `initCrashReporter` était DÉJÀ branché (`_layout.tsx`) avec DSN UE (eas.json) et scrubbing
  partagé — ne pas réécrire. Complété par : canal DORMANT en build dev (`__DEV__`) et premier
  SITE D'APPEL réel de `captureCrash` : les échecs API `kind === 'dependency'` remontent en tags
  (code, kind, port, correlationId, méthode, chemin expurgé, statut) — cohérent avec P6
  (`unavailable` et les 4xx n'alertent jamais). Ces sept clés sont portées par la liste blanche
  PARTAGÉE `ALLOWED_TAG_KEYS` (`@bob/core` telemetry-scrubbing) : le contrat d'écriture et la
  politique de sortie sont le MÊME registre, pas deux listes qui dérivent en silence. Le `chemin`
  est le TEMPLATE de route (`redactPathForDiagnostics` — query supprimée, id/num/token remplacés),
  jamais un id concret ; défense en profondeur, `safeText` re-masque tout motif PII résiduel.
  Étanchéité prouvée par test : un id/e-mail/SIRET injecté dans chacun de ces champs en ressort
  masqué, jamais transmis.

## 6. Les deux faces à l'écran — `ErrorNotice` (`packages/ui`)

- Face utilisateur : message i18n actionnable (quoi + quoi faire), code court discret en chip.
- Face développeur : repli au chevron (cible 44 pt) ou appui long — kind, corrélation complète,
  heure, bouton Partager (texte `errorNoticeReportText`, sans PII). Chrome i18n ×3 tons résolu
  dans le composant (personnalité du thème).
- A11y : `accessibilityRole="alert"` + live region sur le message ; le repli est un bouton nommé.
- **Règle gate (cas 2)** : tout refus `validation` NOMME le champ dans `issues[].message`
  (fabriqué serveur, affiché tel quel — P3) ; « Complète ta fiche » sans champ nommé est un
  défaut de spec serveur, pas un problème d'écran.

## 7. Journalisation serveur (`apps/api`)

- Existant conservé : ligne `http` par requête ; 5xx porteurs d'AppError → warn « dépendance
  indisponible » (résumé LISTE BLANCHE `appErrorLogSummary`) ; seuls les `dependency` remontent
  au reporter ; autres 5xx → error + capture.
- **Nouveau** : les 4xx porteurs d'un AppError loggent `info` « refus applicatif »
  `{ correlationId, status, appError: résumé liste blanche }`. Le 404/422 SIRET du cas 1 devient
  visible dans Railway au-delà du statut, grep-able par corrélation. Niveau `info` : un refus
  4xx est un fonctionnement NORMAL (jamais warn/error, jamais reporter — P6 intact).

## 8. Règle anti-écrasement — application

- Interdits (défauts à corriger en revue) : `onError: () => setX(true)` ; `catch` → copy unique ;
  `alertError` générique sur un flux discriminable ; toute clé i18n d'erreur SANS variante par
  motif quand les kinds diffèrent ; réécrire un message `domain`/`validation` serveur.
- Patron de référence : discriminateur PUR partagé (`src/lib/siret-lookup-error.ts`) →
  `Record<motif, I18nKey>` par écran → `ErrorNotice`. Deux motifs peuvent PARTAGER une copy si
  (et seulement si) l'ACTION utilisateur est identique — le code court, lui, reste distinct.
- Cimetière recensé (17 sites, les pires : `customer-form.tsx:176` — corrigé ici, vitrine ;
  `app-error-message.ts` fallbacks muets ; `hooks.ts:71-73 alertError` — ADD-only, dette listée ;
  `CustomerBillingSections.tsx:157,175` ; `iban-edit-sheet.tsx:54`) : chaque site migre vers le
  patron à sa prochaine retouche d'écran.

## 9. Contrat pour les surfaces de l'agent pair (lecture seule ici)

Les chemins claim (`apps/mobile/src/agent/**`, `src/realtime/**`, `apps/api/src/voice/realtime/**`,
`packages/ai/src/agent/**`, …) APPLIQUENT chez eux :

1. `live.error` n'est plus une copy unique : discrimination minimale exigée —
   **admission fermée** (`unavailable`/503 → BOB-ADM-503, proposer réessai + heure), **session
   terminée côté serveur** (`gone`/410 → BOB-LIVE-410, proposer relance de session), **tour en
   échec** (`dependency`/502 → BOB-LIVE-502, réécoute/dictée hors-ligne), défaut BOB-LIVE-xxx.
2. Toute surface d'erreur vocale AFFICHE (ou énonce) le code court et journalise via le même
   `onError` du client (les routes realtime sont déjà couvertes par la table route→contexte).
3. Aucun `catch` de la boucle vocale n'avale un `AppError` sans le pousser vers le journal.
4. Les clés i18n `live.error` / `agent.global.error` existantes restent, complétées par des
   variantes par motif (×3 tons) — jamais modifiées ici.

## 10. Definition of Done du socle (binaire)

- [x] Corps d'erreur serveur enrichi `correlationId` racine + rétro-compat décodeurs prouvée par
      test (ancien client × nouveau serveur, nouveau client × ancien serveur).
- [x] `x-correlation-id` accepté (validé) et repris par le middleware ; headers réponse doublés.
- [x] Registre de codes fermé + test de verrouillage (liste littérale, patron, unicité, tables).
- [x] Trois chemins de requête client : header envoyé + code/correlationId attachés + rapport émis.
- [x] 502 non-JSON discriminé d'une coupure réseau ; sentinelles timeout INCHANGÉES (test).
- [x] Journal local borné sans PII + écran Diagnostic technique + partage sans PII.
- [x] Sentry : dormant en dev, `captureCrash` a un site d'appel réel (dependency uniquement).
- [x] 4xx AppError journalisés côté serveur en `info` avec résumé liste blanche.
- [x] Vitrine SIRET : 404/422/429/502-503/contract discriminés, ErrorNotice, îlot
      `lookupErrorKey` dédupliqué (Login + Provisioning consomment le module partagé).
- [ ] Surfaces agent pair migrées (§9) — hors de ce chantier, contrat posé.

## 11. Rituel d'extension (pour tout futur écran/domaine)

1. Choisir le contexte (existant, sinon l'AJOUTER au registre + test + §2.4).
2. Écrire le discriminateur PUR (fichier `src/lib/*-error.ts`, testé, mutants vus mourir).
3. Clés i18n par motif ×3 tons ; l'action utilisateur d'abord, le jargon jamais.
4. `ErrorNotice` à l'écran (jamais un `Text` rouge nu pour un flux discriminable).
5. Vérifier : le rapport « code + corrélation » lu au téléphone suffit-il pour grep Railway et
   comprendre SANS déployer ? Sinon, la copy ou le log manque — recommencer.
