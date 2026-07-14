import { LenisProvider, Reveal, Magnetic, CountUp } from './components/motion-kit';
import { Nav, StickyCta } from './components/nav';
import { Hero } from './components/hero';
import { LiveScrolly } from './components/scrolly';
import { Pricing, Faq, Tile } from './components/pricing-faq';

/**
 * Landing Bob Pro — exécution du brief « ultime » (SPEC pilier 3, panel jugé) :
 * hero cinématographique, scrollytelling épinglé dans la couture navy, bento spotlight,
 * micro-interactions partout — et l'honnêteté comme design (un dossier démo, zéro
 * faux compteur, offres égales, CTA mailto tant qu'aucun backend de formulaire n'existe).
 */

const WAITLIST_MAILTO =
  'mailto:bonjour@bobpro.fr?subject=Liste%20d%E2%80%99attente%20Bob%20Pro&body=Bonjour%2C%0AJe%20veux%20essayer%20Bob%20Pro%20d%C3%A8s%20l%E2%80%99ouverture.%0AM%C3%A9tier%20%3A%20%0AD%C3%A9partement%20%3A%20';

const PAINS = [
  {
    title: 'Le devis attend le soir.',
    body: 'Le client, lui, a déjà appelé un autre artisan. Chaque heure entre la visite et le devis est une chance de moins de signer.',
  },
  {
    title: 'Une facture mal formatée en 2026, c’est un refus de paiement.',
    body: 'La réforme de la facturation électronique ne pardonne pas le « presque conforme ». Ce n’est plus un détail d’intendance, c’est ta trésorerie.',
  },
  {
    title: 'Les relances, tu les repousses.',
    body: 'Personne n’aime réclamer son argent. Résultat : des impayés qui dorment 60, 90, 120 jours pendant que tu avances les fournitures.',
  },
];

