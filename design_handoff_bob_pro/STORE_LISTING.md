# Fiches store — Bob Pro (App Store / Google Play)

Doctrine : la même honnêteté que le produit et la landing. Zéro superlatif invérifiable,
zéro « n°1 », zéro faux chiffre. Un seul dossier démo dans les captures (Mercier Plomberie).
Les captures d'écran seront produites depuis le build device final (pas de mockups inventés).

## Identité
- **Nom** : Bob Pro
- **Sous-titre (App Store, ≤30 car.)** : `Le copilote vocal des artisans`
- **Short description (Play, ≤80 car.)** :
  `Devis, factures et relances à la voix. Conforme facturation électronique 2026.`
- **Catégorie** : Économie et entreprise (iOS) / Professionnel (Android)
- **Mots-clés (iOS, ≤100 car.)** :
  `artisan,devis,facture,relance,impayé,TVA,vocal,chantier,auto-entrepreneur,BTP,trésorerie`

## Description longue (FR — les deux stores)

**Tu le dis. Bob le fait.**

Bob Pro est le copilote administratif des artisans et indépendants. Tu lui parles comme à
ton associé — « Crée un devis pour le Camping Les Pins : remplacement du chauffe-eau, deux
heures de main-d'œuvre » — et Bob prépare le devis avec tes tarifs, ta TVA, tes mentions.
Toi, tu vérifies et tu valides. Rien ne part jamais sans ton accord.

**Ce que Bob fait pour toi :**
- **Devis et factures conformes 2026** — mentions obligatoires et format électronique,
  y compris pour les administrations. La réforme est réglée, tu n'y penses plus.
- **Bob Live** — la conversation vocale en temps réel. Mains sur le volant, tu dictes,
  Bob comprend ton métier et fait le papier (offre Pro).
- **Relances d'impayés** — rédigées et programmées par Bob : rappel cordial à J+3, neutre
  à J+10, ferme à J+20. La mise en demeure à J+30, c'est toujours toi qui la valides.
- **Scan de dépenses** — une photo du ticket : TVA calculée, dépense rangée.
- **Trésorerie qui parle humain** — « Tu peux te verser environ 2 000 € ce mois-ci sans te
  mettre dans le rouge. »
- **Le lundi de Bob** — chaque lundi matin, tes chiffres réels de la semaine : encaissé,
  récupéré sur les impayés, ce qui t'attend. S'il n'y a rien à dire, Bob ne dit rien.
- **Pré-compta** — un export propre, prêt pour ton comptable (offre Pro).

**Le vocal est un raccourci, jamais une obligation** : tout ce que Bob fait à la voix se
fait aussi au doigt.

**Essai de 14 jours sur l'offre Pro complète, sans carte bancaire.** À la fin, tu choisis —
ou tu repasses gratuitement sur l'offre Découverte, sans perdre tes documents. Sans
engagement : tu changes ou tu arrêtes en un clic.

**Tes données sont les tiennes** : hébergées en France, chiffrées, exportables à tout
moment. Aucune revente, à personne, jamais.

Bob Pro est un outil, pas un miracle. Il t'aide à aller plus vite ; c'est toi qui restes
responsable de ce que tu envoies.

## Offres (affichage in-app purchase / abonnements)
- Découverte — 0 € (facturation conforme incluse)
- Solo — 19 €/mois (15 €/mois facturé à l'année)
- Pro — 39 €/mois (31 €/mois à l'année) — Bob Live inclus
- Business — 79 €/mois (63 €/mois à l'année)
⚠️ Prix voice_live provisoires jusqu'à l'étude de consommation (SPEC_BOB_LIVE §Plans).
⚠️ Stratégie IAP vs facturation web À ARBITRER (commission 15-30 % — ne jamais promettre
« prix identiques web/mobile » avant cet arbitrage, verdict des juges pilier 2).

## Notes de version 1.0 (modèle)
`Première version publique : devis et factures conformes 2026, Bob Live (offre Pro),
relances d'impayés, scan de dépenses, trésorerie. Dis-nous tout : bonjour@bobpro.fr`

## Privacy (déclarations stores — à faire valider juridiquement avant soumission)
- Données collectées liées à l'identité : coordonnées pro (SIRET, email), documents de
  facturation. Finalité : fonctionnement du service uniquement. Pas de publicité, pas de
  courtage de données, pas de tracking tiers par défaut (analytics produit OPT-OUT côté
  exploitant, sans PII par construction — voir analytics.ts).
- Audio : traité pour la transcription/commande vocale ; politique de rétention à publier
  avec la politique de confidentialité (URL requise par les deux stores).
- À produire avant soumission : politique de confidentialité publique (URL), CGU, mentions
  d'hébergement France, DPO/contact RGPD.

## Reste à faire (chemin critique store)
1. Captures d'écran réelles (6,7" + 5,5" iOS ; téléphone + tablette Android) depuis le
   build final — mêmes écrans que la landing (Bob Live, devis, relances, lundi de Bob).
2. Politique de confidentialité publique + URL (bloquant soumission).
3. Comptes développeur Apple/Google (fondateur) + fiche société.
4. Arbitrage IAP (Apple/Google billing) vs abonnement web — impacte les prix affichés.
5. Build de production EAS (projectId déjà configuré) + TestFlight/internal testing.
