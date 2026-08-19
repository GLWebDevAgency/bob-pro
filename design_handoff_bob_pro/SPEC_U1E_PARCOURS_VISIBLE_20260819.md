# SPEC U1-e — Le parcours visible : découverte, relecture autoritaire, écran

- **Date** : 2026-08-19 · **Auteur** : Claude (bâton fondateur) · **Méthode** : cartographie
  4 lecteurs (wf_3efb8f94, 100+ faits `fichier:ligne`). Contre-lecture GPT attendue, non bloquante.
- **Parents** : SPEC_U1D (callers réels) · spec Jarvis §7.1/§8/§9.1/§14/§19.3-19.5 · FD-02 (grille).
- **Périmètre** : fermer les trois manques nommés dans la PR #97 — l'écran, la modification
  confirmable, l'annuaire de purge — dans **cet ordre de dépendance**, plus la preuve device.

## 1. La découverte d'abord (bloqueur amont, révélé par la cartographie)

Monter la carte ne montrerait **rien** : l'appareil ne peut pas connaître le `runId`. La voix ne
le renvoie pas (l'issue ne porte que la parole), aucune route « run courant » n'existe, et un tap
ne peut pas semer un run (`expectedRevision ≥ 1`). U1-e commence donc par la **découverte** :

- `GET /jarvis/runs/current` — miroir exact du précédent `agent-missions/current/.../resume` :
  rend le run non terminal de l'owner (kind + runId + revision + présentation), ou `null`.
  Owner-scopé, lecture stateless (zéro verrou, zéro write), throttle du patron.
- **Ouverture depuis l'écran** : `POST /jarvis/runs` (route dédiée, jamais un élargissement du
  canal de commandes) qui sème un run `customer_contact@1` avec l'intention `update` ciblée —
  `expectedRevision = 0`, autorité `authenticated_principal`, `effectId` serveur.
- Côté mobile : `AgentMissionRecoveryProvider` a le patron (loader owner-scopé, `gcTime` 0) ;
  un `useJarvisRunFrame(runId)` calqué sur `useQuoteScreenMissionBinding` porte l'état.

## 2. La relecture autoritaire (le vrai défaut de `client-modifier@1`)

Le domaine exige au `confirm` d'une modification `revalidatedTargetRevision` et
`revalidatedSensitiveDigest`. **Aucune source serveur ne les produit** — l'e2e les fabriquait à
la main. Quatre lieux possibles, un seul juste :

| Lieu | Verdict |
|---|---|
| Mobile | ✗ auto-certification (le client signerait sa propre cible) |
| Controller (hors transaction) | ✗ TOCTOU : la cible peut changer entre lecture et commit |
| Store de présentation | ✗ le sceau se certifierait lui-même |
| **Admission, dans LA transaction** | ✓ relecture sous verrou, digest dérivé, comparé au sceau |

Décision : la commande `confirm` d'une update **n'accepte plus ces champs du wire** ; l'admission
relit la cible et dérive le digest **dans la transaction**, puis les fournit à la réduction. Le
wire s'appauvrit — c'est le sens de la marche : ce que le client ne peut pas prouver, il ne
l'affirme plus.

⚠️ Prérequis découvert : `customers` **n'a ni révision ni `updatedAt`** (contrairement aux
contacts). U1-e ajoute la colonne de révision (expand additif, défaut 1, incrément par le use
case canonique) — sinon aucune détection de dérive n'est possible, et la garde §9.1 (« mutation
entre présentation et confirm ⇒ invalidated ») resterait une promesse creuse.

## 3. L'écran (deux hôtes, un composant)

- **Onglet assistant** — hôte primaire : c'est déjà la destination du handoff voix→écran, le fil
  y rend la même grammaire (bulle → diff → garde-fou → Annuler/Confirmer), et le catalogue y
  épingle `bob-action-confirmer@1`. La carte s'y insère comme item sœur.
- **Fiche client** — hôte de `client-modifier@1` (surface cataloguée, sans gate d'entitlement,
  seul écran qui possède l'« avant »), ancrée avant les actions rapides, gatée sur
  `intent === 'update' && cible === id`.
- **Câblage** : registre de `commandId` **injecté** depuis le provider global (jamais le registre
  privé du coordinateur — un remontage transformerait un retry en seconde commande) ;
  `randomUUID` d'expo-crypto ; `useBobClient` avec narrowing des méthodes optionnelles ;
  `onAuthoritativeRefresh` = relecture + invalidation des préfixes existants (`customers` y est).
- Le baril `src/agent/index.ts` gagne ses exports Jarvis.

## 4. L'annuaire de purge (patron réduit du reaper)

Rôle d'autorité NOLOGIN/NOBYPASSRLS + policy `current_user = '<rôle>'` sur
`jarvis_proposal_payloads` (les policies owner-scopées **inchangées**) + fonction
`list_jarvis_payload_retention_owners_v1(companyId, batchLimit)` créée SECURITY INVOKER par la
migration puis basculée SECURITY DEFINER par le bloc de provisionnement de `release.sh`, avec
`EXECUTE` au seul rôle applicatif et **GRANT par colonne excluant `payload`**. Ne pas copier les
helpers cabinet `SET row_security = off`.

## 5. Preuve device — sans build EAS (règle fondateur : jamais sans GO)

- **É0, en CI** : la carte montée dans une **route réelle** (le harnais monte déjà 17 écrans
  expo-router), appuis, enchaînement ack → presented → Confirmer, erreur port + Réessayer,
  cible 44 pt, accessibilité ; oracles et annuaire en vitest+PostgreSQL.
- **É1, cette machine, zéro crédit EAS** : `prebuild` local + `expo run:ios` (simulateur, aucune
  signature) — captures versionnées et ligne CLAIMS.
- **É2** : Expo Go **écarté** (module natif maison, WebRTC patché, config plugins).
- **É3, bloqué** : device physique du fondateur ⇒ **demande un GO explicite** pour un build EAS.
  Jamais lancé de ma main.

## 6. Non-objectifs

Contacts CRUD, autres actions du catalogue, mandats, activation des flags (OFF), refactor de
`captureForQuoteScreen`, tout renommage.
