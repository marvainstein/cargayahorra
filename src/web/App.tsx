import { type ReactElement, useCallback, useEffect, useState } from 'react';
import type { CatalogData } from '../server/db/user';
import type { UserProfile } from '../core/types';
import { api } from './api';
import { toast, ToastHost } from './components/ui';
import { Home } from './pages/Home';
import { Plan } from './pages/Plan';
import { History } from './pages/History';
import { Settings } from './pages/Settings';
import { Estado } from './pages/Estado';

export interface ProfileData {
  profile: UserProfile & { defaultPricePerLitre: number | null };
  catalog: CatalogData;
  provinces: Array<{ code: string; name: string }>;
  adjustments: Array<{ id: string; date: string; promotionId: string | null; poolId: string | null; amount: number; note: string }>;
  pools: Array<{ id: string; promotions: string[] }>;
  configured: boolean;
}

type Route = 'home' | 'plan' | 'history' | 'settings' | 'estado';

function currentRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  return (['home', 'plan', 'history', 'settings', 'estado'] as Route[]).includes(h as Route) ? (h as Route) : 'home';
}

const ICONS: Record<string, ReactElement> = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3c3.5 4.2 6 7.4 6 10.3A6 6 0 0 1 6 13.3C6 10.4 8.5 7.2 12 3z" />
    </svg>
  ),
  plan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
};

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute());
  const [profile, setProfile] = useState<ProfileData | null>(null);

  const reloadProfile = useCallback(async () => {
    try {
      const r = await api.get<ProfileData>('/profile');
      setProfile(r.data);
      // Primer uso: configurar qué tiene el usuario antes de recomendar.
      if (!r.data.configured && currentRoute() === 'home') window.location.hash = '#/settings';
    } catch (e) {
      toast((e as Error).message);
    }
  }, []);

  /** Link de configuración: #/importar/<perfil en base64url>. Devuelve true si lo procesó. */
  const applyImportLink = useCallback(() => {
    const m = /^#\/importar\/(.+)$/.exec(window.location.hash);
    if (!m) return false;
    void (async () => {
      try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
        await api.put('/profile', JSON.parse(new TextDecoder().decode(bytes)));
        toast('Perfil configurado');
      } catch {
        toast('El link de configuración no es válido.');
      }
      window.location.hash = '#/home';
      await reloadProfile();
    })();
    return true;
  }, [reloadProfile]);

  useEffect(() => {
    const onHash = () => {
      if (applyImportLink()) return;
      setRoute(currentRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    if (!applyImportLink()) void reloadProfile();
    return () => window.removeEventListener('hashchange', onHash);
  }, [applyImportLink, reloadProfile]);

  const tabs: Array<[Route, string]> = [
    ['home', 'Hoy'],
    ['plan', 'Plan'],
    ['history', 'Historial'],
    ['settings', 'Ajustes'],
  ];

  return (
    <>
      <main className="app">
        {route === 'home' && <Home profile={profile} />}
        {route === 'plan' && <Plan profile={profile} />}
        {route === 'history' && <History />}
        {route === 'settings' && <Settings data={profile} onSaved={reloadProfile} />}
        {route === 'estado' && <Estado />}
      </main>
      <div className="tabbar">
        <nav aria-label="Secciones">
          {tabs.map(([r, label]) => (
            <a key={r} href={`#/${r}`} className={route === r || (route === 'estado' && r === 'settings') ? 'active' : ''} aria-current={route === r ? 'page' : undefined}>
              {ICONS[r]}
              {label}
            </a>
          ))}
        </nav>
      </div>
      <ToastHost />
    </>
  );
}
