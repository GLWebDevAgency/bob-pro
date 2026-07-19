'use client';

import { useEffect, useState, use } from 'react';

/**
 * A3 — FONCTIONNALITÉ DE RÉTRACTATION EN LIGNE du consommateur (art. L221-21 dernier alinéa du
 * code de la consommation, créé par l'ordonnance n° 2026-2 du 5 janvier 2026 ; modalités :
 * art. D221-5, décret n° 2026-3 — en vigueur depuis le 19 juin 2026) :
 *  • bouton « Renoncer au contrat ici », visible, directement accessible, SANS FRAIS, pendant
 *    toute la durée du délai de rétractation de 14 jours ;
 *  • déclaration en ligne : le consommateur fournit/confirme son nom, les détails du contrat
 *    (devis signé) et le moyen électronique de réception de l'accusé ;
 *  • soumission via « Confirmer la rétractation » ;
 *  • accusé de réception remis sur SUPPORT DURABLE (affiché + envoyé par courriel).
 * Tous les libellés réglementaires sont SERVIS PAR LE SERVEUR (source unique @bob/core),
 * jamais réécrits ici.
 */
const API =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null);

interface RetractationView {
  withdrawLabel: string;
  confirmLabel: string;
  companyName: string;
  customerName: string;
  quoteNumber: string;
  signedAt: string;
  available: boolean;
  alreadyRetracted: boolean;
  expiresAt: string | null;
  prefill: { declarantName: string; email: string | null };
}

interface RetractationAcknowledgment {
  retractedAt: string;
  acknowledgmentLines: string[];
  acknowledgmentEmail: string;
}

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
const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '12px 14px',
  margin: '6px 0 12px',
  borderRadius: 12,
  border: '1px solid #D5DCE4',
  fontSize: 16,
};

