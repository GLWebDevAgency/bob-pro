# URLs sortantes & redirections — source de vérité par environnement

> Audit complet du 2026-07-18 (bug fondateur « email de confirmation → localhost »).
> Règle absolue : **aucune URL sortante en dur dans le code** — tout passe par une variable
> d'environnement validée (HTTPS live canonique, jamais `localhost`/`demo.bobpro.fr` en prod).

## 1. Le bug et sa cause exacte

L'inscription mobile (`apps/mobile/src/data/auth.tsx` → `supabase.auth.signUp`) n'envoyait
**aucun `emailRedirectTo`**. GoTrue (Supabase Auth) redirige alors le lien de confirmation vers
la **Site URL** du projet, dont la valeur par défaut est `http://localhost:3000` → email de
confirmation inutilisable pour tout utilisateur réel (onboarding « Fly Services »).

Correctif code (2026-07-18) :

- `signUp` **et** `resend` envoient `emailRedirectTo` explicite :
  page relais `EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL` (sign-web `/auth/confirme`),
  repli deep link `bobpro://auth/callback` si la variable est absente ;
- nouvelle page relais `apps/sign-web/app/auth/confirme/page.tsx` : « Compte confirmé —
  retourne dans l'app », relaie query+fragment vers le deep link, tente l'ouverture auto,
  repli texte (email lu sur ordinateur), nettoie l'URL du navigateur ;
- nouvelle route native `bobpro://auth/callback` (`apps/mobile/app/auth/callback.tsx` +
  `src/screens/EmailConfirmationScreen.tsx` + `src/auth-confirmation/email-confirmation.ts`) :
  échange PKCE → session immédiate, sinon « compte confirmé, connecte-toi » ;
- écran de connexion : erreur `email_not_confirmed` → lien « Renvoyer l'email de
  confirmation » (le renvoi part avec la NOUVELLE redirection — débloque les comptes créés
  avant le correctif sans les recréer).

## 2. À CONFIGURER DANS LE DASHBOARD SUPABASE (action humaine)

**Cette configuration est à poser sur CHAQUE projet Supabase, sans exception** —
production `cvdkqjczgqoeshputacl` **et** staging `afywrrzjjuyznewzvpmk`. Un projet neuf
naît avec `http://localhost:3000` en Site URL et une allowlist vide : il reproduit le bug
à l'identique. Dans chaque projet → **Authentication → URL Configuration** :

| Champ | Valeur exacte à saisir |
| --- | --- |
| **Site URL** | `https://bob-pro-sign-web.vercel.app/auth/confirme` |
| **Redirect URLs** (une ligne chacune) | `bobpro://auth/callback` |
| | `bobpro://auth/recovery` |
| | `https://bob-pro-sign-web.vercel.app/auth/confirme` |
| | *(optionnel, previews Vercel)* `https://bob-pro-sign-web-*-glwebdevagencys-projects.vercel.app/auth/confirme` |

Pourquoi la Site URL pointe la page relais : c'est le **filet de sécurité** — tout
`redirect_to` refusé/absent retombe dessus, et la page sait relayer confirmation **et**
recovery (`type=recovery`) vers le bon deep link. Plus jamais localhost.

Rappel : « Leaked Password Protection » reste aussi à activer (Auth → dashboard, WARN advisor).

### Vérifier au lieu de croire — `pnpm --filter @bob/mobile verifie:redirections-auth`

Cette configuration vit dans un dashboard, hors du dépôt : ni la revue ni la CI ne la voient,
et c'est précisément ce qui a permis au bug de revenir le **29/07/2026** sur le projet de
staging créé par db53eb67, six jours après avoir été corrigé sur la production.

