import { Nav } from './nav';

/**
 * Landing Bob Pro — conception arrêtée par panel jugé (SPEC pilier 3) :
 * base « démonstration authentique », direction visuelle tokens produit, greffes des juges.
 * DOCTRINE : un seul dossier de démonstration cohérent (Mercier Plomberie), légende sous
 * toute démo chiffrée, AUCUN faux compteur/témoignage, un seul CTA répété (liste d'attente
 * pré-lancement — un mail, pas un faux formulaire), 4 offres à poids visuel ÉGAL.
 */

const WAITLIST_MAILTO =
  'mailto:bonjour@bobpro.fr?subject=Liste%20d%E2%80%99attente%20Bob%20Pro&body=Bonjour%2C%0AJe%20veux%20essayer%20Bob%20Pro%20d%C3%A8s%20l%E2%80%99ouverture.%0AM%C3%A9tier%20%3A%20%0AD%C3%A9partement%20%3A%20';

function PhoneDemo() {
  return (
    <div className="phone-scene" id="demo">
      <div className="phone-halo" aria-hidden />
      <div className="phone" role="img" aria-label="Démonstration : un devis créé à la voix dans l’application Bob Pro">
        <div className="screen">
          <div className="island" aria-hidden />
          <div className="screen-head">
            <div className="who">Bob Live</div>
            Mercier Plomberie
          </div>
          <div className="screen-body" aria-hidden>
            <div className="wave">
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="bub bub-user">
              « Crée un devis pour le Camping Les Pins : remplacement du chauffe-eau, deux heures de
              main-d’œuvre. »
            </div>
            <div className="bub bub-bob">C’est prêt. Je te montre avant d’envoyer :</div>
            <div className="quote-card">
              <div className="qc-head">Devis 2026-0012 · Camping Les Pins</div>
              <div className="qc-line">
                <span>Chauffe-eau 200 L</span>
                <span>230,00 €</span>
              </div>
              <div className="qc-line">
                <span>Main-d’œuvre — 2 h</span>
                <span>110,00 €</span>
              </div>
              <div className="qc-line">
                <span>TVA 10 % (rénovation)</span>
                <span>34,00 €</span>
              </div>
              <div className="qc-total">
                <span>Total TTC</span>
                <span>374,00 €</span>
              </div>
            </div>
            <div className="ready">Devis prêt — à toi de valider</div>
          </div>
        </div>
      </div>
      <div className="phone-caption">Démonstration — dossier Mercier Plomberie (démo)</div>
    </div>
  );
}

