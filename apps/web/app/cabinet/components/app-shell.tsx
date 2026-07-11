'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import styles from '../cabinet.module.css';
import { CloseIcon, DocumentIcon, FolderIcon, LockIcon, MenuIcon, PenIcon, UploadIcon } from './icons';

export type CabinetView = 'dossiers' | 'import' | 'dossier' | 'lettre';

interface AppShellProps {
  activeView: CabinetView;
  children: ReactNode;
  dossierName?: string;
  onNavigate: (view: CabinetView) => void;
}

const NAV_ITEMS: Array<{ id: CabinetView; label: string; icon: typeof FolderIcon }> = [
  { id: 'dossiers', label: 'Dossiers clients', icon: FolderIcon },
  { id: 'import', label: 'Importer un FEC', icon: UploadIcon },
  { id: 'lettre', label: 'Lettre de mission', icon: PenIcon },
];

export function AppShell({ activeView, children, dossierName, onNavigate }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const activeNav = activeView === 'dossier' ? 'dossiers' : activeView;

  const navigate = (view: CabinetView) => {
    onNavigate(view);
    setMenuOpen(false);
  };

  return (
    <div className={styles.shell}>
      <aside className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ''}`} aria-label="Navigation cabinet">
        <div className={styles.brandRow}>
          <button className={styles.brand} onClick={() => navigate('dossiers')} type="button">
            <span>Bob Pro</span>
            <small>Espace cabinet</small>
          </button>
          <button aria-label="Fermer la navigation" className={styles.mobileClose} onClick={() => setMenuOpen(false)} type="button">
            <CloseIcon />
          </button>
        </div>

        <nav className={styles.sideNav}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const selected = activeNav === item.id;
            return (
              <button
                aria-current={selected ? 'page' : undefined}
                className={`${styles.navItem} ${selected ? styles.navItemActive : ''}`}
                key={item.id}
                onClick={() => navigate(item.id)}
                type="button"
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className={styles.localTrust}>
          <LockIcon />
          <div>
            <strong>Traitement local</strong>
            <span>Aucun fichier comptable n’est envoyé.</span>
          </div>
        </div>

        <div className={styles.sidebarFooter}>
          <DocumentIcon />
          <div>
            <strong>Accès cabinet</strong>
            <span>Version locale · sans compte</span>
          </div>
        </div>
      </aside>

      {menuOpen ? <button aria-label="Fermer le menu" className={styles.mobileScrim} onClick={() => setMenuOpen(false)} type="button" /> : null}

      <div className={styles.appColumn}>
        <header className={styles.topbar}>
          <button aria-label="Ouvrir la navigation" className={styles.menuButton} onClick={() => setMenuOpen(true)} type="button">
            <MenuIcon />
          </button>
          <div className={styles.breadcrumbs}>
            <button onClick={() => navigate('dossiers')} type="button">Espace cabinet</button>
            {activeView === 'dossier' && dossierName ? <><span>/</span><strong>{dossierName}</strong></> : null}
            {activeView === 'lettre' ? <><span>/</span><strong>Lettre de mission</strong></> : null}
            {activeView === 'import' ? <><span>/</span><strong>Nouvel import</strong></> : null}
          </div>
          <div className={styles.topbarStatus}>
            <span className={styles.statusDot} />
            100 % local
          </div>
        </header>
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}
