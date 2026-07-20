# Écrans & flux — Bob Pro

Réfère-toi à `Bob Pro.dc.html` (ouvre-le, clique) pour le rendu exact. Coque mobile : **402 × 874**, safe-top 54. Sur web, voir §Web dans le README.

Navigation : **barre du bas à 5 destinations** — Aujourd'hui · Clients · Argent · Documents · Assistant — + **FAB central** (ouvre la feuille de création). L'onglet Assistant est teinté IA (#4338CA).

---

## Authentification (4 étapes) — surcouche plein écran, fond marine `#0C2340`
- **0 — Identifiant + SSO** : logo (carré blanc + étoile-boussole), wordmark **Bob Pro**, titre (`Crée ton compte` / `Bon retour 👋`), champ email, CTA « Continuer », SSO Google/Apple, lien magique, bascule login/signup.
- **1 — Mot de passe** : champ password, « mot de passe oublié », Face ID.
- **2 — Lien magique / 2FA** : code à 6 cases.
- **3 — Biométrie / entrée** → `screen = today`.

## Onboarding (5 étapes, **adaptatif métier**) — fond marine
- **0 — Intro** : wordmark **Bob Pro** + « Ton bureau pro, dans ta poche. » + « Bob s'occupe de la paperasse — toi, tu bosses. »
- **1 — SIRET** : saisie → « Bob retrouve ton entreprise » (carte Mercier Plomberie auto-remplie).
- **2 — Métier** : grille de 9 métiers (icône+label). **Le choix change le vocabulaire** : aperçu des modules adaptés (ex. plombier → Chantiers/Acomptes/Photos/TVA travaux/Retenue de garantie ; consultant → Missions/TJM/CRA/Frais refacturés…).
- **3 — Types de clients** : toggles Particuliers / Entreprises / Public / International (pilote les règles e-invoice).
- **4 — Bilan** → bouton « Faire le diagnostic 2026 » ou « Entrer dans l'app ».

## Aujourd'hui (accueil — cockpit)
- **En-tête dégradé** (`gradient.header`) : avatar+date+entreprise, cloche ; **titre** = salutation de Bob (selon personnalité) ; carte « Dispo réel aujourd'hui » 4 950 € + pilule **« Te verser ~2 000 € »**.
- **À régler aujourd'hui** : 3 cartes priorité (barre d'accent latérale colorée + checkbox + badge statut + CTA). Ex. *Martin en retard 9 j → Relancer* ; *Facture finale chantier Durand → Créer la facture* ; *Réception e-facture à configurer → Diagnostic*. Compteur « N restants ».
- **En un coup d'œil** : grille 2×2 de stats (encaissé/dû/TVA/dispo) → vers Argent.
- **Vite fait** : 4 actions rapides. Pied : ligne de Bob (« C'est tout pour aujourd'hui. Va bosser 🔧 »).
- Densité réglable **Cockpit / Zen**.

## Feuille de création (bottom sheet) — déclenchée par le FAB
Hero **« Facture à la voix »** + grille : Nouveau devis · Nouvelle facture · Scanner un doc · Encaisser.

## Facture à la voix (3 étapes) — `flows/voiceInvoice`
- **0 — Écoute** : fond marine, gros bouton micro animé + transcription qui s'écrit en direct + barres d'onde.
- **1 — Relecture** : facture pré-remplie (client, lignes, TVA, mentions auto) — « Bob a tout rempli pour toi ».
- **2 — Encaissé / Envoyé** : écran vert succès (« Payé ! 💸 »).

