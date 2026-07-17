export default function Home() {
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 28 }}>Bob Pro</h1>
      <p style={{ color: '#5B6B7B' }}>
        Cette page sert à signer un devis à distance ou à consulter un devis/une facture partagé
        par lien. Ouvrez le lien sécurisé reçu (de la forme <code>/sign/&lt;token&gt;</code> pour
        signer, <code>/view/&lt;token&gt;</code> pour consulter).
      </p>
    </main>
  );
}