`apps/mobile/scripts/verifie-redirections-auth.mjs` rend cet état lisible. Il envoie à
`/auth/v1/verify` un jeton volontairement invalide assorti de chaque `redirect_to` attendu :
GoTrue n'honore la cible que si elle est allowlistée, sinon il retombe sur la Site URL — la
redirection renvoyée dit donc la configuration réelle du projet. La Site URL doit correspondre
**exactement** au relais versionné du profil ; « distante » ne suffit pas. Chaque requête est
bornée à huit secondes. Rien n'est écrit, rien n'est consommé, aucun jeton d'administration
n'est requis. Le script sort non nul et **nomme** ce qui manque
(`SITE_URL_ATTENDUE_ABSENTE`, `SITE_URL_LOCALHOST`, `SITE_URL_INATTENDUE`,
`RETOUR_LOCALHOST`, `CIBLE_NON_AUTORISEE`, `REDIRECTION_ABSENTE`, `SONDE_TIMEOUT`,
`SONDE_INJOIGNABLE`).

**À lancer après toute création de projet Supabase, et avant tout build EAS destiné à un
testeur** : un binaire distribué avec une allowlist incomplète rend l'inscription impossible
sans qu'aucun test du dépôt ne s'en aperçoive.

## 3. Inventaire des URLs sortantes (audit ②)

| # | Source (code) | Variable d'env | Valeur prod actuelle | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Email **confirmation d'inscription** — `auth.tsx` `signUp`/`resend` | `EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL` (+ Site URL/Redirect URLs dashboard) | `https://bob-pro-sign-web.vercel.app/auth/confirme` | ✅ Code + profils EAS + dashboards staging/production certifiés le 29/07/2026 par la sonde du §2 |
| 2 | Email **reset mot de passe** — `auth.tsx` `resetPasswordForEmail` | — (deep link constant `bobpro://auth/recovery`) | `bobpro://auth/recovery` | ✅ Code + allowlists staging/production certifiés le 29/07/2026 par la sonde du §2 |
| 3 | **Lien de signature devis** — `backend.service.ts` `publicSignatureUrl` (email Brevo + `signatureUrl` API) | `SIGN_WEB_BASE_URL` | `https://bob-pro-sign-web.vercel.app` (posée sur Railway) | ✅ OK — origine durcie (`signWebOrigin` : HTTPS, refus localhost/démo/credentials/query/hash) ; `loadEnv` la rend obligatoire hors démo |
| 4 | **Lien de visualisation devis/facture** — `publicDocumentViewUrl` (`/view/:token`) | `SIGN_WEB_BASE_URL` (même origine) | idem | ✅ OK — même garde |
| 5 | **PDF / aperçus** — `documents/storage.ts` `getSignedUrl` | `SUPABASE_URL` + `SUPABASE_STORAGE_BUCKET` | `https://cvdkqjczgqoeshputacl.supabase.co`, bucket `bob-documents` | ✅ OK — URL signée émise par Supabase Storage (host = SUPABASE_URL), TTL 300 s (`backend.service.ts`), bucket privé |
| 6 | **Emails Brevo** — `notifications/notifier.ts` | `BREVO_API_BASE_URL` (défaut `https://api.brevo.com/v3`) | défaut | ✅ OK — pas de template hébergé : corps composés dans le code ; seules URLs embarquées = n°3 (signature) et n°7 (invitation), toutes deux durcies |
| 7 | **Invitation cabinet** — `cabinet-api.service.ts` (token en fragment `#invitation=`) | `CABINET_INVITATION_WEB_BASE_URL` | *(à poser au lancement cabinet — worker désactivé)* | 🟡 OK côté code (HTTPS live exigé, obligatoire hors démo) ; valeur prod à créer quand l'espace cabinet sera publié |
| 8 | **Retour paiement Stripe** — `payment-gateway.ts` + `paymentReturnUrl` (`/abonnement/succes`, `/abonnement/annule`, `/compte`) | `PAYMENT_RETURN_BASE_URL` | *(absente — early-access assumé, gateway désactivé)* | 🟢 NOTÉ POUR PLUS TARD — config Stripe partielle = crash volontaire au boot ; complète = URL HTTPS live exigée |
| 9 | **Pages sign-web → API** — `sign/[token]`, `view/[token]` | `NEXT_PUBLIC_API_URL` | `https://bob-pro-api-production.up.railway.app` (Vercel prod+preview) | 🟠 corrigé — le repli `http://localhost:3000` s'appliquait aussi en build prod si env absente ; désormais dev-only, erreur explicite sinon |
| 10 | **Mobile → API** — `EXPO_PUBLIC_API_URL` (`mobile-data-mode.ts`) | `EXPO_PUBLIC_API_URL` | `https://bob-pro-api-production.up.railway.app` | ✅ OK — requise, aucun repli embarqué |
| 11 | **CGU / confidentialité / support** — `src/config/legal.ts` | `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_PRIVACY_URL`, `EXPO_PUBLIC_SUPPORT_EMAIL` | pages légales sign-web (`/legal/...`) | ✅ OK — requises, HTTPS exigé par le garde de build |
| 12 | **CORS API** — `config/cors.ts` | `CORS_ORIGINS` (+ `SIGN_WEB_BASE_URL` auto-inclus) | inclut `https://bob-pro-sign-web.vercel.app` | ✅ OK — allowlist stricte en production |