## Devis → signature → facture (6 étapes) — `flows/devis` *(Brique 1)*
1. **Composer** : bandeau Bob (pré-rempli D-2026-014), carte client, lignes catégorisées (Fourniture/Main d'œuvre/Déplacement), totaux **TVA 10 %**, **toggle acompte 30 %**, puce « Mentions légales ajoutées ». CTA « Envoyer pour signature ».
2. **Envoyé** : avion, timeline Envoyé ✓ / Vu / Signé, note « Bob relance sous 3 j ». CTA « Ouvrir la signature client (démo) ».
3. **Signature (vue client, fond marine)** : récap + Total TTC, « Bon pour accord », **pad de signature** (tap pour dessiner). CTA « Signer le devis » (désactivé tant que non signé).
4. **Signé** : check vert, « Devis signé ! », Bob annonce la **Facture d'acompte/finale**.
5. **Facture** : générée depuis le devis (N° F-2026-118), ligne acompte ou solde, totaux, **note e-reporting** (B2C). CTA « Encaisser ».
6. **Encaissé** : écran vert succès.

## Argent (trésorerie)
- En-tête « Te verser ~2 000 € » (carte héros dégradée, glow vert).
- **« Argent disponible réel »** : grand-livre avec badge **« LE SOLDE MENT »** — Solde bancaire 6 820 € + factures attendues − charges − **TVA à reverser** = Disponible prudent 4 950 €.
- **Prévision de tréso** : segments **7/30/60/90 j** + sélecteur de **scénario optimiste/réaliste/prudent** (montant & ton changent ; 60 j prudent = risque).
- À surveiller (mauvais payeurs, score) · Mise de côté (réserve TVA, toggle).

## Clients
- En-tête « Ton carnet » + bouton + (nouveau client). Chips de filtre **Tous / Particuliers / Entreprises / Public**.
- **Liste** : ligne = avatar squircle (initiales), nom, sous-titre, montant coloré (statut).
- **Fiche client** : en-tête (avatar, nom, badge type, SIREN), **score de paiement /100** (barre), statut **e-invoice** (B2B PDP / B2G Chorus / B2C e-reporting), onglets **Activité / Projets / Documents / Infos**, CTA d'action contextuelle (« Relancer », « Créer la facture finale », « Voir / relancer le devis » → ouvre le flux devis).

## Documents (coffre-fort)
- En-tête « Ton coffre-fort » + « Je classe, tu retrouves. Même 3 ans après. »
- **Dossiers** (Chantiers, Achats, Assurances, Fiscal & social, Banque, Comptable) avec compteurs.
- **Scan** : OCR animé qui extrait montant/TVA et **classe automatiquement** (« Bob a rangé ce reçu dans Achats »).
- **Détail document** : aperçu, type, rattachement client/dossier, actions (export comptable, renommer).

## Assistant — **Bob** (agent qui agit)
- En-tête : avatar étoile indigo + **« Bob • en ligne »** + sous-titre (selon personnalité).
- **Chat** : intro « Salut, moi c'est Bob 👋 ». Suggestions de prompts. Quand on demande, Bob **annonce le plan puis agit** et renvoie une **carte d'action** (relance préparée / combien je peux me payer / prépa comptable / diagnostic 2026). Indicateur « en train d'écrire ».

## Compte & abonnement
- **Profil** : carte user, bloc entreprise (raison sociale, SIRET, forme/activité), accès **Équipe**, déconnexion.
- **Abonnement** : offre active (Pro 39 €/mois), changer d'offre (**Solo 19 / Pro 39 / Business 79**), factures d'abonnement, **Services en plus** (Paiement en ligne, Avance sur facture, Assurance déc./RC Pro, Comptable partenaire).

## Équipe & rôles
Liste des membres + rôle (Admin) ; « Sur Pro tu bosses en solo, passe à Business pour inviter ».

## Paywall (contextuel) & Diagnostic conformité 2026 (5 étapes, score animé /100)
- **Paywall** : surcouche, bénéfices Business, CTA upgrade.
- **Diagnostic** : intro → 3 questions → résultat avec **anneau de score animé** (proto : 62/100) + actions prioritaires ; **checklist conditionnelle** selon métier/clientèle (ex. assurance décennale ajoutée pour le BTP).

---

### États transverses à prévoir
`loading` (skeletons) · `empty` (carnet vide, aucun document) · `error` (réseau, OCR échoué) · `offline` (le proto ne les montre pas → à concevoir avec le design system). Toujours : argent en `tabular-nums`, hit-targets ≥ 44 px, **pas d'apparition opacité-0** sur contenu au repos.
