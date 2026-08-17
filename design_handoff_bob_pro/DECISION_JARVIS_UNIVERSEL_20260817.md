# Décisions fondatrices — Jarvis universel (§20 de la spec d'orchestration)

- **Date** : 2026-08-17
- **Statut** : NORMATIF — débloque les décisions `[BLOQUÉ FONDATEUR]` du §20 de la spec candidate `BobPro-JARVIS-UNIVERSAL-ORCHESTRATION-SPEC` ainsi que l'articulation V1.
- **Provenance** : délégation explicite du fondateur à Claude (chat direct, 17/08/2026) — verbatim : « pour les dix décisions, tu répondras toi-même, de la meilleure des manières, avec expertise, tu n'as pas besoin de te laisser bloquer par moi, je n'ai pas le temps de prendre ça en charge ; avec en vue l'objectif Jarvis universel pour Bob Pro ». Le fondateur a cadré dans le même message l'articulation V1 : la portée universelle du §2 (parité des actions couplée à GPT Realtime, y compris les actions sensibles sous biométrie) est **l'objectif produit**.
- **Amendabilité** : chaque décision reste amendable par le fondateur seul, à tout moment, par décision tracée. Toute action dont la décision serait amendée repasse `closed` le temps de la mise en conformité (fail-closed du §20).
- **Usage** : les identifiants `FD-2026-0817-NN` ci-dessous sont les `founderDecisionId` machine-readable attendus par la spec (catalogue `PublicActionSurfaceManifest`, politiques serveur, reçus).

## Grille de risque de référence (socle de toutes les décisions)

| Niveau | Définition | Confirmation exigée |
|---|---|---|
| **R0** | Lecture, navigation, rapport | Aucune |
| **R1** | Écriture réversible (note, brouillon, classement) | Confirmation vocale one-shot liée au digest de la proposition |
| **R2** | Acte engageant (émission facture, envoi devis/facture, paiement, avoir simple, relance unitaire, envoi en signature) | **Confirmation visuelle à l'écran** (tap sur l'écran réel) — jamais voix seule |
| **R3** | Acte critique (destruction définitive, avoir > seuil, coordonnées bancaires, masse, fusion, profil légal société, export FEC, mise en demeure) | **Step-up biométrie/PIN** (BiometricPrompt / LocalAuthentication) en plus de l'écran |
| **R4** | Hors Jarvis (suppression de compte, abonnement, identité du compte) | Parcours écran dédié + auth renforcée ; la voix peut au plus y **naviguer** |

Conséquence normative pour la spec : la table classe→mode vocal doit être **écrite dans la spec** (jamais déléguée au catalogue) — `E3`, `financial`, `external`, `mass_action` et l'octroi de mandat ⇒ reçu `screen_ack` minimum ; `voice_presentation_ack` au plus pour du M2 non financier, non externe.

## Les décisions

### FD-2026-0817-01 — Canaux de message
E-mail = seul canal d'**envoi provider** en V1 (Brevo, déjà intégré ; preuve d'envoi requise). SMS/WhatsApp/appel = **handoff natif** uniquement (`tel:`/`sms:`/`wa.me` pré-rempli — zéro envoi serveur, zéro sender-ID, zéro obligation opt-in gérée par nous). Templates tenant-scoped, variables résolues depuis les autorités uniquement. Pièces jointes : artefacts générés par Bob + documents du coffre **rattachés à l'entité concernée**. CC libre ; BCC restreint à l'adresse du tenant (auto-archive). **Prospection : interdite** (opt-in LCEN/RGPD hors périmètre copilote admin). Réouverture : décision fondateur explicite.

### FD-2026-0817-02 — Step-up, seuils, masse
La grille R0–R4 ci-dessus. **Seuil de montant V1** : tout acte engageant ≥ 5 000 € TTC monte automatiquement R2→R3 (fixe en V1 ; paramétrable par tenant post-V1, jamais désactivable). **Masse** : ≥ 2 destinataires = action de masse, R3 + préview nominatif complet + plafond 20 destinataires par mandat. Délégations/double approbation : sans objet en V1 (mono-utilisateur) — voir FD-07.

### FD-2026-0817-03 — Preuve d'identité pour la signature
Niveau assumé : **signature électronique simple (SES)** eIDAS — lien nominatif au contact vérifié, horodatage, journal de preuve (IP, user-agent, hash de l'artefact, chaîne d'événements). Claim autorisé : « signature électronique avec piste d'audit » — rien de plus. Interdits : « identité vérifiée », « signature avancée/qualifiée ». Jarvis reste techniquement incapable de signer à la place du tiers. Post-V1 : OTP SMS optionnel.

### FD-2026-0817-04 — Facture après signature
Jarvis propose **le chemin légal optimal** avec pédagogie au point de décision (doctrine LegalHint) : B2C hors établissement → embargo L221-10 respecté puis acompte ; B2B/B2G → « situation n°1 — 30 % » (décision fondateur du 25/07). **Émission+envoi confirmables en une seule confirmation R2** à condition que l'écran nomme **les deux effets** ; techniquement deux work items séquencés à reçus distincts, l'envoi ne part que sur émission réussie. Encaissement plafonné `netToPay`.