export default function RetractPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [view, setView] = useState<RetractationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // D221-5 : la déclaration s'ouvre après le clic sur « Renoncer au contrat ici » — le bouton
  // réglementaire est l'entrée, la confirmation est un second acte distinct.
  const [declaring, setDeclaring] = useState(false);
  const [declarantName, setDeclarantName] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [acknowledgment, setAcknowledgment] = useState<RetractationAcknowledgment | null>(null);

  useEffect(() => {
    if (!API) {
      setError('Service momentanément indisponible. Réessayez plus tard.');
      return;
    }
    let active = true;
    fetch(`${API}/public/retract/${encodeURIComponent(token)}`, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('Lien de rétractation introuvable ou expiré.');
        const data = (await r.json()) as RetractationView;
        if (active) {
          setView(data);
          // Pré-remplissage HONNÊTE (D221-5 : « fournir ou confirmer ») — modifiable.
          setDeclarantName(data.prefill.declarantName);
          setEmail(data.prefill.email ?? '');
        }
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : 'Erreur'));
    return () => {
      active = false;
    };
  }, [token]);

  async function confirm(): Promise<void> {
    if (!API || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`${API}/public/retract/${encodeURIComponent(token)}`, {
        method: 'POST',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          declarantName: declarantName.trim(),
          acknowledgmentEmail: email.trim(),
        }),
      });
      if (r.status === 429) throw new Error('Trop de tentatives. Réessayez dans une minute.');
      if (!r.ok) {
        // Le serveur ne détaille que les erreurs de saisie/fenêtre — message honnête générique sinon.
        let message = 'Rétractation impossible. Vérifiez votre saisie et réessayez.';
        try {
          const payload = (await r.json()) as { message?: string | string[] };
          if (typeof payload.message === 'string') message = payload.message;
          else if (Array.isArray(payload.message) && payload.message.length > 0) message = String(payload.message[0]);
        } catch {
          // corps non JSON : message générique.
        }
        throw new Error(message);
      }
      setAcknowledgment((await r.json()) as RetractationAcknowledgment);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erreur');
    } finally {
      setSubmitting(false);
    }
  }

  if (error && !view) {
    return (
      <main style={card}>
        <h1 style={{ fontSize: 22 }}>Lien indisponible</h1>
        <p style={{ color: '#C0392B' }}>{error}</p>
      </main>
    );
  }
  if (!view) {
    return (
      <main style={card}>
        <p style={{ color: '#5B6B7B' }}>Chargement…</p>
      </main>
    );
  }

  // Accusé de réception (support durable) : affiché intégralement + envoyé par courriel.
  if (acknowledgment) {
    return (
      <main style={card}>
        <h1 style={{ fontSize: 22, margin: '0 0 12px' }}>{acknowledgment.acknowledgmentLines[0]}</h1>
        {acknowledgment.acknowledgmentLines.slice(1).map((line, i) => (
          <p key={i} style={{ color: '#5B6B7B', fontSize: 13, margin: '6px 0', lineHeight: 1.5 }}>
            {line}
          </p>
        ))}
        <p style={{ marginTop: 16, padding: 14, background: '#E8F6EE', color: '#1E7E47', borderRadius: 12, fontWeight: 600 }}>
          Un exemplaire de cet accusé de réception vous est envoyé à {acknowledgment.acknowledgmentEmail}.
          Vous pouvez aussi imprimer ou enregistrer cette page.
        </p>
      </main>
    );
  }

  return (
    <main style={card}>
      <p style={{ color: '#5B6B7B', margin: 0 }}>{view.companyName}</p>
      <h1 style={{ fontSize: 24, margin: '4px 0 2px' }}>Rétractation — devis {view.quoteNumber}</h1>
      <p style={{ color: '#5B6B7B', marginTop: 0 }}>
        Contrat conclu le {frDate(view.signedAt)} par {view.customerName}
      </p>

      {view.alreadyRetracted ? (
        <p style={{ marginTop: 20, padding: 14, background: '#E8F6EE', color: '#1E7E47', borderRadius: 12, fontWeight: 600 }}>
          Votre rétractation a déjà été enregistrée pour ce contrat.
        </p>
      ) : !view.available ? (
        <p style={{ marginTop: 20, padding: 14, background: '#FDEEE6', color: '#B9531B', borderRadius: 12, fontWeight: 600 }}>
          Le délai légal de rétractation de 14 jours est expiré pour ce contrat. Vous pouvez
          contacter directement l&apos;entreprise pour toute question.
        </p>
      ) : !declaring ? (
        <div style={{ marginTop: 20 }}>
          <p style={{ color: '#5B6B7B', fontSize: 13, lineHeight: 1.5 }}>
            Vous disposez d&apos;un droit de rétractation de 14 jours à compter de la conclusion du
            contrat (art. L221-18 du code de la consommation)
            {view.expiresAt ? ` — exerçable ici jusqu'au ${frDate(view.expiresAt)}` : ''}. Cette
            fonctionnalité est gratuite et disponible pendant toute la durée du délai.
          </p>
          {/* Libellé RÉGLEMENTAIRE du bouton (art. D221-5 : « renoncer au contrat ici »). */}
          <button type="button" onClick={() => setDeclaring(true)} style={btn}>
            {view.withdrawLabel}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 20 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#0C2340', margin: '0 0 8px' }}>
            Déclaration de rétractation
          </p>
          <p style={{ color: '#5B6B7B', fontSize: 13, lineHeight: 1.5, marginTop: 0 }}>
            Je notifie par la présente ma rétractation du contrat portant sur la prestation de
            services objet du devis n° {view.quoteNumber} conclu avec {view.companyName}.
          </p>
          <label htmlFor="declarant" style={{ fontSize: 14, color: '#5B6B7B' }}>
            Votre nom
          </label>
          <input
            id="declarant"
            value={declarantName}
            onChange={(e) => setDeclarantName(e.target.value)}
            placeholder="Nom et prénom"
            style={input}
          />
          <label htmlFor="ack-email" style={{ fontSize: 14, color: '#5B6B7B' }}>
            Adresse e-mail pour recevoir l&apos;accusé de réception
          </label>
          <input
            id="ack-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="vous@exemple.fr"
            style={input}
          />
          {error ? <p style={{ color: '#C0392B', marginTop: 0 }}>{error}</p> : null}
          {/* Libellé RÉGLEMENTAIRE de la confirmation (D221-5 : « confirmer la rétractation »). */}
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!declarantName.trim() || !email.trim() || submitting}
            style={{ ...btn, opacity: !declarantName.trim() || !email.trim() || submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Envoi…' : view.confirmLabel}
          </button>
          <p style={{ color: '#8A97A6', fontSize: 12, marginTop: 10 }}>
            Un accusé de réception vous sera remis immédiatement à l&apos;écran et envoyé par
            courriel (support durable).
          </p>
        </div>
      )}
    </main>
  );
}
