'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { CabinetAccessContext, CabinetRole } from '@/src/cabinet/access';
import { tc } from '@/src/cabinet/i18n';
import styles from '../cabinet.module.css';
import { ArrowLeftIcon, CloseIcon, DocumentIcon, FolderIcon, LockIcon, MenuIcon, PenIcon, UploadIcon } from './icons';

export type CabinetView = 'dossiers' | 'import' | 'dossier' | 'lettre' | 'equipe';

interface AppShellProps {
  access: CabinetAccessContext;
  activeView: CabinetView;
  children: ReactNode;
  dossierName: string | undefined;
  onNavigate: (view: CabinetView) => void;
}

const NAV_ITEMS: Array<{ id: CabinetView; label: string; icon: typeof FolderIcon }> = [
  { id: 'dossiers', label: tc('cabinet.shell.clients'), icon: FolderIcon },
  { id: 'import', label: tc('cabinet.shell.importFec'), icon: UploadIcon },
  { id: 'lettre', label: tc('cabinet.shell.engagementLetter'), icon: PenIcon },
  { id: 'equipe', label: tc('cabinet.shell.team'), icon: DocumentIcon },
];

const ROLE_LABELS: Readonly<Record<CabinetRole, string>> = {
  admin: tc('cabinet.shell.roleAdmin'),
  manager: tc('cabinet.shell.roleManager'),
  collaborator: tc('cabinet.shell.roleCollaborator'),
};

export function AppShell({ access, activeView, children, dossierName, onNavigate }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeNav = activeView === 'dossier' ? 'dossiers' : activeView;

  const navigate = (view: CabinetView) => {
    onNavigate(view);
    setMenuOpen(false);
  };

  useEffect(() => {
    const query = window.matchMedia('(max-width: 860px)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!mobile || !menuOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : openerRef.current;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab' || drawerRef.current === null) return;
      const focusables = Array.from(drawerRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), a[href]'));
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      previousFocus?.focus();
    };
  }, [menuOpen, mobile]);

  return (
    <div className={styles.shell}>
      <aside
        aria-label={tc('cabinet.shell.navigation')}
        aria-modal={mobile && menuOpen ? true : undefined}
        className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ''}`}
        inert={mobile && !menuOpen}
        ref={drawerRef}
        role={mobile ? 'dialog' : undefined}
      >
        <div className={styles.brandRow}>
          <button className={styles.brand} onClick={() => navigate('dossiers')} type="button">
            <span>{tc('cabinet.shell.brand')}</span>
            <small>{tc('cabinet.shell.product')}</small>
          </button>
          <button aria-label={tc('cabinet.shell.closeNavigation')} className={styles.mobileClose} onClick={() => setMenuOpen(false)} ref={closeRef} type="button">
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

        <div className={styles.securityTrust}>
          <LockIcon />
          <div>
            <strong>{tc('cabinet.shell.secureAccess')}</strong>
            <span>{ROLE_LABELS[access.selectedCabinet.role]}</span>
          </div>
        </div>

        <div className={styles.sidebarFooter}>
          <DocumentIcon />
          <div>
            <strong>{access.userEmail}</strong>
            <span>{access.selectedCabinet.name}</span>
          </div>
          <button aria-label={tc('cabinet.shell.signOut')} className={styles.sidebarSignOut} onClick={() => void access.onSignOut()} title={tc('cabinet.shell.signOut')} type="button">
            <ArrowLeftIcon />
          </button>
        </div>
      </aside>

      {menuOpen ? <button aria-label={tc('cabinet.shell.closeMenu')} className={styles.mobileScrim} onClick={() => setMenuOpen(false)} type="button" /> : null}

      <div className={styles.appColumn}>
        <header className={styles.topbar}>
          <button aria-expanded={menuOpen} aria-label={tc('cabinet.shell.openNavigation')} className={styles.menuButton} onClick={() => setMenuOpen(true)} ref={openerRef} type="button">
            <MenuIcon />
          </button>
          <div className={styles.breadcrumbs}>
            <button onClick={() => navigate('dossiers')} type="button">{tc('cabinet.shell.product')}</button>
            {activeView === 'dossier' && dossierName ? <><span>/</span><strong>{dossierName}</strong></> : null}
            {activeView === 'lettre' ? <><span>/</span><strong>{tc('cabinet.shell.engagementLetter')}</strong></> : null}
            {activeView === 'import' ? <><span>/</span><strong>{tc('cabinet.shell.newImport')}</strong></> : null}
            {activeView === 'equipe' ? <><span>/</span><strong>{tc('cabinet.shell.team')}</strong></> : null}
          </div>
          <label className={styles.cabinetPicker}>
            <span>{tc('cabinet.shell.cabinetSelector')}</span>
            <select onChange={(event) => access.onSelectCabinet(event.target.value)} value={access.selectedCabinet.id}>
              {access.cabinets.map((cabinet) => <option key={cabinet.id} value={cabinet.id}>{cabinet.name}</option>)}
            </select>
          </label>
        </header>
        <main className={styles.main} id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