export default function Page() {
  return (
    <main id="top">
      <Nav />

      {/* ── Hero : le H1 est une phrase qu'on DIT, pas un slogan ── */}
      <section className="hero">
        <div className="wrap hero-grid">
          <div>
            <span className="eyebrow">Le copilote vocal des artisans</span>
            <h1>
              <span className="quote">«&nbsp;Crée un devis pour le Camping Les&nbsp;Pins.&nbsp;»</span>
            </h1>
            <p className="hero-said">Tu le dis. Bob le fait.</p>
            <p className="hero-sub">
              Devis, factures conformes 2026, relances d’impayés et trésorerie — à la voix, entre
              deux chantiers, pendant que tu gardes les mains sur le volant.
            </p>
            <div>
              <a className="btn btn-primary" href={WAITLIST_MAILTO} id="essai">
                Rejoindre la liste d’attente
              </a>
              <a className="hero-listen" href="#live">
                Voir Bob Live ↓
              </a>
            </div>
            <p className="hero-micro">
              À l’ouverture : 14 jours d’essai sur l’offre Pro complète, sans carte bancaire. Un
              mail suffit — on te répond en personne.
            </p>
          </div>
          <PhoneDemo />
        </div>
      </section>

      {/* ── Confiance factuelle : des garanties vérifiables, jamais un compteur ── */}
      <section className="trust" aria-label="Garanties">
        <div className="wrap trust-items">
          <span>Conforme facturation électronique 2026</span>
          <span>Données hébergées en France</span>
          <span>Sans engagement — tu arrêtes en un clic</span>
          <span>Essai 14 jours, sans carte bancaire</span>
        </div>
      </section>

      {/* ── Le problème : trois lignes qui font dire « c'est exactement ça » ── */}
      <section className="section">
        <div className="wrap">
          <span className="eyebrow">Le soir, après le chantier</span>
          <h2>La paperasse ne s’arrête pas quand le chantier s’arrête.</h2>
          <ul className="pains">
            <li>
              <strong>Le devis attend le soir.</strong> Le client, lui, a déjà appelé un autre
              artisan.
            </li>
            <li>
              <strong>Une facture mal formatée en 2026, c’est un refus de paiement</strong> — pas un
              détail.
            </li>
            <li>
              <strong>Les relances, tu les repousses.</strong> Résultat : des impayés qui dorment
              60, 90, 120 jours.
            </li>
          </ul>
        </div>
      </section>

      {/* ── LA COUTURE NAVY : Bob Live ── */}
      <section className="live" id="live">
        <div className="wrap">
          <span className="eyebrow" style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)' }}>
            La différence Bob Live
          </span>
          <h2>Tu parles. Bob fait le papier.</h2>
          <p className="lead">
            Pas de formulaire, pas de menu à chercher. Tu dis ce que tu dirais à voix haute à ton
            associé — Bob comprend ton métier, applique tes tarifs habituels, et te montre le
            résultat avant d’envoyer quoi que ce soit.
          </p>
          <div className="live-grid">
            <div className="chat" aria-label="Exemples de commandes vocales">
              <div className="say">
                « Relance la facture de la mairie de Vauclain, sur un ton ferme mais correct. »
              </div>
              <div className="do">
                Lettre de relance rédigée, ton ferme. <span className="ok">À valider avant envoi.</span>
              </div>
              <div className="say">« Combien je peux me verser ce mois-ci sans me mettre dans le rouge ? »</div>
              <div className="do">
                Environ 2 000 € en tenant compte des charges à venir. <span className="ok">Détail à l’écran.</span>
              </div>
              <p className="assure">
                Bob prépare, tu valides. Rien ne part sans ton accord.
                <span>Chaque envoi, chaque montant : c’est toi qui appuies sur le bouton.</span>
              </p>
            </div>
            <div className="contrast">
              <h3>Le même chiffre, deux façons de le dire</h3>
              <div className="vs">
                <div className="a">« Solde de trésorerie prévisionnel à 30 jours : 4 812,00 € »</div>
                <div className="b">
                  « Tu peux te verser environ 2 000 € ce mois-ci sans te mettre dans le rouge. »
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Fonctions : chaque bloc = une preuve, un seul dossier démo ── */}
      <section className="section" id="fonctions">
        <div className="wrap">
          <h2>Tout l’administratif, un seul réflexe.</h2>
          <div className="features">
            <div className="feat">
              <h3>Des factures aux normes 2026, sans y penser.</h3>
              <p>
                Mentions obligatoires, format électronique, y compris pour une administration. Bob
                s’en charge — toi tu poses le carrelage.
              </p>
            </div>
            <div className="feat">
              <h3>Les relances que tu ne trouves jamais le temps d’envoyer.</h3>
              <ul className="timeline">
                <li>J+3 — rappel cordial, rédigé par Bob</li>
                <li>J+10 — relance neutre</li>
                <li>J+20 — relance ferme</li>
                <li className="human">J+30 — mise en demeure : TOI tu valides, toujours</li>
              </ul>
              <span className="demo-tag">Le calendrier réel de l’application — pas une promesse.</span>
            </div>
            <div className="feat">
              <h3>Le ticket de chantier, réglé en une photo.</h3>
              <p>Bob lit le ticket, calcule la TVA, range la dépense au bon endroit pour ta compta.</p>
            </div>
            <div className="feat">
              <h3>Le lundi de Bob.</h3>
              <p>
                Chaque lundi à 7 h 30, avant le chantier : ce que tu as encaissé, ce que les
                relances ont récupéré, ce qui t’attend. Tes chiffres réels — et s’il n’y a rien à
                dire, Bob ne dit rien.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Installation : l'objection silencieuse ── */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <h2>5 minutes, pas un après-midi.</h2>
          <div className="steps">
            <div className="step">
              <span className="t">≈ 2 min</span>
              <h3>Ton SIRET, et c’est parti</h3>
              <p>Bob retrouve ta société, ton régime de TVA, tes mentions légales. Tu vérifies, c’est tout.</p>
            </div>
            <div className="step">
              <span className="t">≈ 2 min</span>
              <h3>Tes tarifs habituels</h3>
              <p>Main-d’œuvre, déplacement, fournitures courantes — dictés à la voix si tu veux.</p>
            </div>
            <div className="step">
              <span className="t">≈ 1 min</span>
              <h3>Ton premier devis, à la voix</h3>
              <p>Tu parles, Bob prépare, tu valides. Le réflexe est pris.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Tarifs : 4 colonnes ÉGALES, honnêteté écrite ── */}
      <section className="section" id="tarifs" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <span className="eyebrow">Le prix, sans petites lignes</span>
          <h2>Moins cher qu’une heure de compta perdue chaque mois.</h2>
          <div className="plans">
            <div className="plan">
              <span className="name">Découverte</span>
              <span className="price">
                0 €<small>/mois</small>
              </span>
              <p>Pour commencer, sans pression. Facturation conforme incluse.</p>
            </div>
            <div className="plan">
              <span className="name">Solo</span>
              <span className="price">
                19 €<small>/mois</small>
              </span>
              <p>L’essentiel pour facturer, scanner ses dépenses et travailler avec Bob, seul.</p>
            </div>
            <div className="plan">
              <span className="name">Pro</span>
              <span className="price">
                39 €<small>/mois</small>
              </span>
              <span className="tag">Bob Live inclus</span>
              <p>Le vocal en temps réel, les relances automatiques, la trésorerie prévisionnelle.</p>
            </div>
            <div className="plan">
              <span className="name">Business</span>
              <span className="price">
                79 €<small>/mois</small>
              </span>
              <p>Plusieurs utilisateurs, contrôle comptable avancé, support prioritaire.</p>
            </div>
          </div>
          <p className="pricing-honesty">
            Essai de 14 jours sur l’offre Pro complète, sans carte bancaire. À la fin, tu choisis —
            ou tu repasses gratuitement sur Découverte, sans perdre tes documents. Tu changes ou tu
            arrêtes ton offre en un clic, à tout moment, depuis ton compte. Pas de petit caractère.
          </p>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="section" id="faq" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <h2>Les questions qu’on nous pose vraiment.</h2>
          <div className="faq">
            <details>
              <summary>Bob peut-il se tromper ?</summary>
              <p>
                Oui, comme n’importe qui. C’est exactement pour ça que rien ne part sans ta
                validation : Bob prépare, te montre le résultat, et c’est toi qui envoies.
              </p>
            </details>
            <details>
              <summary>Où vont mes données ?</summary>
              <p>
                Elles sont hébergées en France, chiffrées, et elles restent les tiennes : tu
                exportes tout — factures, historique, fichier comptable — quand tu veux, en un clic.
                Aucune revente de données, à personne, jamais.
              </p>
            </details>
            <details>
              <summary>Et si je ne suis pas à l’aise avec la voix ?</summary>
              <p>
                Tout ce que Bob fait à la voix se fait aussi au doigt. Le vocal est un raccourci,
                jamais une obligation.
              </p>
            </details>
            <details>
              <summary>Je suis engagé sur combien de temps ?</summary>
              <p>
                Aucun engagement. Tu arrêtes ou tu changes d’offre en un clic depuis ton compte, et
                tes documents restent accessibles même en offre gratuite.
              </p>
            </details>
            <details>
              <summary>C’est conforme à la facturation électronique 2026 ?</summary>
              <p>
                Oui — c’est même le socle de Bob Pro : chaque facture sort au format et avec les
                mentions exigés par la réforme, y compris pour tes clients professionnels et les
                administrations.
              </p>
            </details>
          </div>
        </div>
      </section>

      {/* ── CTA final ── */}
      <section className="final">
        <div className="wrap">
          <h2>Ton prochain devis peut se faire dans le camion.</h2>
          <p className="lead" style={{ margin: '16px auto 30px' }}>
            Rejoins la liste d’attente — on te prévient dès l’ouverture. Zéro spam.
          </p>
          <a className="btn btn-primary" href={WAITLIST_MAILTO}>
            Rejoindre la liste d’attente
          </a>
        </div>
      </section>

      <footer className="footer">
        <div className="wrap">
          <p className="honest">
            Bob Pro est un outil, pas un miracle. Il t’aide à aller plus vite ; c’est toi qui restes
            responsable de ce que tu envoies.
          </p>
          <p>© {new Date().getFullYear()} Bob Pro — bonjour@bobpro.fr</p>
        </div>
      </footer>
    </main>
  );
}
