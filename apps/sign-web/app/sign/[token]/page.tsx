'use client';

import { useEffect, useState, use } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

interface SignatureView {
  number: string | null;
  companyName: string;
  customerName: string;
  status: string;
  signed: boolean;
  validUntil: string | null;
  lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
  totals: { ht: number; vat: number; ttc: number; netToPay: number };
}

const eur = (cents: number): string => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

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

  useEffect(() => {
    let active = true;
    fetch(`${API}/public/sign/${encodeURIComponent(token)}`)
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
    if (!name.trim() || signing) return;
    setSigning(true);
    setError(null);
    try {
      const r = await fetch(`${API}/public/sign/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signerName: name.trim() }),
      });
      if (!r.ok) throw new Error('Signature impossible. Réessayez.');
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
      <h1 style={{ fontSize: 24, margin: '4px 0 2px' }}>Devis {quote.number ?? ''}</h1>
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
        <p style={{ color: '#8A97A6', fontSize: 13 }}>Valable jusqu&apos;au {quote.validUntil}</p>
      ) : null}

      {alreadySigned ? (
        <p style={{ marginTop: 20, padding: 14, background: '#E8F6EE', color: '#1E7E47', borderRadius: 12, fontWeight: 600 }}>
          ✓ Devis signé — merci ! L&apos;artisan en est informé.
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
