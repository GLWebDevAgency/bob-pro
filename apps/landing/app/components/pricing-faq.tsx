'use client';
/**
 * Tarifs (toggle mensuel/annuel jamais pré-coché, 4 colonnes ÉGALES, count-up) + FAQ
 * (accordéons à hauteur animée) + tuile spotlight réutilisable du bento.
 */
import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CountUp } from './motion-kit';

/* ── Tuile bento avec spotlight qui suit le curseur ── */
export function Tile({
  className = '',
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`tile ${className}`}
      onPointerMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty('--mx', `${e.clientX - box.left}px`);
        e.currentTarget.style.setProperty('--my', `${e.clientY - box.top}px`);
      }}
    >
      <div className="spot" aria-hidden />
      {children}
    </div>
  );
}

/* ── Tarifs — prix RÉELS du catalogue produit (C26 v2) ── */
const PLANS = [
  { name: 'Découverte', monthly: 0, annual: 0, tag: null, blurb: 'Pour commencer, sans pression. Facturation conforme incluse.' },
  { name: 'Solo', monthly: 19, annual: 15, tag: null, blurb: 'L’essentiel pour facturer, scanner ses dépenses et travailler avec Bob, seul.' },
  { name: 'Pro', monthly: 39, annual: 31, tag: 'Bob Live inclus', blurb: 'Le vocal en temps réel, les relances automatiques, la trésorerie prévisionnelle.' },
  { name: 'Business', monthly: 79, annual: 63, tag: null, blurb: 'Plusieurs utilisateurs, contrôle comptable avancé, support prioritaire.' },
] as const;

export function Pricing() {
  const [annual, setAnnual] = useState(false); // JAMAIS pré-coché sur annuel
  return (
    <>
      <div className="toggle" role="group" aria-label="Facturation">
        <button type="button" className={annual ? '' : 'on'} onClick={() => setAnnual(false)}>
          Mensuel
        </button>
        <button type="button" className={annual ? 'on' : ''} onClick={() => setAnnual(true)}>
          Annuel
        </button>
        <span className="hint">≈ 2 mois offerts</span>
      </div>
      <div className="plans">
        {PLANS.map((plan) => (
          <Tile key={plan.name} className="plan">
            <span className="name">{plan.name}</span>
            <span className="price num">
              <CountUp to={annual ? plan.annual : plan.monthly} suffix=" €" />
              <small>/mois{annual && plan.monthly > 0 ? ', facturé à l’année' : ''}</small>
            </span>
            {plan.tag ? <span className="tag">{plan.tag}</span> : null}
            <p>{plan.blurb}</p>
          </Tile>
        ))}
      </div>
      <p className="pricing-honesty">
        Essai de 14 jours sur l’offre Pro complète, sans carte bancaire. À la fin, tu choisis — ou
        tu repasses gratuitement sur Découverte, sans perdre tes documents. Tu changes ou tu
        arrêtes ton offre en un clic, à tout moment, depuis ton compte. Pas de petit caractère.
      </p>
    </>
  );
}

/* ── FAQ ── */
const QA = [
  {
    q: 'Bob peut-il se tromper ?',
    a: 'Oui, comme n’importe qui. C’est exactement pour ça que rien ne part sans ta validation : Bob prépare, te montre le résultat, et c’est toi qui envoies.',
  },
  {
    q: 'Où vont mes données ?',
    a: 'Elles sont hébergées en France, chiffrées, et elles restent les tiennes : tu exportes tout — factures, historique, fichier comptable — quand tu veux, en un clic. Aucune revente de données, à personne, jamais.',
  },
  {
    q: 'Et si je ne suis pas à l’aise avec la voix ?',
    a: 'Tout ce que Bob fait à la voix se fait aussi au doigt. Le vocal est un raccourci, jamais une obligation.',
  },
  {
    q: 'Je suis engagé sur combien de temps ?',
    a: 'Aucun engagement. Tu arrêtes ou tu changes d’offre en un clic depuis ton compte, et tes documents restent accessibles même en offre gratuite.',
  },
  {
    q: 'C’est conforme à la facturation électronique 2026 ?',
    a: 'Oui — c’est même le socle de Bob Pro : chaque facture sort au format et avec les mentions exigés par la réforme, y compris pour tes clients professionnels et les administrations.',
  },
] as const;

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="faq">
      {QA.map((item, index) => {
        const isOpen = open === index;
        return (
          <div key={item.q} className={`faq-item${isOpen ? ' open' : ''}`}>
            <button
              type="button"
              className="faq-q"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : index)}
            >
              {item.q}
              <span className="chev" aria-hidden>
                +
              </span>
            </button>
            <AnimatePresence initial={false}>
              {isOpen ? (
                <motion.div
                  className="faq-a"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <p>{item.a}</p>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
