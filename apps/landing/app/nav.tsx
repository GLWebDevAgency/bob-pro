'use client';
import { useEffect, useState } from 'react';

/** Nav sticky : transparente sur le hero, surface blanche + ombre dès le premier scroll. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
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
          Rejoindre la liste d’attente
        </a>
      </div>
    </header>
  );
}
