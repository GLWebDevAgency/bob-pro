'use client';
/**
 * HERO — l'ouverture cinématographique : stagger orchestré, H1 qui SE DICTE (caret aiDeep),
 * « Tu le dis. Bob le fait. » qui tombe sec, téléphone qui monte avec overshoot spring.
 */
import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Magnetic, Typed } from './motion-kit';
import { Phone } from './phone';

const EASE = [0.22, 1, 0.36, 1] as const;

export function Hero({ mailto }: { mailto: string }) {
  const reduced = useReducedMotion();
  const enter = (delay: number) =>
    reduced
      ? {}
      : {
          initial: { opacity: 0, y: 26 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.8, delay, ease: EASE },
        };
  return (
    <section className="hero grain" id="top">
      <div className="hero-mesh" aria-hidden />
      <div className="wrap hero-grid">
        <div>
          <motion.div {...enter(0.05)}>
            <span className="eyebrow">Le copilote vocal des artisans</span>
          </motion.div>
          <h1>
            <span className="quote-mark">«&nbsp;</span>
            <Typed text="Crée un devis pour le Camping Les Pins." startDelay={650} />
            <span className="quote-mark">&nbsp;»</span>
          </h1>
          <motion.p className="hero-said" {...enter(0.25)}>
            Tu le dis. Bob le fait.
          </motion.p>
          <motion.p className="hero-sub" {...enter(0.37)}>
            Devis, factures conformes 2026, relances d’impayés et trésorerie — à la voix, entre
            deux chantiers, pendant que tu gardes les mains sur le volant.
          </motion.p>
          <motion.div {...enter(0.49)} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <Magnetic>
              <a className="btn btn-primary" href={mailto} id="essai">
                Rejoindre la liste d’attente <span className="arrow">→</span>
              </a>
            </Magnetic>
            <a className="hero-listen" href="#live">
              Voir Bob Live ↓
            </a>
          </motion.div>
          <motion.p className="hero-micro" {...enter(0.58)}>
            À l’ouverture : 14 jours d’essai sur l’offre Pro complète, sans carte bancaire. Un mail
            suffit — on te répond en personne.
          </motion.p>
        </div>
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 70 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 70, damping: 14, mass: 1, delay: 0.35 }}
        >
          <Phone auto tilt />
        </motion.div>
      </div>
      <div className="trust" aria-label="Garanties">
        <div className="marquee" aria-hidden="false">
          {[0, 1].map((copy) => (
            <React.Fragment key={copy}>
              <span aria-hidden={copy === 1}>Conforme facturation électronique 2026</span>
              <span aria-hidden={copy === 1}>Données hébergées en France</span>
              <span aria-hidden={copy === 1}>Sans engagement — tu arrêtes en un clic</span>
              <span aria-hidden={copy === 1}>Essai 14 jours, sans carte bancaire</span>
            </React.Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
