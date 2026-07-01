# Livrabilité stores (App Store / Google Play) — état

Évaluation de la capacité à publier Bob Pro. Deux périmètres, évalués séparément :
**Mobile / soumission** (Claude) et **Backend / prod / infra** (Codex, section à compléter).

## Verdict mobile : ⛔ pas encore publiable

L'app est **fonctionnellement complète** et tourne (en mode démo hors-ligne), mais il manque le **packaging de
publication** (identité visuelle, pipeline de build, déclarations Apple/Play, backend de prod câblé).

### 🔴 Bloquants (empêchent une build/soumission)
| # | Manque | Détail |
|---|---|---|
| B1 | **Aucune icône d'app** | Pas de dossier `apps/mobile/assets/`, aucune `icon` déclarée dans `app.json`. EAS build échoue ; les deux stores l'exigent. |
| B2 | **Aucune icône adaptative Android** | `android.adaptiveIcon` absent — requis par Play. |
| B3 | **Pas de `eas.json`** | Aucun profil de build/submit (dev/preview/production) ni identifiants de soumission. Sans lui, pas de `.ipa`/`.aab`. |
| B4 | **Backend de prod non câblé** | Le mobile démarre en `LocalBobClient` (fixtures) sauf si `EXPO_PUBLIC_API_URL` pointe une API déployée ([client.tsx](../apps/mobile/src/data/client.tsx)). Une vraie soumission a besoin du backend NestJS **déployé** (périmètre Codex) + l'URL injectée au build. |

### 🟠 Importants (nécessaires avant une vraie mise en ligne)
| # | Manque | Détail |
|---|---|---|
| I1 | **Politique de confidentialité (URL publique)** | Exigée par Apple ET Play. On a `docs/compliance/` mais pas de page publique liée. |
| I2 | **Questionnaire de confidentialité** | App Store « App Privacy » + Play « Data safety » à remplir (données collectées : compte, factures, voix, OCR). Base = notre [registre des traitements](compliance/registre-des-traitements.md). |
| I3 | **Privacy Manifest iOS** (`PrivacyInfo.xcprivacy`) | Requis par Apple (API à « raison requise »). Expo SDK 56 en génère une base ; les déclarations de collecte restent à valider. |
| I4 | **Descriptions d'usage micro/voix** | `expo-image-picker` a bien ses strings caméra/photos, mais `expo-speech-recognition`/`expo-audio` reposent sur les défauts du plugin — à **personnaliser en FR** (micro + reconnaissance vocale) pour éviter un rejet. |
| I5 | **Écran de démarrage (splash) + assets store** | `splash` n'a qu'une couleur de fond ; pas d'image. Screenshots, textes de fiche, mots-clés à produire. |
| I6 | **Compte développeur + fiches** | Apple Developer (99 $/an) et Google Play (25 $ unique), création des fiches, build number/versionCode gérés par EAS. |

### 🟢 Déjà prêt
- **Identité** : nom « Bob Pro », `slug`, `scheme` `bobpro`, bundle `fr.bobpro.app` (iOS + Android), version `1.0.0`.
- **Permissions caméra/photos** avec descriptions FR ([app.json](../apps/mobile/app.json)).
- **Plugins natifs** déclarés (router, font, secure-store, image-picker, speech-recognition, audio, sharing) ; New Architecture activée.
- **App fonctionnelle** : parcours complets (devis→facture→encaissement, documents, compta, clôture, assistant voix), parité avec/sans IA, mode démo déterministe hors-ligne.

### Chemin le plus court vers une build de test (TestFlight / Internal testing)
1. Ajouter icône (1024²) + icône adaptative Android + splash → `assets/` + `app.json`.
2. Créer `eas.json` (profils `preview`/`production`) ; `eas build -p ios/android`.
3. Déployer le backend (périmètre Codex) et builder avec `EXPO_PUBLIC_API_URL` = URL prod (sinon build « démo » assumée).
4. Personnaliser les usage descriptions micro/voix ; générer/valider le privacy manifest.
5. Publier une politique de confidentialité, remplir les formulaires App Privacy / Data safety.
6. `eas submit` → TestFlight / Play Internal testing.

## Verdict backend / prod (Codex — à compléter)
> Déploiement API NestJS, env/secrets prod, Postgres/Supabase prod + rôle non-superuser (RLS mordante),
> migrations, monitoring/observabilité, rate-limit, sauvegardes, DPA sous-traitants signés.
> _(Section renseignée par l'évaluation backend de Codex.)_
