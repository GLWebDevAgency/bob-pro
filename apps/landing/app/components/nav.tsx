'use client';
import React, { useEffect, useState } from 'react';
import { motion, useScroll, useSpring } from 'motion/react';

/** Nav : transparente sur le hero → glass au scroll, barre de progression de lecture. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 28, mass: 0.4 });
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <header className={`nav${scrolled ? ' scrolled' : ''}`}>
      <div className="wrap nav-inner">
        <a className="wordmark" href="#top">
          Bob&nbsp;Pro
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a href="#live">Bob Live</a>
          <a href="#fonctions">Fonctions</a>
          <a href="#tarifs">Tarifs</a>
          <a href="#faq">FAQ</a>
        </nav>
        <a className="btn btn-primary btn-compact" href="#essai">
          Liste d’attente
        </a>
      </div>
      {scrolled ? <motion.div className="nav-progress" style={{ scaleX: progress }} /> : null}
    </header>
  );
}

/** CTA mobile sticky : visible entre le hero et le CTA final. */
export function StickyCta({ mailto }: { mailto: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const hero = document.getElementById('top');
    const final = document.getElementById('essai-final');
    if (!hero || !final) return;
    let heroGone = false;
    let finalHere = false;
    const update = () => setVisible(heroGone && !finalHere);
    const heroObserver = new IntersectionObserver(([entry]) => {
      heroGone = entry !== undefined && !entry.isIntersecting;
      update();
    });
    const finalObserver = new IntersectionObserver(([entry]) => {
      finalHere = entry?.isIntersecting ?? false;
      update();
    });
    heroObserver.observe(hero);
    finalObserver.observe(final);
    return () => {
      heroObserver.disconnect();
      finalObserver.disconnect();
    };
  }, []);
  if (!visible) return null;
  return (
    <div className="sticky-cta">
      <a className="btn btn-primary" href={mailto}>
        Rejoindre la liste d’attente
      </a>
    </div>
  );
}
