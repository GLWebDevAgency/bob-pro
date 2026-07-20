'use client';
/**
 * SCROLLYTELLING BOB LIVE — section épinglée 320 vh dans la couture navy : le téléphone
 * reste au centre-droit, trois actes défilent à gauche, pilotés par la progression réelle
 * du scroll. Mobile / reduced-motion : trois blocs empilés, téléphone en état final.
 */
import React, { useEffect, useRef, useState } from 'react';
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'motion/react';
import { Phone, type PhoneStage } from './phone';

const ACTS = [
  {
    k: 'Acte 1 — Tu parles',
    title: 'Tu dis les choses comme tu les dis.',
    body: '« Crée un devis pour le Camping Les Pins : remplacement du chauffe-eau, deux heures de main-d’œuvre. » Pas de formulaire, pas de menu — ta voix, entre deux chantiers.',
  },
  {
    k: 'Acte 2 — Bob comprend ton métier',
    title: 'Chaque mot devient une ligne juste.',
    body: 'Le chauffe-eau prend le tarif de ton catalogue, les deux heures deviennent de la main-d’œuvre, la TVA rénovation s’applique toute seule. Tu VOIS la compréhension, ligne par ligne.',
  },
  {
    k: 'Acte 3 — Tu valides',
    title: 'Rien ne part sans ton accord.',
    body: 'Bob prépare et te montre le résultat. L’envoi, c’est toujours toi : un montant, un client, un bouton — et c’est ton doigt qui appuie.',
  },
] as const;

export function LiveScrolly() {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [act, setAct] = useState(0);
  const [isDesktop, setIsDesktop] = useState(true);
  const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start start', 'end end'] });
  useMotionValueEvent(scrollYProgress, 'change', (value) => {
    setAct(Math.min(2, Math.floor(value * 3)));
  });
  useEffect(() => {
    const media = window.matchMedia('(min-width: 961px)');
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const pinned = isDesktop && !reduced;
  const stage: PhoneStage = reduced ? 3 : ((act + 1) as PhoneStage);

  return (
    <section className="navy grain" id="live">
      <div ref={containerRef} className={pinned ? 'scrolly' : undefined}>
        <div className={pinned ? 'scrolly-sticky' : 'scrolly-sticky'}>
          <div className="wrap scrolly-grid">
            <div className={pinned ? 'acts' : undefined}>
              {ACTS.map((entry, index) => {
                const active = !pinned || index === act;
                return (
                  <motion.div
                    key={entry.k}
                    className="act"
                    initial={false}
                    animate={pinned ? { opacity: active ? 1 : 0, y: active ? 0 : index < act ? -18 : 18 } : {}}
                    transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                    style={pinned ? { pointerEvents: active ? 'auto' : 'none' } : undefined}
                  >
                    <span className="k">{entry.k}</span>
                    <h3>{entry.title}</h3>
                    <p>{entry.body}</p>
                    {index === 2 ? <p className="assure">Bob prépare, tu valides. Toujours.</p> : null}
                  </motion.div>
                );
              })}
            </div>
            <Phone stage={pinned ? stage : 3} tilt={false} caption />
          </div>
        </div>
      </div>

      {/* Le même chiffre, deux façons de le dire */}
      <div className="wrap" style={{ paddingBottom: 104 }}>
        <div className="glass contrast">
          <h3>Le même chiffre, deux façons de le dire</h3>
          <p className="a">« Solde de trésorerie prévisionnel à 30 jours : 4 812,00 € »</p>
          <p className="b">« Tu peux te verser environ 2 000 € ce mois-ci sans te mettre dans le rouge. »</p>
        </div>
      </div>
    </section>
  );
}
