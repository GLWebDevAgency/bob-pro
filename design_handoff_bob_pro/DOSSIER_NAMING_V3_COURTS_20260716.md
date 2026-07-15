# Recherche nom — synthèse (Nino / Nico / Gus / Ivo / Théo)

Aucune modification du repo. Méthodologie : RDAP AFNIC (`rdap.nic.fr`) en direct pour la dispo des `.fr` composés, iTunes Search API (`itunes.apple.com/search`, `country=fr`, `entity=software`) pour les conflits App Store FR, WebSearch/WebFetch pour les marques/concurrents. **Limite assumée** : `data.inpi.fr` bloque l'accès automatisé (403, SPA JS) — impossible de faire une recherche INPI formelle par API ; les conflits de marque ci-dessous viennent du web public (sites officiels, presse), pas d'un dépôt INPI vérifié classe par classe. Avant tout dépôt, il faudra une recherche INPI manuelle/juriste sur le nom retenu.

## Brainstorm (28 candidats, 1-2 syllabes, prénom/quasi-prénom)

Max, Léo, Tom, Jules, Gus, Théo, Ben, Lou, Nino, Paco, Enzo, Marc, Otto, Ray, Ted, Aldo, Nico, Milo, Vasco, Django, Bruno, Hugo, Oscar, Félix, Igor, Ivo, Timo, Malo.

## Éliminés (conflit confirmé — preuve à l'appui)

| Nom | Raison de l'élimination |
|---|---|
| Max | HBO Max / Max Canal+ — méga-marque streaming internationale |
| Hugo | Hugo Boss (mode, mondial) + HugoDécrypte (média FR massif) |
| Oscar | Oscar Health (assurance santé US) + dilution « Oscars » |
| Léo | Leocare — assurtech française directe |
| Otto | OTTO GmbH — géant e-commerce allemand/international, app "OTTO" en tête des résultats iTunes FR (Shopping) |
| Félix | Purina Félix — marque FMCG mainstream ultra-connue en France (pâtée pour chat) |
| Jules | Enseigne de prêt-à-porter française **Jules** (groupe Mulliez/AFM), des centaines de magasins — confirmé via recherche + app "Jules Fashion" sur l'App Store FR |
| Ted | **MerciTed** — appli française de devis/factures pour indépendants et TPE, exactement le même secteur et le même pays. + dilution TED Conferences (marque mondiale) |
| Bruno | App **"Bruno: Brutto Netto Rechner"** — Finance, App Store FR + dilution Bruno Mars |
| Enzo | App **"Enzo" — catégorie Finance, éditeur SafeHome GmbH**, live sur l'App Store FR aujourd'hui + association forte Ferrari Enzo |
| Milo | App **"Milo" — catégorie Business** (XXImo B.V.) sur l'App Store FR + `miloapp.fr` déjà exploité par une appli vocale française (enregistrement/transcription de récits, dec. 2024) + Nestlé Milo (boisson mondiale) |
| Timo | **Timo Digital Bank** (BVBank) — néobanque vietnamienne existante, conflit fintech direct et sectoriel |
| Malo | App **"Malo wallet"** — Finance/crypto, App Store FR ; + ancrage géographique Saint-Malo (moins « international ») |
| Aldo, Django, Paco, Vasco, Diego, Adam, Liam, Ethan, Noah, Yann, Kim, Ali | Écartés en 1ère passe : marque(s) connue(s) (ALDO chaussures), poids culturel fort (Django Reinhardt/Tarantino, aussi lu comme le framework web Django par un public tech), 3 syllabes en français, ou prononciation FR≠EN trop divergente (Yann, Diego) |
| Sam, Bob, Georges | Déjà écartés dans les dossiers précédents (NO-GO SAM Outillage cl. 9/42 ; Bob = friction actuelle ; Georges = ex-marque Indy) |

## Vérification approfondie des 6 finalistes + 3 solutions de repli

RDAP AFNIC sur `hey<nom>.fr`, `mon<nom>.fr`, `<nom>app.fr`, `<nom>-gestion.fr` :

- **Théo** : 4/4 libres.
- **Nino** : 4/4 libres.
- **Nico** : 4/4 libres.
- **Timo** : 3/4 libres, `timoapp.fr` déjà déposé (avril 2026, OVH, mais 404 — inactif).
- **Enzo** : 3/4 libres, `monenzo.fr` déposé (Scaleway) mais sans DNS actif.
- **Milo** : 2/4 libres — `miloapp.fr` (actif, vrai produit concurrent) et `milo-gestion.fr` (déposé **le jour même de la recherche**, nameservers de parking → signal qu'un bot de sniping surveille les recherches de noms de domaine, à garder à l'esprit : agir vite une fois le nom choisi).
- **Gus** : 3/4 libres, `heygus.fr` déposé (OVH, août 2025) mais page « site en construction » — inoccupé en pratique.
- **Ivo** : 2/4 libres, `monivo.fr` (erreur SSL, site cassé/dormant) et `ivoapp.fr` (injoignable) déjà déposés.

