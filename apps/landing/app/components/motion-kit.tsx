'use client';
/**
 * Kit de mouvement de la landing — Lenis (inertie), Reveal (apparition au scroll),
 * Magnetic (CTA qui suit le curseur), Waveform (onde vocale canvas), CountUp.
 * TOUT respecte prefers-reduced-motion : état final statique, zéro animation.
 */
import React, { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion, animate } from 'motion/react';
import Lenis from 'lenis';

export function LenisProvider({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    const lenis = new Lenis({ lerp: 0.12 });
    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, [reduced]);
  return <>{children}</>;
}

/** Apparition au scroll : fade + 24px, une seule fois, stagger via delay. */
export function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  delay?: number;
  as?: 'div' | 'section' | 'li' | 'span';
}) {
  const reduced = useReducedMotion();
  const MotionTag = motion[Tag];
  return (
    <MotionTag
      initial={reduced ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </MotionTag>
  );
}

/** CTA magnétique : suit le curseur dans un rayon court, ressort au départ. */
export function Magnetic({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  if (reduced) return <>{children}</>;
  return (
    <motion.div
      ref={ref}
      style={{ display: 'inline-block' }}
      animate={{ x: offset.x, y: offset.y }}
      transition={{ type: 'spring', stiffness: 260, damping: 18, mass: 0.6 }}
      onPointerMove={(e) => {
        const box = ref.current?.getBoundingClientRect();
        if (!box) return;
        const dx = e.clientX - (box.left + box.width / 2);
        const dy = e.clientY - (box.top + box.height / 2);
        setOffset({ x: dx * 0.22, y: dy * 0.22 });
      }}
      onPointerLeave={() => setOffset({ x: 0, y: 0 })}
    >
      {children}
    </motion.div>
  );
}

/** Onde vocale VIVANTE — canvas, somme de sinus déphasés (pas un GIF). */
export function Waveform({
  active = true,
  width = 72,
  height = 22,
  color = '#6D28D9',
}: {
  active?: boolean;
  width?: number;
  height?: number;
  color?: string;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const bars = 12;
    const gap = width / bars;
    let raf = 0;
    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      for (let i = 0; i < bars; i += 1) {
        const phase = t / 240 + i * 0.9;
        const energy = active
          ? 0.3 + 0.7 * Math.abs(Math.sin(phase) * 0.6 + Math.sin(phase * 1.7 + 2) * 0.4)
          : 0.18;
        const barHeight = Math.max(3, energy * height);
        const x = i * gap + gap * 0.25;
        const y = (height - barHeight) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, gap * 0.5, barHeight, 2);
        ctx.fill();
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    draw(0);
    return () => cancelAnimationFrame(raf);
  }, [active, width, height, color, reduced]);
  return <canvas ref={ref} style={{ width, height }} aria-hidden />;
}

/** Compteur : 0 → valeur au premier passage à l'écran. */
export function CountUp({ to, suffix = '' }: { to: number; suffix?: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const [value, setValue] = useState(reduced ? to : 0);
  useEffect(() => {
    if (!inView || reduced) return;
    const controls = animate(0, to, {
      duration: 0.7,
      ease: 'easeOut',
      onUpdate: (v) => setValue(Math.round(v)),
    });
    return () => controls.stop();
  }, [inView, to, reduced]);
  return (
    <span ref={ref} className="num">
      {value}
      {suffix}
    </span>
  );
}

/** Dictée : le texte s'écrit à vitesse humaine, caret aiDeep, une fois monté. */
export function Typed({ text, startDelay = 400, speed = 45 }: { text: string; startDelay?: number; speed?: number }) {
  const reduced = useReducedMotion();
  const [count, setCount] = useState(reduced ? text.length : 0);
  const [done, setDone] = useState(reduced);
  useEffect(() => {
    if (reduced) return;
    let i = 0;
    let interval: ReturnType<typeof setInterval>;
    const start = setTimeout(() => {
      interval = setInterval(() => {
        i += 1;
        setCount(i);
        if (i >= text.length) {
          clearInterval(interval);
          setTimeout(() => setDone(true), 900);
        }
      }, speed);
    }, startDelay);
    return () => {
      clearTimeout(start);
      clearInterval(interval);
    };
  }, [text, startDelay, speed, reduced]);
  return (
    <>
      <span className="typed">{text.slice(0, count)}</span>
      {!done && !reduced ? <span className="caret" aria-hidden /> : null}
    </>
  );
}
