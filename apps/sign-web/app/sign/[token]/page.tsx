'use client';

import { useEffect, useState, use } from 'react';

/**
 * NEXT_PUBLIC_API_URL est inlinée au build (Vercel). Le repli localhost n'existe QU'EN dev
 * local : un build de production sans la variable affiche une erreur explicite au lieu de
 * viser silencieusement localhost (audit URLs/redirections 2026-07).
 */
const API =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null);

interface SignatureView {
  number: string;
  companyName: string;
  customerName: string;
  status: string;
  signed: boolean;
  expired: boolean;
  validUntil: string | null;
  lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
  totals: { ht: number; vat: number; ttc: number; netToPay: number };
  /**
   * A1 — mentions légales du devis, fournies préformatées par le serveur (même bloc que le
   * PDF : décennale L243-2, franchise 293 B, médiateur conso, date d'établissement…).
   * Optionnel côté page : une API antérieure au champ ne doit pas casser l'affichage.
   */
  mentions?: string[];
  /**
   * A3 — rétractation 14 jours du CONSOMMATEUR (art. L221-18 s. code conso), présent UNIQUEMENT
   * pour un client particulier : `noticeLines` = avis d'information type (annexe art. R221-3),
   * affiché AVANT signature ; `earlyExecutionLabel` = libellé EXACT de la case optionnelle
   * « exécution immédiate des travaux » (art. L221-25), servi par le serveur — jamais réécrit
   * ici. Optionnel côté page : une API antérieure au champ ne doit pas casser l'affichage.
   */
  retractation?: { noticeLines: string[]; earlyExecutionLabel: string } | null;
}

const eur = (cents: number): string => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

function frDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
}

const card: React.CSSProperties = {
  maxWidth: 560,
  margin: '32px auto',
  padding: 24,
  background: '#fff',
  borderRadius: 16,
  boxShadow: '0 6px 24px rgba(12,35,64,0.08)',
};
const btn: React.CSSProperties = {
  width: '100%',
  padding: '14px 16px',
  borderRadius: 12,
  border: 'none',
  background: '#0C2340',
  color: '#fff',
  fontSize: 16,
  fontWeight: 600,
  cursor: 'pointer',
};