iTunes Search API FR (`entity=software`), conflits sectoriels (Finance/Business) trouvés :
- Théo → **THEO ロボアドバイザー** (Money Design Co., Japon) — robo-advisor fintech
- Timo → **Timo Digital Bank** (BVBank, Vietnam)
- Enzo → **Enzo** (SafeHome GmbH) — Finance
- Milo → **Milo** (XXImo B.V.) — Business
- Nino, Nico, Gus, Ivo, Marc, Diego, Igor → **aucun résultat Finance/Business homonyme direct**

## Tableau final — 5 candidats classés

| Rang | Nom | Jeu / sonorité | Test vocal (« Hé X, fais-moi un devis ») | Dispo .fr composés | Conflits identifiés | Verdict |
|---|---|---|---|---|---|---|
| 1 | **Nino** | Chaleureux, 2 syllabes, universel (IT/ES/PT/FR) | FR [nino] / EN [NEE-no] — proche, fluide | 4/4 libres (hey/mon/app/-gestion) | Aucun (App Store FR, presse fintech FR, INPI web) — `nino.fr` brut est un site-annuaire de prénom « à vendre », sans enjeu | **Meilleur compromis** : zéro conflit sectoriel, terrain domaine totalement propre |
| 2 | **Nico** | Chaleureux, diminutif universel de Nicolas | FR [niko] / EN [NEE-koh] — quasi identique | 4/4 libres | Aucun conflit sectoriel ; simple bruit culturel neutre (Nico Rosberg F1 — personne, pas une marque) | Très solide, légèrement moins « ownable » car diminutif très répandu |
| 3 | **Gus** | Le plus court (1 syllabe), franc, familier | Risque : le "u" français peut se lire [gys] (comme "bus" en FR) au lieu de [gʌs] anglais → à tester à voix haute avant de trancher | 3/4 libres (`heygus.fr` pris mais site vide/en construction) | Aucun conflit finance/gestion (juste "Gus on the Go", appli enfant, secteur différent) | Fort potentiel mais **valider la prononciation FR** avant de le monter en rang |
| 4 | **Ivo** | Court, doux, pan-européen (NL/DE/IT) | Prononciation proche FR/EN [ivo]/[EE-voh] | 2/4 seulement (`monivo.fr`, `ivoapp.fr` déjà pris, sites cassés/dormants mais indisponibles) | Aucun conflit sectoriel trouvé | Propre mais moins familier/chaleureux pour une oreille française, et déjà 2 domaines cibles bloqués |
| 5 | **Théo** | Le plus « chaleureux » à l'oreille française — prénom très aimé, très haut au palmarès des prénoms | FR [teo] / EN [THEE-oh] — diverge un peu (comme Bob/Sam déjà) | 4/4 libres | **2 conflits réels** : (1) **Theodo** — cabinet de conseil tech français de 700+ personnes (theodo.com), risque de confusion phonétique dans l'écosystème tech/business français ; (2) **THEO** — robo-advisor fintech japonais existant | Le plus séduisant émotionnellement mais **le plus risqué juridiquement/marché**, exactement dans le champ tech+finance visé par l'app — à écarter sauf si le fondateur accepte ce risque en connaissance de cause |

## Recommandation

**Nino** en premier choix : il coche tous les critères durs du fondateur (1-2 syllabes, prénom, chaleureux, prononciation quasi identique FR/EN, invocable à la voix) et c'est le seul des 6 finalistes initiaux à ressortir **sans aucun conflit** — ni App Store, ni marque grand public, ni fintech/gestion concurrente — avec les 4 domaines `.fr` composés (`heynino.fr`, `monnino.fr`, `ninoapp.fr`, `nino-gestion.fr`) tous disponibles à ce jour.

**Nico** est le filet de sécurité n°1 si "Nino" pose un souci (marque proche, préférence sonore) — profil quasi identique, tout aussi propre.

Point d'attention opérationnel : `milo-gestion.fr` a été déposé le jour même de cette recherche par un registrar orienté parking — signe possible de sniping automatisé sur les recherches de noms de domaine. **Dès le nom tranché, réserver immédiatement** les 4 patterns `.fr` (+ `.com`/`.app` si pertinent) avant toute communication publique du choix, et lancer en parallèle une recherche INPI manuelle (classes 9/35/36/42) sur le nom retenu — non réalisable via l'automatisation ici (accès data.inpi.fr bloqué, 403).
