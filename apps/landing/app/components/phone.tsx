'use client';
/**
 * L'iPhone signature — titane 3 couches CSS, Dynamic Island, reflet. L'écran joue la
 * démo Bob Live ; `stage` pilote les états (hero : boucle auto ; scrollytelling : piloté
 * par la progression). Un SEUL dossier démo : Mercier Plomberie / Camping Les Pins.
 */
import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Waveform } from './motion-kit';

export type PhoneStage = 0 | 1 | 2 | 3; // 0 écoute · 1 dictée · 2 devis · 3 validation

const STAGE_MS = [1400, 2600, 3200, 2400];

function Dict({ highlight }: { highlight: boolean }) {
  return (
    <div className="bub bub-user">
      «&nbsp;Crée un devis pour le Camping Les Pins :{' '}
      <span className={`kw${highlight ? ' on' : ''}`}>remplacement du chauffe-eau</span>,{' '}
      <span className={`kw${highlight ? ' on' : ''}`}>deux heures de main-d’œuvre</span>.&nbsp;»
    </div>
  );
}

export function Phone({
  stage,
  auto = false,
  tilt = true,
  caption = true,
}: {
  stage?: PhoneStage;
  auto?: boolean;
  tilt?: boolean;
  caption?: boolean;
}) {
  const reduced = useReducedMotion();
  const [loopStage, setLoopStage] = useState<PhoneStage>(reduced ? 3 : 0);
  useEffect(() => {
    if (!auto || reduced) return;
    const timer = setTimeout(
      () => setLoopStage(((loopStage + 1) % 4) as PhoneStage),
      STAGE_MS[loopStage],
    );
    return () => clearTimeout(timer);
  }, [auto, loopStage, reduced]);
  const s = stage ?? loopStage;

  return (
    <div className="phone-scene">
      <div className="phone-halo" aria-hidden />
      <motion.div
        className="phone"
        role="img"
        aria-label="Démonstration : un devis créé à la voix dans l’application Bob Pro"
        initial={reduced || !tilt ? false : { rotateY: -14, rotateX: 4 }}
        whileInView={tilt && !reduced ? { rotateY: -7, rotateX: 2 } : undefined}
        viewport={{ margin: '-15%' }}
        transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="screen">
          <div className="island" aria-hidden />
          <div className="screen-head">
            <div className="who">Bob Live</div>
            Mercier Plomberie
          </div>
          <div className="screen-body" aria-hidden>
            <div style={{ alignSelf: 'flex-end' }}>
              <Waveform active={s <= 1} width={64} height={18} />
            </div>
            {s >= 1 ? <Dict highlight={s === 2} /> : null}
            {s >= 2 ? (
              <>
                <div className="bub bub-bob">C’est prêt. Je te montre avant d’envoyer :</div>
                <motion.div
                  className="quote-card"
                  initial={reduced ? false : { opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 24 }}
                >
                  <div className="qc-head">Devis 2026-0012 · Camping Les Pins</div>
                  <div className="qc-line">
                    <span>Chauffe-eau 200 L</span>
                    <span className="num">230,00 €</span>
                  </div>
                  <div className="qc-line">
                    <span>Main-d’œuvre — 2 h</span>
                    <span className="num">110,00 €</span>
                  </div>
                  <div className="qc-line">
                    <span>TVA 10 % (rénovation)</span>
                    <span className="num">34,00 €</span>
                  </div>
                  <div className="qc-total">
                    <span>Total TTC</span>
                    <span className="num">374,00 €</span>
                  </div>
                </motion.div>
              </>
            ) : null}
            {s >= 3 ? (
              <motion.div
                className="ready"
                initial={reduced ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: [0.9, 1.04, 1] }}
                transition={{ duration: 0.45 }}
              >
                Devis prêt — à toi de valider
              </motion.div>
            ) : null}
            <span className="chrono num">{s >= 3 ? '0:38' : s >= 2 ? '0:21' : s >= 1 ? '0:09' : '0:00'}</span>
          </div>
        </div>
      </motion.div>
      {caption ? <div className="phone-caption">Démonstration — dossier Mercier Plomberie (démo)</div> : null}
    </div>
  );
}