export default function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [quote, setQuote] = useState<SignatureView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [signing, setSigning] = useState(false);
  const [done, setDone] = useState(false);
  // A3 — case « exécution immédiate des travaux » (L221-25) : décochée par défaut, JAMAIS
  // pré-cochée — une demande expresse ne se présume pas.
  const [earlyExecution, setEarlyExecution] = useState(false);
  // A3 — fonctionnalité de rétractation en ligne (art. L221-21 dernier al. c. conso, en vigueur
  // depuis le 19/06/2026) : URL personnelle renvoyée par le serveur à la signature d'un devis
  // B2C — affichée au client immédiatement (elle reste accessible pendant tout le délai).
  const [retractation, setRetractation] = useState<{ url: string; expiresAt: string } | null>(null);

  useEffect(() => {
    if (!API) {
      setError('Service momentanément indisponible. Réessayez plus tard.');
      return;
    }
    let active = true;
    fetch(`${API}/public/sign/${encodeURIComponent(token)}`, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('Devis introuvable ou lien expiré.');
        const data = (await r.json()) as SignatureView;
        if (active) setQuote(data);
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : 'Erreur'));
    return () => {
      active = false;
    };
  }, [token]);

  async function sign(): Promise<void> {
    if (!API || !name.trim() || signing) return;
    setSigning(true);
    setError(null);
    try {
      const r = await fetch(`${API}/public/sign/${encodeURIComponent(token)}`, {
        method: 'POST',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          signerName: name.trim(),
          // A3 — la demande d'exécution anticipée ne part QUE si la case a réellement été
          // cochée (le serveur l'horodate et ne la trace que pour un client particulier).
          ...(quote?.retractation && earlyExecution ? { earlyExecutionRequested: true } : {}),
        }),
      });
      if (r.status === 429) throw new Error('Trop de tentatives. Réessayez dans une minute.');
      if (!r.ok) throw new Error('Signature impossible. Réessayez.');
      // A3 — le serveur renvoie l'URL de la fonctionnalité de rétractation (client B2C).
      // Tolérant : une API antérieure au champ ne casse pas la confirmation de signature.
      try {
        const payload = (await r.json()) as {
          retractation?: { url: string; expiresAt: string } | null;
        };
        if (payload?.retractation?.url) setRetractation(payload.retractation);
      } catch {
        // Réponse sans corps JSON : la signature reste confirmée, sans lien affiché.
      }
      setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erreur');
    } finally {
      setSigning(false);
    }
  }

  if (error && !quote) {
    return (
      <main style={card}>
        <h1 style={{ fontSize: 22 }}>Lien indisponible</h1>
        <p style={{ color: '#C0392B' }}>{error}</p>
      </main>
    );
  }
  if (!quote) {
    return (
      <main style={card}>
        <p style={{ color: '#5B6B7B' }}>Chargement du devis…</p>
      </main>
    );
  }

  const alreadySigned = quote.signed || done || quote.status === 'signed';

  return (
    <main style={card}>
      <p style={{ color: '#5B6B7B', margin: 0 }}>{quote.companyName}</p>
      <h1 style={{ fontSize: 24, margin: '4px 0 2px' }}>Devis {quote.number}</h1>
      <p style={{ color: '#5B6B7B', marginTop: 0 }}>Pour {quote.customerName}</p>

      <div style={{ borderTop: '1px solid #E6EAEF', margin: '16px 0', paddingTop: 12 }}>
        {quote.lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
            <span>
              {l.label} <span style={{ color: '#8A97A6' }}>· {l.qty} × {eur(l.unitPriceHT)} (TVA {l.vatRate} %)</span>
            </span>
            <span style={{ fontWeight: 600 }}>{eur(Math.round(l.qty * l.unitPriceHT))}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 700 }}>
        <span>Total TTC</span>
        <span>{eur(quote.totals.ttc)}</span>
      </div>
      {quote.validUntil ? (
        <p style={{ color: '#8A97A6', fontSize: 13 }}>Valable jusqu&apos;au {frDate(quote.validUntil)}</p>
      ) : null}

      {/* A1 — bloc mentions légales sous le récapitulatif, AVANT la signature : le client doit
          voir les mêmes mentions que sur le PDF du devis (décennale L243-2, 293 B, médiateur…). */}
      {quote.mentions && quote.mentions.length > 0 ? (
        <div style={{ borderTop: '1px solid #E6EAEF', marginTop: 16, paddingTop: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#5B6B7B', margin: '0 0 6px' }}>Mentions légales</p>
          {quote.mentions.map((m, i) => (
            <p key={i} style={{ color: '#8A97A6', fontSize: 12, margin: '4px 0', lineHeight: 1.45 }}>
              {m}
            </p>
          ))}
        </div>
      ) : null}

      {/* A3 — information rétractation AVANT signature (client particulier uniquement) : avis
          d'information type (annexe art. R221-3 c. conso), texte réglementaire servi par le
          serveur. L'afficher avant l'acte de signature est l'obligation d'information L221-5 —
          son absence porterait le délai à 12 mois (art. L221-20). */}
      {quote.retractation && !alreadySigned ? (
        <div style={{ marginTop: 16, padding: 14, background: '#F4F7FA', borderRadius: 12, border: '1px solid #E6EAEF' }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#0C2340', margin: '0 0 6px' }}>
            Votre droit de rétractation (14 jours)
          </p>
          {quote.retractation.noticeLines.slice(1).map((line, i) => (
            <p key={i} style={{ color: '#5B6B7B', fontSize: 12, margin: '4px 0', lineHeight: 1.45 }}>
              {line}
            </p>
          ))}
          <p style={{ color: '#8A97A6', fontSize: 11, marginTop: 8, marginBottom: 0 }}>
            Un formulaire de rétractation détachable est joint au devis (PDF).
          </p>
        </div>
      ) : null}

      {alreadySigned ? (
        <div>
          <p style={{ marginTop: 20, padding: 14, background: '#E8F6EE', color: '#1E7E47', borderRadius: 12, fontWeight: 600 }}>
            Devis signé — merci. Vous pouvez fermer cette page.
          </p>
          {/* A3 — fonctionnalité de rétractation en ligne (L221-21/D221-5) : le lien personnel
              est remis au consommateur dès la conclusion — conservez-le, il reste accessible
              sans frais pendant toute la durée du délai de rétractation de 14 jours. */}
          {retractation ? (
            <div style={{ marginTop: 12, padding: 14, background: '#F4F7FA', borderRadius: 12, border: '1px solid #E6EAEF' }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#0C2340', margin: '0 0 6px' }}>
                Votre lien de rétractation (14 jours)
              </p>
              <p style={{ color: '#5B6B7B', fontSize: 12, margin: '4px 0', lineHeight: 1.45 }}>
                Vous pouvez renoncer au contrat en ligne, sans frais, pendant toute la durée du
                délai légal de rétractation (art. L221-18 et L221-21 du code de la consommation).
                Conservez ce lien personnel :
              </p>
              <p style={{ margin: '8px 0 0', wordBreak: 'break-all' }}>
                <a href={retractation.url} style={{ color: '#0C2340', fontSize: 13, fontWeight: 600 }}>
                  {retractation.url}
                </a>
              </p>
            </div>
          ) : null}
        </div>
      ) : quote.expired ? (
        <p style={{ marginTop: 20, padding: 14, background: '#FDEEE6', color: '#B9531B', borderRadius: 12, fontWeight: 600 }}>
          Ce devis a expiré{quote.validUntil ? ` le ${frDate(quote.validUntil)}` : ''} et ne peut plus être signé. Contactez l&apos;artisan.
        </p>
      ) : (
        <div style={{ marginTop: 20 }}>
          <label htmlFor="name" style={{ fontSize: 14, color: '#5B6B7B' }}>
            Votre nom (signature)
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nom et prénom"
            style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', margin: '6px 0 12px', borderRadius: 12, border: '1px solid #D5DCE4', fontSize: 16 }}
          />
          {/* A3 — case OPTIONNELLE d'exécution anticipée (demande expresse, art. L221-25) :
              libellé exact servi par le serveur, jamais pré-cochée. */}
          {quote.retractation ? (
            <label
              htmlFor="early-execution"
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '4px 0 12px', cursor: 'pointer' }}
            >
              <input
                id="early-execution"
                type="checkbox"
                checked={earlyExecution}
                onChange={(e) => setEarlyExecution(e.target.checked)}
                style={{ marginTop: 3, width: 16, height: 16, flexShrink: 0 }}
              />
              <span style={{ color: '#5B6B7B', fontSize: 12, lineHeight: 1.45 }}>
                {quote.retractation.earlyExecutionLabel}
              </span>
            </label>
          ) : null}
          {error ? <p style={{ color: '#C0392B', marginTop: 0 }}>{error}</p> : null}
          <button type="button" onClick={() => void sign()} disabled={!name.trim() || signing} style={{ ...btn, opacity: !name.trim() || signing ? 0.6 : 1 }}>
            {signing ? 'Signature…' : 'Signer le devis'}
          </button>
          <p style={{ color: '#8A97A6', fontSize: 12, marginTop: 10 }}>
            En signant, vous acceptez le devis. Valeur d&apos;engagement.
          </p>
        </div>
      )}
    </main>
  );
}
