# Conception écrans — Vague P1 « Le métier de la maintenance » — RÉVISION 2

**Document de conception (aucun code). Base : main `dceaf6e4`, lecture seule du dépôt Bob Pro. Révision intégrant la revue adversariale (16 problèmes + 16 améliorations) — aligné sur la RÉVISION 2 du document domaine (période contractuelle arithmétique, couverture dérivée des factures, contrats B2B/B2G, file offline unifiée, `contractId` seul discriminant).**
Compagnon UI des PR-08 → PR-24. Gouvernance AGENTS.md : cap V1/feature freeze — accord Claude+GPT puis GO par PR ; PR → staging validé → prod ; aucun build EAS sans GO.

**Directives visuelles : les 4 documents (`01-experience-vision`, `03-motion-interaction-system`, `06-screen-by-screen-spec`, `08-accessibility-adaptive-design` sous [`docs/mobile-experience`](../../mobile-experience/README.md)) lus intégralement ; statut « Proposed » respecté (baseline runtime `@bob/tokens.motion` tant que les ADR ne sont pas actés).**

---

## 0. Cadre et décisions structurantes

1. **Chrome global INTACT** : tab bar, `AppHeaderNavy`, `InnerScreenHeader` inchangés ; tous les écrans P1 = sous-écrans hors tabs.
2. **Matière Bob, jamais la transparence iOS** : surfaces teintées tokens, opacités pré-composées en hex ; blur uniquement plans Action/Navigation, jamais sur une carte de contenu.
3. **Vérité avant spectacle** : aucun succès visuel avant ACK backend — nuance offline honnête : un geste capturé hors-ligne est un fait local réel (« enregistré sur l'appareil, à synchroniser ») ; le succès de *synchronisation* n'est joué qu'après ACK. Conflit affiché, jamais écrasé.
4. **États dérivés, jamais inventés** : chaque badge/CTA découle des machines à états C1/C2/C3 ou d'une dérivation pure. Doctrine `ui-states.tsx` : un échec n'est jamais un vide ; `EmptyState`/`ErrorRetry` partout. **Renforcé par la revue : tout fait affiché est adossé à une colonne ou une dérivation NOMMÉE dans le document domaine (ex. « Retirée le » ← `retiredAt` ; « Reconduit tacitement » ← calcul arithmétique, étiqueté calculé).**
5. **Terminologie adaptative** : `tradeToWorksiteTerminology` (« site » pour la maintenance) ; i18n ×3 tons, namespaces `equipements.*`, `contrat.*`, `intervention.*`, `visites.*`.
6. **Parité humain ↔ Bob** : chaque CTA = un use case exposé à Bob par le même endpoint (§8), plus la conception vocale propre (extraction composite, confirmations groupées).
7. **A11y non négociable** : Dynamic Type ~200 %, cibles ≥ 44 pt/48 dp, contraste 4,5:1, jamais couleur seule, ordre VoiceOver titre → statut → contenu → action, alternative tap à tout geste.

---

## 1. Kit minimal « matière Bob » — `packages/ui`, 100 % additif

Inchangé de la conception validée, rappelé pour complétude :

- **1.1 Tokens `surfaceTint`** (additif `@bob/tokens`) : palettes light + dark livrées dès P1, résolution `light` par défaut tant qu'UX-ADR-004 n'active pas le dark. Valeurs light dérivées de l'existant (`neutral #FFFFFF/#EAEEF3`, `marine #F4F7FB/#E2E9F2`, `ai #F6F4FD/#E7E2F8`, success/warning/danger sur les `semantic.*Bg`) ; dark sur la rampe marine d1/d2/d3. Contrastes AA certifiés dans `index.test.ts`. Champ additif `appearance: 'light' | 'dark'` dans `ThemeContextValue`, défaut `'light'`.
- **1.2 `BobSurface`** : `tone ('neutral'|'marine'|'ai'|'success'|'warning'|'danger')`, `emphasis ('flat'|'raised'|'floating')`, `radius`, `padding` — opaque par construction (Reduce Transparency trivialement satisfait), bord renforcé en Increase Contrast, `Card` non touchée.
- **1.3 `ProgressiveBlurBob`** : couches BlurView empilées masquées par dégradés (LinearGradient), voile teinté Bob ; **port injecté `renderBlurLayer`** (doctrine PrefsStorage — `@bob/ui` sans dépendance) ; repli opaque unique (port absent, Reduce Transparency, Android dégradé) ; usage borné plans 2-3 (barre d'action fiche, chrome visualiseur photo, voiles sticky Visites) ; jamais animé, jamais de texte dans le flou.
- **1.4 Tokens `motionSemantic`** : `feedbackIn 80 / feedbackOut 160 / exitFast 140 / enterFast 180 / enter 240 / replace 280` + springs ; transform/opacity uniquement, interruptible, table reduce-motion = équivalence d'information ; états async `idle → pending → success | recoverable | terminal`. Haptique : `selection` coche réelle, `notificationSuccess` sur ACK seulement, `notificationWarning` sur conflit.
- **1.5 Extensions d'existants** : `StatusBadgeVariant` + `'neutral'` (Résilié, Annulée, Retirée, Échu) ; `PriorityStatus` + `'visite'` (accent `ink600`, sans checkbox). Chacune : logic + test + snapshot de non-régression des variantes existantes.

---

## 2. Écran — Parc d'équipements d'un site (PR-11 · C1 · exigence 2)

Routes : liste `app/equipements/[chantierId].tsx` · fiche `app/equipement/[id].tsx`. Entrées : fiche site, voix, historique client.

### 2.1 Liste du parc

```
┌──────────────────────────────────────────────────────┐
│ ‹ RATP CAP Bastille      Équipements (12)      [ + ] │  InnerScreenHeader
├──────────────────────────────────────────────────────┤
│ [ 🔍 Rechercher un équipement…                     ] │  recherche locale
│ ( Actifs 11 | Retirés 1 )                            │  SegmentedControl
│ ┌─ BobSurface neutral ─────────────────────────────┐ │
│ │ Fontaine accueil R+2                          ›  │ │  EquipmentRow — label héros
│ │ Fontaine réseau · Culligan · SN 88-4121          │ │  kind LIBRE (suggestion, jamais enum)
│ │ [Garantie jusqu'au 12/03/2027]  [R+2, accueil]   │ │
│ ├──────────────────────────────────────────────────┤ │
│ │ Fontaine quai A                               ›  │ │
│ │ [Retirée le 02/05/2026]  (badge 'neutral')       │ │  ← date = retiredAt RÉEL (colonne
│ └──────────────────────────────────────────────────┘ │    additive, revue P11 — jamais updatedAt)
│ [ + Ajouter un équipement ]                          │
└──────────────────────────────────────────────────────┘
```

- Hiérarchie contexte → outil → résultats ; une seule action primaire.
- Garantie : chip `success` > 90 j, `warning` ≤ 90 j, `neutral` « Garantie échue le … » — toujours texte + date ; absent si non renseignée.
- Création : `Sheet` 4 champs (label requis, kind libre + suggestions des kinds du tenant, marque/SN/emplacement, dates avec validation inline) ; insertion + highlight `enter 240` APRÈS ACK.
- **Site clos [revue A12]** : si le chantier est `closed`, le `+` est remplacé par un état expliqué « Site clôturé — rouvrez-le pour modifier le parc » + CTA « Rouvrir le site » (transition domaine, ConfirmSheet) ; jamais un bouton grisé mystère.
- **États** : skeleton ×3 ; vide parc → EmptyState + CTA ; vide filtre distinct ; erreur → ErrorRetry sans effacer la liste chargée ; hors-ligne → cache PR-17 + bandeau ; pending → sheet verrouillée, jamais de ligne fantôme.
- **A11y** : row = un élément accessible, libellé complet ; ≥ 44 pt ; chips wrap à 200 %.
- **Micro-interaction signée** : « Retirer » (menu ⋮, ConfirmSheet) — **si l'équipement est couvert par un contrat actif, la ConfirmSheet porte l'avertissement honnête du domaine [amélioration 4] : « Couvert par le contrat {label} — la couverture continue jusqu'à modification du contrat » (info, jamais blocage)** ; après ACK, layout transition vers Retirés (exit 140) ; reduce-motion : immédiat + annonce.

### 2.2 Fiche équipement + historique

```
┌──────────────────────────────────────────────────────┐
│ ‹ Équipements     Fontaine accueil R+2         [ ⋮ ] │  ⋮ = Modifier · Retirer (· Réactiver si retirée)
├──────────────────────────────────────────────────────┤
│ ┌─ BobSurface marine · raised ─────────────────────┐ │
│ │ ÉQUIPEMENT · RATP CAP BASTILLE        (eyebrow)  │ │
│ │ Fontaine accueil R+2                 (screenH1)  │ │
│ │ [Actif]  Fontaine réseau · Culligan · SN 88-4121 │ │
│ │ Posée le 12/03/2024 · Garantie → 12/03/2027 ⓘ    │ │
│ └──────────────────────────────────────────────────┘ │
│ [ Nouvelle intervention ]      [ Ajouter une photo ] │
│ DOCUMENTS LIÉS                                       │  StoredDocument linkedEntity
│ HISTORIQUE                                           │  Timeline DÉRIVÉE (notes+photos+interventions
│  ● 26 juil. Passage signé — fiche du passage      ›  │  +documents par equipmentId)
│  ● 12 mai   Note « détartrage complet » — Papa       │
└──────────────────────────────────────────────────────┘
```

- Historique = la valeur (« montre-moi l'historique de la fontaine Y ») ; pagination « Voir plus ».
- Équipement retiré : bandeau `neutral` « Retirée le {retiredAt} » + action « Réactiver » (erreur honnête corrigée) ; l'historique reste intégral.
- États : introuvable → écran de récupération ; erreur de section locale, l'historique chargé reste. A11y : header focus, timeline lisible sans couleur, dates complètes.

---

## 3. Écran — Contrat de maintenance (PR-12/13 · C2 · exigence 3)

Routes : `app/contrat/new.tsx` · `app/contrat/[id].tsx`. Entrées : fiche client, fiche site, Aujourd'hui, voix.
**Périmètre V1 : clients B2B/B2G uniquement (vérifié au code : garde B2C de la facturation directe, revalidée à l'émission — document domaine §2.1). Le picker client du wizard FILTRE sur b2b/b2g ; un client b2c tenté par la voix reçoit le refus actionnable + LegalHint Chatel (« Bob ajoutera les contrats particuliers proprement — loi Chatel L215-1 — en attendant : devis signé annuel »).**

### 3.1 Machine à états ↔ UI (dérivée, jamais réinterprétée)

| État domaine + faits dérivés | Badge | CTA primaire | Secondaires (⋮) |
|---|---|---|---|
| `draft` | `warning` « Brouillon » | **Activer le contrat** | Modifier · Supprimer le brouillon |
| `active`, période courante NON couverte, fenêtre −30 j ouverte | `success` « Actif » | **Préparer la facture annuelle** | Modifier lignes · Résilier… |
| `active`, période couverte (facture non annulée OU importCoveredUntil) | `success` « Actif » | aucun (lecture) | Modifier lignes · Résilier… |
| `active`, NON tacite, échéance passée (**fait dérivé `expired` — revue P14**) | `warning` « Échu le {date} » | **Préparer le renouvellement** (ouvre modification de `notes`/lignes + LegalHint) | Résilier… |
| `terminated` | `neutral` « Résilié le {date} » | aucun | aucune (lecture seule, motif visible) |

Transitions interdites = CTA ABSENTS, pas grisés. **« Reconduire » n'est pas un bouton et « Reconduit » n'est pas un événement : la reconduction tacite est un FAIT CALCULÉ (période arithmétique) que l'UI constate et étiquette honnêtement (§3.2 Historique).** La couverture de facturation est DÉRIVÉE des factures réelles non annulées : l'annulation d'une facture annuelle RALLUME le CTA toute seule — l'écran l'explique (« La facture F-2026-0791 a été annulée : la période est à re-facturer »).

### 3.2 Fiche contrat

```
┌──────────────────────────────────────────────────────┐
│ ‹ RATP CAP        Entretien fontaines 2026     [ ⋮ ] │
├──────────────────────────────────────────────────────┤
│ ┌─ BobSurface marine · raised ─────────────────────┐ │
│ │ CONTRAT DE MAINTENANCE               (eyebrow)   │ │
│ │ Entretien fontaines 2026            (screenH1)   │ │
│ │ [Actif] · Reconduction tacite                    │ │
│ │ Client  RATP CAP  ›   Site  Bastille  ›          │ │
│ │ 1 600,00 € HT / an  ·  2 passages / an           │ │  MoneyText tabular (= Σ lignes)
│ └──────────────────────────────────────────────────┘ │
│ ┌─ ÉCHÉANCES (BobSurface neutral) ─────────────────┐ │
│ │ ◔  Période en cours : 12 oct. 2025 → 11 oct. 2026│ │  Ring STATIQUE (position dans la période
│ │    Facturée ✓ — F-2026-0791          Voir ›      │ │  CALCULÉE) ; [amélioration 5] la période
│ │    — ou —  [ Préparer la facture annuelle ]      │ │  est affichée BORNES INCLUSES lisibles
│ │    — ou —  ⚠ F-2026-0791 annulée — à re-facturer │ │  (jamais « facturé jusqu'au {borne
│ │ Prochain anniversaire : 12 octobre 2026          │ │  exclusive} » qui ment d'un jour)
│ │ Préavis de résiliation : 30 jours  ⓘ             │ │  LegalHint : affiché, JAMAIS bloquant
│ └──────────────────────────────────────────────────┘ │
│ ÉQUIPEMENTS COUVERTS (3, dont 1 retiré)   Voir tout ›│  retrait AFFICHÉ (amélioration 4)
│ LIGNES                                               │  catégorie 'subscription'
│   Forfait entretien annuel   2 × 800,00 €            │
│   Total HT / an                       1 600,00 €     │
│ HISTORIQUE                                           │  [revue P10 — source RÉELLE spécifiée]
│  ● 12 oct. 2025  Reconduit tacitement (calculé)      │  ← dérivation arithmétique, étiquetée
│  ● 12 oct. 2024  Activé — par vous                   │  ← activatedAt (fait stocké)
│  (si résilié : ● Résilié le … — motif)               │  ← terminatedAt + note (faits stockés)
└──────────────────────────────────────────────────────┘
```

- **Historique honnête [P10]** : DEUX faits stockés (`activatedAt`, `terminatedAt` + motif) + les reconductions DÉRIVÉES arithmétiquement, toujours suffixées « (calculé) » — un contrat sans site a exactement le même historique (plus aucune dépendance à une ChantierNote). Rien n'est jamais inventé ni journalisé par un cron.
- **« Préparer la facture annuelle »** : pending → ACK `PrepareAnnualInvoiceDraft` → navigation vers le brouillon (qui PORTE période + site + contrat — colonnes additives). Copy : « Bob prépare un brouillon — rien n'est envoyé ». Si la TVA re-suggérée diverge du contrat (bascule de régime — amélioration 2), le brouillon affiche l'écart honnêtement (« TVA recalculée au régime actuel : total {X} au lieu de {Y} » + LegalHint franchise 293 B). *[amendé 28/07/2026 : « CIBS » retiré de cette liste — la recodification se fait à DROIT CONSTANT (ord. 2025-1247, reportée au 01/01/2027 par l'ord. n° 2026-671 du 27/07/2026), elle ne peut donc jamais faire diverger un taux de TVA ; seul un changement de régime réel le peut.]*
- **Double-émission impossible** : si deux appareils préparent deux brouillons, l'ÉMISSION du second est refusée par la garde transactionnelle (domaine §2.6) — l'écran facture affiche le refus actionnable tel quel : « Période déjà facturée par F-2026-0791 — annule-la (avoir) ou ajuste la période ».
- **Résilier…** (Sheet) : date (défaut = prochain anniversaire CALCULÉ) + motif obligatoire, LegalHint préavis (« information pour vous défendre — Bob n'empêche jamais d'acter une résiliation subie ») ; ACK → badge morph `success → neutral` (`replace 280` ; reduce-motion immédiat) ; la fiche affiche « Résilié — couvert jusqu'au {date d'effet} » et les visites dues restantes.
- **Renouvellement J-60/J-30** (PR-13) : interne uniquement — carte Aujourd'hui + bandeau discret « Se reconduit dans 34 jours » (tacite) / « Arrive à échéance dans 34 jours » (non tacite). Aucun envoi client.
- **États** : skeleton héros + rows ; erreur ErrorRetry ; pending → CTA loading, feuille verrouillée ; hors-ligne → lecture cache, écritures désactivées avec explication (le contrat n'est PAS dans le périmètre offline).
- **A11y** : « 1 600 euros hors taxes par an » ; ring `accessibilityValue` textuelle ; « Facturée » = coche + numéro, pas seulement vert.

### 3.3 Création (wizard court — `Stepper`, grammaire S12)

**1. Client + site** (picker client FILTRÉ b2b/b2g avec note « Contrats particuliers : bientôt — loi Chatel » ; site optionnel, sites `open` seulement) → **2. Lignes** (catalogue `'subscription'`, ajout à la voix) → **3. Conditions** : `anniversaryDate` requise (**peut être passée — contrats migrés**), `visitsPerYear` défaut 2, `noticeDays` défaut 30 + LegalHint, tacite ON ; **[revue P13] bloc « Contrat migré ? » : « Déjà facturé jusqu'au … » (`importCoveredUntil`) avec pédagogie « Bob ne réclamera pas ce qui est déjà réglé hors Bob ; les visites comptent à partir d'aujourd'hui »** → **4. Revue** (total = Σ lignes, période courante CALCULÉE affichée, échéances dérivées). CTA « **Créer le brouillon** » ; l'activation est un geste distinct (jamais synonymes). Erreur → focus premier champ fautif + résumé en tête.

---

## 4. Écran — Fiche d'intervention, flux terrain OFFLINE (PR-15/16/17 · C3 · exigence 5)

Route : `app/intervention/[id].tsx`. Tout le flux terrain fonctionne hors-ligne via l'outbox local ; seuls l'aperçu PDF serveur, l'envoi et la facturation exigent le réseau et le disent.

### 4.1 Machine à états ↔ UI

| État | Badge | CTA primaire (barre collante) | Notes |
|---|---|---|---|
| `scheduled` avec `plannedAt` | `b2b` « Planifiée mar. 4 août, 9 h » | **Démarrer le passage** | ⋮ Replanifier… · Annuler |
| `scheduled` SANS `plannedAt` (**[amélioration 12]** — nullable couvert) | `warning` « À planifier » | **Démarrer le passage** | ⋮ Planifier… (pose `plannedAt`) · Annuler |
| `in_progress` | `warning` « En cours — démarré à 9 h 04 » | **Terminer le passage** | checklist/photos/résumé éditables |
| `completed` | `success` « Terminée à 10 h 12 » | **Faire signer** | secondaire « Client absent ? Envoyer sans signature » (mention honnête PDF) |
| `signed` | `success` + cadenas « Signée — verrouillée » | **Aperçu et envoi** | « Facturer ce passage » (si `contractId` null) ; lecture seule |
| `cancelled` | `neutral` « Annulée » | aucun | lecture seule |

Le sous-titre « Visite contractuelle » est dérivé de **`contractId` (seul discriminant — direction 6)** ; `kind` s'affiche comme libellé descriptif à côté. « Facturer ce passage » n'apparaît JAMAIS sur une visite contractuelle (couverte par la facture annuelle — double facturation impossible par construction).

### 4.2 Composition — identique à la conception validée (bandeau offline + SyncStateChip, héros marine, checklist libre compteur réel, photos avant/après par TEXTE, résumé + dictée, barre d'action ProgressiveBlurBob), avec les corrections :
- **Photos = entrées de LA MÊME file FIFO que les mutations (direction 3)** : la tuile porte le même `SyncStateChip` que les gestes ; l'ordre affiché dans la ligne outbox est l'ordre réel de rejeu (photos AVANT la signature capturée après elles).
- Conflit de révision au rejeu : bandeau danger persistant « Cette fiche a changé ailleurs — vos gestes locaux sont conservés, choisissez » — **le conflit frappe le bon maillon de la file (chaînage `expectedRevision`, amélioration 7) ; les gestes suivants attendent derrière, visibles, jamais perdus ni rejoués en cascade**.

### 4.3 Grammaire offline commune (§2, §4, §5)

| État | `SyncStateChip` | Où |
|---|---|---|
| Capturé local, en file | ⏳ « À synchroniser » | header fiche, tuile photo, ligne outbox |
| Rejeu en cours | ↻ « Synchronisation… » | idem |
| ACK serveur | ✓ « Synchronisé » (s'éteint après 2 s) | idem |
| Échec transitoire | ⚠ « Échec — réessaiera » + retry manuel | idem |
| **Échec définitif d'une photo (règle d'échec partiel — direction 3)** | ⛔ « Bloque la synchronisation de cette fiche » | tuile + bandeau : « Réessayer / Retirer cette photo de la fiche (une note le tracera) » — la signature ne part qu'après CE choix |
| Conflit | ⛔ « Conflit à résoudre » | bandeau fiche |

Bandeau scopé au flux fiche (+ Visites lecture). Rejeu FIFO : chips passent à « Synchronisé » un par un sur événements réels ; compteur décroît ; à zéro, toast unique « Tout est synchronisé » (haptique `notificationSuccess` — un ACK, pas un optimisme).

### 4.4 Signature plein écran — réutilisation du pad

`SignInterventionSheet` réutilise le patron `SignOnsiteSheet` à l'identique (Modal fullScreen non dismissible, Bob/micro suspendus, sortie appui long 1,5 s + alternative AT armer/confirmer, erreur conserve le tracé, `SignaturePad` `@bob/ui`). Recommandation : extraire `OnsiteModeShell` partagé avec non-régression complète du flux devis, sinon duplication contrôlée des `.logic.ts` — décision writer avant PR-15/17.

**Hors-ligne (cas nominal du sous-sol)** : validation = sha256 calculé sur l'appareil **pour l'affichage local uniquement** ; l'heure du geste part en **`capturedAtDevice`** ; au rejeu le tracé BRUT est transmis et le serveur recalcule le hash et pose **`capturedAt` = horodatage serveur de réception** — **convention UNIQUE alignée sur le domaine (§3.4), problème P12 clos : ce document n'écrit plus jamais « capturedAt = heure du geste »**. Retour fiche scellée localement : « Signée à 10 h 31 (heure de l'appareil) — enregistrée, à synchroniser » ; le succès de synchronisation n'est joué qu'à l'ACK. Jamais « Envoyée »/« Archivée » avant autorité.
**[Amélioration 15 — a11y assumée]** : limitation héritée du pad devis documentée — aucune alternative non gestuelle au tracé pour un signataire à mobilité réduite ; position V1 : valeur probante « signature simple » eIDAS, le repli honnête est `completed` non signée + envoi de la fiche (mention « non signée ») — jamais un tracé fabriqué au nom du client. Réévaluation P2 (nom saisi + mention explicite) tracée au §10.

### 4.5 Aperçu PDF → envoi (PR-16) — identique à la conception validée (titre paramétrable société — UNIQUE par société, limite assumée [amélioration 10] : titre par kind = post-V1 ; aperçu serveur, hors-ligne expliqué « prêt à la reconnexion » ; Sheet d'envoi patron sendQuote : récap non éditable, destinataire = contacts PR-09 fallback email, aucun destinataire → refus actionnable « Ajouter un contact » ; pending honnête ; annuler = rien n'est parti ; `NotificationJob` `intervention-report`, jamais un effet de bord). « Facturer ce passage » → `facture/new` pré-remplie ; la facture repasse par TOUS les invariants d'émission (garde B2C dépannage comprise — LegalHint « passe par un devis » si refus).

---

## 5. Écran — Visites dues (PR-18/19 · exigence 6)

Route : `app/visites.tsx`. Composition identique à la conception validée (segments Aujourd'hui/À venir/Passées, chips `technicianLabel` réels, groupes jour sticky avec voile, VisitRow heure héros) avec les précisions :
- Le badge « Visite contractuelle » de chaque row dérive de `contractId` (jamais du texte `kind`).
- **Replanifier** : menu ⋮ (alternative visible) → Sheet date/heure → après ACK, layout transition vers le nouveau groupe + `ChantierNote` automatique ; reduce-motion : immédiat + annonce.
- Rappel push J-1 : `NotificationJob` `visit-reminder` dédupliqué ; méta honnête « Rappel prévu la veille à 18 h ».
- **Partage agenda ICS** : Sheet « Agendas abonnés » (pédagogie lecture seule au point de décision), liens par filtre technicien — **le filtre est NORMALISÉ (trim/casse) à la création comme au service [amélioration 6] : « papa » et « Papa » sont le même agenda** ; révocation → ConfirmSheet « les agendas abonnés cesseront de se mettre à jour (404) » ; jeton créé sur geste uniquement. Côté serveur : VTIMEZONE Europe/Paris, `text/calendar; charset=utf-8`, `no-store` (domaine §5.3).
- **États** : vide + CTA ; Passées vide distinct ; hors-ligne → visites du jour du cache + bandeau, replanification désactivée expliquée ; erreur sans effacer les groupes. **A11y** : row libellé complet ; groupes = headers ; fuseau Paris partout.

---

## 6. Intégration aux écrans existants — extension douce

### 6.1 Aujourd'hui — cartes dérivées en plus (chrome intact)

```
┌ PriorityCard status='visite' (rappel, SANS checkbox)
│ ▍ 2 visites aujourd'hui                                [ Voir ]
┌ PriorityCard actionnable
│ ▍ Facture annuelle à émettre — Entretien fontaines 2026
│   Période 2026→2027 non facturée         [ Préparer le brouillon ]
┌ PriorityCard actionnable (réallumage honnête — dérivation)
│ ▍ Période à re-facturer — la facture F-2026-0791 a été annulée
┌ PriorityCard rappel (warning)
│ ▍ Se reconduit dans 30 jours — Contrat Docks Rouen    [ Voir ]
│   (non tacite : « Arrive à échéance dans 30 jours »)
```

Extinction/réallumage par l'état réel UNIQUEMENT : visites → passage `completed`/`signed` ou jour écoulé ; facture annuelle → une facture NON annulée couvre la période (ou `importCoveredUntil`) — **l'annulation rallume la carte sans aucun code d'écran (dérivation pure)** ; renouvellement → résilié ou palier passé (rattrapage cron : seul le palier le plus récent pertinent — amélioration 14). Une carte groupée pour N visites — la Home reste calme. Snapshot de non-régression des priorités existantes obligatoire.

### 6.2 Fiche site — carte contexte maintenance (contrat actif · prochain passage) uniquement si matière réelle ; section ÉQUIPEMENTS (3 premières rows + Voir tout) ; le journal existant reste la chronologie. Site `closed` : les CTA de création (équipement/intervention) deviennent « Rouvrir le site pour… » (refus actionnable, §2.1).

### 6.3 Fiche client — section « Contrats » (label · badge état dérivé · montant/an · prochaine échéance calculée) ; contacts multiples PR-09 dans coordonnées ; le choix du destinataire vit dans les feuilles d'envoi. Client b2c : PAS de CTA « Nouveau contrat » (périmètre V1), remplacé par la note pédagogique Chatel si l'utilisateur y arrive par la voix.

### 6.4 Pilotage — AUCUN ajout P1 (MRR/ARR = P2, sinon donnée fabriquée). Point d'extension P2 documenté.

### 6.5 Ventes / facture — le brouillon annuel est un brouillon standard qui PORTE période + site + contrat (colonnes additives) ; l'écran facture affiche « Contrat : {label} · Période : 12/10/2025 → 11/10/2026 » (bloc info, éditable en brouillon, figé à l'émission par le trigger étendu) ; le refus d'émission « période déjà facturée par {n°} » et « facture de contrat sans période » s'affichent tels quels (messages du domaine, actionnables).

---

## 7. Spécification des composants P1

Convention : `.tsx` + `.logic.ts` pur (Vitest sans react-native) + `.test.ts` ; zéro hex ; i18n injectée.

| Composant | Paquet | Rôle | Props clés | États | A11y | Motion |
|---|---|---|---|---|---|---|
| `BobSurface` | `@bob/ui` (nouveau) | surface teintée 2 apparences | `tone, emphasis, radius, padding` | — | bord renforcé Increase Contrast | statique |
| `ProgressiveBlurBob` | `@bob/ui` (nouveau) | flou plans action/nav | `tint, direction, height, layers, renderBlurLayer` (port) | nominal / repli opaque | décoratif, info jamais dans le flou | jamais animé |
| `SyncStateChip` | `@bob/ui` (nouveau) | état de file offline | `state: pending\|syncing\|synced\|failed\|blocked\|conflict` | 6 états, icône + texte | label complet | `enterFast`/`exitFast` |
| `Timeline`/`TimelineRow` | `@bob/ui` (nouveau) | historiques équipement/contrat/fiche | `entries[{date, icon, label, computed?, onPress?}]` — `computed` suffixe « (calculé) » | vide (appelant) | date complète, nature dans le texte | `enter` après ACK |
| `StatusBadge` +`'neutral'` | extension | Résilié, Annulée, Retirée, Échu | variant additif | — | inchangé | — |
| `PriorityCard` +`'visite'` | extension | rappel visites Home | status additif, sans checkbox | — | inchangé | — |
| `ChecklistItemRow` | mobile | item checklist libre | `item, onToggle, onEditNote, locked` | done/undone/locked | checkbox role, 44 pt | coche + haptique `selection` |
| `PhotoPhaseTile` | mobile | photo avant/après + synchro | `uri, phase, takenAt, syncState, onPress, onRetry, onRemove` | 6 états × 2 phases (dont blocked : Réessayer/Retirer) | « Photo avant, 9 h 12, en attente » | fondu S04 |
| `OfflineBanner` | mobile | bandeau scopé flux fiche | `queuedCount` | offline/rejeu/caché | liveRegion polite, dédupliqué | `exitFast` |
| `OnsiteModeShell` | mobile (factorisation) | coque plein écran (Bob off, sortie propriétaire) | `visible, title, instruction, saving, onExit, children` | idle/armed/holding/saving | patron SignOnsiteSheet intégral | anneau existant |
| `SignInterventionSheet` | mobile | signature du passage | `contactName, interventionDate, saving, error, onSubmit(signerName, dataUrl)` | erreur conserve tracé ; offline = fait local | ordre sortie→titre→nom→pad→valider ; limitation documentée §4.4 | idem devis |
| `InterventionSendSheet` | mobile | envoi confirmé | `recipients[], defaultRecipient, onConfirm` | choix/pending/reçu/échec | récap lu en premier ; double soumission impossible | morph après ACK |
| `IcsShareSheet` | mobile | liens agenda | `feeds[], onCreate(filter), onCopy, onRevoke` | vide/actifs/pending/révoqué | explication lue avant actions | — |
| `VisitRow`/`EquipmentRow`/`ContractRow` | mobile | rows denses | données dérivées | — | un élément accessible/row | press 0,99 |

Tests : parité contraste `surfaceTint`, snapshots variantes existantes inchangées, `tsc -p tsconfig.json` complet.

---

## 8. Parité Bob vocal — norme fondateur 27/07 (« papa vocal », parité INTELLIGENTE)

### 8.1 Table de parité (chaque CTA = le MÊME endpoint)

| Geste UI | Use case / endpoint | Exemple vocal |
|---|---|---|
| + équipement, retirer, fiche parc | `Create/Update/RetireEquipment` | « Ajoute une fontaine à Bastille » |
| Historique équipement | dérivation `equipmentId` | « L'historique de la fontaine de l'accueil » |
| Créer/activer/résilier contrat | `Create/Activate/TerminateContract` | « Crée le contrat RATP Bastille » (b2c → refus expliqué + chemin devis annuel) |
| Préparer facture annuelle | `PrepareAnnualInvoiceDraft` | « Prépare la facture annuelle du contrat Bastille » (si couverte : « déjà facturée par F-… ») |
| Renouvellements / échéances | `deriveRenewalAlerts` | « Quels contrats à renouveler ? » |
| Démarrer / terminer / signer | `Start/Complete/SignIntervention` | « Passage terminé, fais signer » (le tracé reste un geste humain) |
| Note / photo de passage | use cases existants + `interventionId` | « Ajoute une note : détartrage fait » |
| **Replanifier** (**[P16]** — présent) | `UpdateInterventionPlanning` | « Décale la visite de jeudi à lundi 9 h » |
| **Visites jour/semaine** (**[P16]**) | `visites_du_jour` / `visites_semaine` | « C'est quoi mes visites demain ? » |
| Envoyer la fiche | outbox `intervention-report` | « Envoie la fiche » → MÊME confirmation que le tap |
| Facturer ce passage | ComposeStandaloneInvoice pré-rempli | « Facture l'intervention de ce matin » |
| Préparer/confirmer email boîte | intents Bloc D | « Prépare le mail dans ma boîte… c'est bon envoie » |
| Lien agenda ICS | **UI-only, tranché [P16]** | l'URL est un secret : ni dictable ni transmissible à la voix sans fuite — Bob GUIDE vers Réglages → Agendas |

### 8.2 Conception vocale propre (s'applique à tous les blocs)
1. **Consigne composite désordonnée acceptée** : l'utilisateur parle comme sur un chantier, pas comme un formulaire. Bob extrait TOUS les faits d'une phrase en une passe (site, équipement, gestes, notes, intentions conditionnelles).
2. **Questions ciblées sur les seuls manques REQUIS** — jamais de re-demande d'un fait déjà énoncé.
3. **Confirmations REGROUPÉES aux seules mutations** : une confirmation récapitulative par grappe de mutations de même portée ; tout SORTANT (envoi fiche/email) et toute ÉMISSION gardent leur confirmation PROPRE, jamais fusionnée ni déduite d'un « ok » ambigu. Les lectures/dérivations : zéro confirmation.
4. Toute action sensible vocale reçoit la même feuille de confirmation que le tactile (S05) ; hors-ligne, Bob distant est indisponible et le dit — le flux fiche reste 100 % tactile (le pad suspend déjà Bob).

### 8.3 Scénario d'enchaînement de bout en bout = CRITÈRE DE SORTIE
« Bob, je suis à Bastille, j'ai fait la fontaine de l'accueil, détartrage complet, deux photos avant-après, le responsable a signé, envoie-lui la fiche, et si c'est le moment prépare la facture annuelle du contrat. » → résolution site/intervention/équipement, faits extraits (checklist, photos constatées en file, complétion, signature constatée), UNE confirmation de complétion groupée, LA confirmation d'envoi, puis proposition de facture annuelle SI `deriveAnnualBillingDue` (sinon réponse honnête avec le numéro couvrant). Test d'intégration nommé (patron `bob-*-voice.test.ts`), exigé au GO de PR-16 et PR-13 — le même scénario est rejoué en revue d'écran (S05) pour vérifier que chaque feuille de confirmation vocale est identique à la feuille tactile.

---

## 9. Matrice a11y commune (synthèse opposable)
- Dynamic Type ~200 % : aucune hauteur fixe textuelle ; chips wrap ; CTA 2 lignes ; barre collante croît.
- Cibles ≥ 44 pt partout ; ≥ 8 dp entre petites actions ; alternative visible à tout geste.
- Jamais couleur seule : badges libellés, phase photo en texte, sync icône+texte, garantie avec date, « (calculé) » en texte.
- VoiceOver/TalkBack : ordre titre → statut → contenu → action ; annonces majeures dédupliquées ; conflit = alerte assertive unique.
- Reduce Motion/Transparency : table §1.4 ; blur → surface opaque ; layout transitions → immédiat + annonce.
- Signature : limitation non gestuelle documentée (§4.4) — position V1 assumée, réévaluation P2 tracée.
- Preuves (06-spec §2.2) : captures 3 tailles × 2 OS, 200 %, reduce-motion, lecteur d'écran, hors-ligne ; vidéo 60 fps ; preuve « aucun succès avant autorité » ; pour §4 : parcours complet en mode avion puis rejeu, Y COMPRIS le cas photo bloquante → choix → signature synchronisée.

---

## 10. Risques, dépendances, questions ouvertes
1. **Dépendance blur** : `expo-blur` via port `renderBlurLayer` ; repli opaque = défaut Android tant que non profilé.
2. **Dark** : palettes livrées, activation = UX-ADR-004 uniquement.
3. **`OnsiteModeShell`** : factorisation avec non-régression complète du flux devis, ou duplication contrôlée — décision writer avant PR-15/17.
4. **PR-17 la plus risquée** : la grammaire synchro/conflit/échec-partiel est FIGÉE ici avant le spike réseau réel.
5. **Nommage des routes** : choix writer ; surfaces/états/intégrations = l'engagement.
6. **Aperçu PDF hors-ligne** : rendu serveur V1, état « prêt à la reconnexion » copywrité.
7. **P2 tracés** : contrats B2C + Chatel L215-1 ; titre de fiche par kind ; alternative de signature non gestuelle ; MRR/ARR Pilotage.

---

### Sources lues (chemins relatifs au dépôt)
- `docs/superpowers/plans/beta-fly-services-roadmap.md` · `docs/strategy/beta-fly-services-gap-analysis.md` · `AGENTS.md`
- `apps/api/prisma/schema.prisma` (NotificationJob:1325, servicePeriod:767-769, chantier_notes/photos) · migrations `20260714060000` + `20260719010000` (trigger `invoices_legal_traceability` — liste des champs figés vérifiée)
- `packages/core/src/application/billing/{compose-standalone-invoice.ts,issue-invoice.ts,delete-draft-invoice.ts}` (garde B2C lignes 117-125 / 246-258 ; ordre des verrous ; A7 servicePeriod à l'émission) · `domain/billing/shared/state-machines.ts` (INVOICE_TRANSITIONS issued→cancelled) · `domain/chantier/chantier.ts` (open/closed, close():63) · `application/today/derive-today-priorities.ts`
- `packages/tokens/src/index.ts` · `packages/ui/src/{theme.tsx,index.ts}` + composants · `apps/mobile/src/components/SignOnsiteSheet.tsx` · `apps/mobile/src/data/client.tsx` · `apps/api/src/jobs/relance.service.ts`
- Directives visuelles : `docs/mobile-experience/{01,03,06,08}-*.md`

---

*Voir l'annexe errata du document domaine — normative pour les écrans également.*