export default function Page() {
  return (
    <LenisProvider>
      <main>
        <Nav />
        <Hero mailto={WAITLIST_MAILTO} />

        {/* ── Le problème — éditorial numéroté ── */}
        <section className="section">
          <div className="wrap">
            <Reveal>
              <span className="eyebrow">Le soir, après le chantier</span>
              <h2 style={{ marginTop: 18 }}>La paperasse ne s’arrête pas quand le chantier s’arrête.</h2>
            </Reveal>
            <div className="pains">
              {PAINS.map((pain, index) => (
                <Reveal key={pain.title} delay={index * 0.08}>
                  <div className="pain">
                    <span className="idx">0{index + 1}</span>
                    <div>
                      <h3>{pain.title}</h3>
                      <p>{pain.body}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── LA COUTURE NAVY : scrollytelling Bob Live ── */}
        <LiveScrolly />

        {/* ── Fonctions — bento asymétrique, spotlight au survol ── */}
        <section className="section" id="fonctions">
          <div className="wrap">
            <Reveal>
              <h2>Tout l’administratif, un seul réflexe.</h2>
            </Reveal>
            <div className="bento">
              <Reveal as="div">
                <Tile className="t-lg">
                  <h3>Les relances que tu ne trouves jamais le temps d’envoyer.</h3>
                  <p>Bob rédige et programme. Toi, tu restes le patron de ce qui part.</p>
                  <ul className="timeline">
                    <li>J+3 — rappel cordial, rédigé par Bob</li>
                    <li>J+10 — relance neutre</li>
                    <li>J+20 — relance ferme</li>
                    <li className="human">J+30 — mise en demeure : TOI tu valides, toujours</li>
                  </ul>
                  <span className="demo-tag">Le calendrier réel de l’application — pas une promesse.</span>
                </Tile>
              </Reveal>
              <Reveal delay={0.06}>
                <Tile className="t-lg">
                  <h3>Le lundi de Bob.</h3>
                  <p>
                    Chaque lundi à 7 h 30, avant le chantier : ce que tu as encaissé, ce que les
                    relances ont récupéré, ce qui t’attend. S’il n’y a rien à dire, Bob ne dit rien.
                  </p>
                  <div className="digest-mini" aria-hidden>
                    <div className="big num">
                      + <CountUp to={415} suffix=" €" />
                    </div>
                    récupérés sur tes impayés cette semaine
                    <span className="demo-tag">Démonstration — dossier Mercier Plomberie (démo)</span>
                  </div>
                </Tile>
              </Reveal>
              <Reveal delay={0.04}>
                <Tile className="t-sm">
                  <h3>Le ticket, réglé en une photo.</h3>
                  <p>Bob lit le ticket de chantier, calcule la TVA, range la dépense au bon endroit.</p>
                </Tile>
              </Reveal>
              <Reveal delay={0.08}>
                <Tile className="t-sm">
                  <h3>Une trésorerie qui parle humain.</h3>
                  <p>« Tu peux te verser environ 2 000 € ce mois-ci sans te mettre dans le rouge. »</p>
                </Tile>
              </Reveal>
              <Reveal delay={0.12}>
                <Tile className="t-sm">
                  <h3>Conforme 2026, sans y penser.</h3>
                  <p>Mentions, format électronique, administrations : tes factures sortent aux normes.</p>
                </Tile>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── Installation ── */}
        <section className="section" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <Reveal>
              <h2>5 minutes, pas un après-midi.</h2>
            </Reveal>
            <div className="steps">
              {[
                {
                  t: '≈ 2 min',
                  h: 'Ton SIRET, et c’est parti',
                  p: 'Bob retrouve ta société, ton régime de TVA, tes mentions légales. Tu vérifies, c’est tout.',
                },
                {
                  t: '≈ 2 min',
                  h: 'Tes tarifs habituels',
                  p: 'Main-d’œuvre, déplacement, fournitures courantes — dictés à la voix si tu veux.',
                },
                {
                  t: '≈ 1 min',
                  h: 'Ton premier devis, à la voix',
                  p: 'Tu parles, Bob prépare, tu valides. Le réflexe est pris.',
                },
              ].map((step, index) => (
                <Reveal key={step.h} delay={index * 0.09}>
                  <div className="step">
                    <span className="t">{step.t}</span>
                    <h3>{step.h}</h3>
                    <p>{step.p}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── Tarifs ── */}
        <section className="section" id="tarifs" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <Reveal>
              <span className="eyebrow">Le prix, sans petites lignes</span>
              <h2 style={{ marginTop: 18 }}>Moins cher qu’une heure de compta perdue chaque mois.</h2>
            </Reveal>
            <Reveal delay={0.1}>
              <Pricing />
            </Reveal>
          </div>
        </section>

        {/* ── FAQ ── */}
        <section className="section" id="faq" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <Reveal>
              <h2>Les questions qu’on nous pose vraiment.</h2>
            </Reveal>
            <Reveal delay={0.08}>
              <Faq />
            </Reveal>
          </div>
        </section>

        {/* ── CTA final : 2e et dernière plongée navy ── */}
        <section className="navy final grain" id="essai-final">
          <div className="hero-mesh" aria-hidden style={{ opacity: 0.5 }} />
          <div className="wrap">
            <Reveal>
              <h2>Ton prochain devis peut se faire dans le camion.</h2>
              <p className="lead" style={{ marginInline: 'auto' }}>
                Rejoins la liste d’attente — on te prévient dès l’ouverture. Zéro spam.
              </p>
              <Magnetic>
                <a className="btn btn-light" href={WAITLIST_MAILTO}>
                  Rejoindre la liste d’attente <span className="arrow">→</span>
                </a>
              </Magnetic>
            </Reveal>
          </div>
        </section>

        <footer className="footer">
          <div className="wrap">
            <p className="honest">
              Bob Pro est un outil, pas un miracle. Il t’aide à aller plus vite ; c’est toi qui
              restes responsable de ce que tu envoies.
            </p>
            <p>© {new Date().getFullYear()} Bob Pro — bonjour@bobpro.fr</p>
          </div>
        </footer>

        <StickyCta mailto={WAITLIST_MAILTO} />
      </main>
    </LenisProvider>
  );
}