Hors périmètre utilisateur (appels sortants techniques, tous durcis dans `config/env.ts`) :
fournisseurs IA (`api.mistral.ai`/`api.openai.com` imposés en prod), JWKS Supabase, webhook
erreurs (`ERROR_REPORTER_WEBHOOK_URL`), sidecar audit loopback.

## 4. Matrice des valeurs par environnement (③)

### Mobile (Expo — variables `EXPO_PUBLIC_*`, inlinées au build)

| Variable | Dev local | Preview/QA (APK staging) | Production |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | `http://<ip-locale>:3000` | `https://bob-pro-api-staging.up.railway.app` | `https://bob-pro-api-production.up.railway.app` |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://cvdkqjczgqoeshputacl.supabase.co` | `https://afywrrzjjuyznewzvpmk.supabase.co` (projet staging distinct) | `https://cvdkqjczgqoeshputacl.supabase.co` |
| `EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL` | *(vide → deep link direct)* | `https://bob-pro-sign-web.vercel.app/auth/confirme` | `https://bob-pro-sign-web.vercel.app/auth/confirme` |
| Deep links retour auth | `bobpro://auth/callback` + `bobpro://auth/recovery` (dev client, scheme `bobpro` d'app.json) | idem | idem |

### API (Railway)

| Variable | Dev local | Staging (`bob-pro-api-staging`) | Production (`bob-pro-api-production`) |
| --- | --- | --- | --- |
| `SIGN_WEB_BASE_URL` | *(démo : optionnelle)* | `https://bob-pro-sign-web.vercel.app` | `https://bob-pro-sign-web.vercel.app` |
| `CABINET_INVITATION_WEB_BASE_URL` | *(démo : optionnelle)* | à poser au lancement cabinet | à poser au lancement cabinet |
| `PAYMENT_RETURN_BASE_URL` | absente | absente (early-access) | absente (early-access) — à poser avec TOUT le bloc Stripe |
| `CORS_ORIGINS` | *(hors prod : origin libre)* | URL sign-web (+ previews utiles) | `https://bob-pro-sign-web.vercel.app` |

### sign-web (Vercel `bob-pro-sign-web`)

| Variable | Dev local | Preview | Production |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | *(vide → repli localhost dev-only)* | `https://bob-pro-api-production.up.railway.app` (posée) | `https://bob-pro-api-production.up.railway.app` |

## 5. État opérationnel et dernière preuve à obtenir

1. ✅ **Dashboards Supabase staging + production** : Site URL et les 3 Redirect URLs du §2 ;
   sonde réelle 8/8 verte le 29/07/2026.
2. ✅ **Profils EAS preview + production** : relais web et projets Supabase distincts versionnés
   dans `apps/mobile/eas.json`.
3. ✅ **sign-web** : `/auth/confirme` répond HTTP 200 le 29/07/2026.
4. ⏳ **Preuve appareil/e-mail** : Fly Services ouvre l'app, se connecte puis utilise
   « Renvoyer l'email de confirmation » ; tester aussi un reset de mot de passe sur le même APK.
5. Plus tard : `CABINET_INVITATION_WEB_BASE_URL` (lancement cabinet) et bloc Stripe complet
   avec `PAYMENT_RETURN_BASE_URL` (fin early-access).