### FD-2026-0817-05 — Politique de relance
V1 : relance **unitaire confirmée** (R2), e-mail seul, handoff SMS possible. Cadence **recommandée** (jamais auto) : J+3 amiable, J+15 ferme, J+30 mise en demeure (préparée par Bob, envoi R3). Fenêtre d'envoi : 09h–19h jours ouvrés, fuseau du tenant, jamais dimanche/férié. B2B : pénalités légales mentionnées dans la relance ferme (BCE + 10 pts + 40 € — art. L441-10 et D441-5 c. com.). B2C : aucune pénalité auto, ton amiable, échéancier proposable. **Litige = arrêt total des relances** (reprise R3). Paiement partiel : relance sur le solde restant. Campagne préautorisée : post-V1 (plafond 20 factures, ≤ 30 jours, révocable, journal nominatif, R3 à l'octroi).

### FD-2026-0817-06 — Fusion/suppression des doublons
V1 : fusion **reste `closed`** ; Jarvis détecte et signale (R0) mais ne fusionne pas. Post-V1 : fusion R3 + préview complet des réaffectations + tombstone de l'entité absorbée (jamais de delete physique d'une entité ayant porté une pièce). Suppression : uniquement entités sans pièce légale rattachée, R3 ; sinon archivage.

### FD-2026-0817-07 — Rôles et séparation des tâches
V1 : propriétaire **seul** ; le comptable reçoit des exports (R2), jamais un accès. Post-V1, ordre imposé : (1) rôle comptable lecture seule, (2) rôle employé terrain (zéro accès finance/légal), (3) délégations fines. Plafonds par rôle hérités de la grille (un employé ne dépasse jamais R1). Double approbation : quand le multi-utilisateurs existera, pour les actes R3 des non-propriétaires.

### FD-2026-0817-08 — Pré-comptabilité
**Bob prépare, l'humain valide** — Bob n'est pas un logiciel de tenue comptable et ne le revendique jamais. V1 : lectures/préviews + clôture mensuelle existante + exports (R2). Écritures : **propositions** dérivées des autorités (ventes ← factures émises, achats ← dépenses justifiées) ; jamais de correction d'écriture passée — toute correction = écriture inverse **proposée** avec pièce. TVA : chiffres exclusivement dérivés des autorités ; déclaration = brouillon chiffré, dépôt hors app. FEC : export structurellement conforme étiqueté « préparation pour votre comptable ».

### FD-2026-0817-09 — RGPD voix/tiers
L'artisan = responsable de traitement de ses données clients ; Bob Pro = sous-traitant ; OpenAI = sous-traitant ultérieur **nommé**. Bases : art. 6.1.b (utilisateur), 6.1.f (tiers mentionnés à la voix). Information : politique de confidentialité + écran de première activation vocale. **Gate technique d'activation large : endpoint OpenAI résidence UE + Zero Data Retention actifs.** Rétention : audio = zéro conservation ; transcriptions liées à un acte = durée de l'acte ; runs sans acte = purge 90 jours ; Voice Trace pseudonymisé. Effacement (art. 17) : purge du conversationnel à la demande, les reçus d'actes légaux survivent (17.3.b) — expliqué à l'utilisateur. **AIPD requise avant activation large.**

### FD-2026-0817-10 — Canary et claim public
Ordre de canary = ordre des lots U1→U6, chaque action sur compte fondateur + tenant démo sous permis éphémère. Communication par capacités **nommées** au fil des `released`. Le claim totalisant « toute l'app avec Jarvis » = événement distinct, déclenché par le fondateur seul, après `universal_released` (`closed=0`). Aucun matériel marketing ne l'anticipe.

### FD-2026-0817-11 — Articulation V1
La **parité universelle** (§2, `closed=0`) est l'objectif produit ; la **publication V1 n'attend pas U7**. V1 publie avec le programme V1 existant + le critère inter-domaines déjà consigné (mission client → chantier → devis → facture → préparation pré-comptable) — socle U0/U1 + chaîne U3/U4 sur les parcours du programme. U5–U7 se livrent et s'annoncent **action par action** après publication. « Préparation pré-comptable » = le périmètre FD-08 V1 (clôture existante + exports + préviews), rien de plus.

## Bloc machine-readable

```yaml
founderDecisions:
  - { id: FD-2026-0817-01, scope: message-channels,      v1: email-provider-only+native-handoff, prospection: forbidden }
  - { id: FD-2026-0817-02, scope: step-up,               grid: [R0, R1, R2, R3, R4], amountThresholdTTC: 5000, massMin: 2, massCapPerMandate: 20 }
  - { id: FD-2026-0817-03, scope: signature-identity,    level: SES, claim: audit-trail-only }
  - { id: FD-2026-0817-04, scope: invoice-after-sign,    combinedIssueAndSend: allowed-if-both-named, cap: netToPay }
  - { id: FD-2026-0817-05, scope: dunning,               v1: unit-confirmed-email, window: "09:00-19:00 business-days", dispute: full-stop }
  - { id: FD-2026-0817-06, scope: merge-duplicates,      v1: closed, detection: read-only }
  - { id: FD-2026-0817-07, scope: roles,                 v1: owner-only, accountant: exports-only }
  - { id: FD-2026-0817-08, scope: pre-accounting,        doctrine: bob-prepares-human-validates, corrections: reverse-entry-proposal-only }
  - { id: FD-2026-0817-09, scope: gdpr-voice,            euResidencyZdrGate: required, dpiaBeforeWideActivation: required, audioRetention: zero }
  - { id: FD-2026-0817-10, scope: canary-claim,          order: U1-to-U6, publicClaim: founder-only-after-universal-released }
  - { id: FD-2026-0817-11, scope: v1-articulation,       v1WaitsForU7: false, universalParity: product-objective }
```
