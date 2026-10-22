import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Bell, Gauge, Zap, History, Wifi, Send, CalendarClock, KeyRound, Settings, ScrollText,
  Menu, Sun, Moon, Monitor as MonitorIcon, LogOut,
} from 'lucide-react';
import { post, onStatus } from '../api.js';
import { useStore } from '../store.jsx';

export function Logo({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M5 17h5l3-7 5 13 3-6h6" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'system');
  const next = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : MonitorIcon;
  const cycle = () => {
    const t = next[theme];
    setTheme(t);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try { localStorage.setItem('pulse-theme', t); } catch { /* ignore */ }
  };
  return (
    <button type="button" className="btn ghost sm" onClick={cycle} title={`Theme: ${theme}`}>
      <Icon size={14} /> {theme[0].toUpperCase() + theme.slice(1)}
    </button>
  );
}

function LiveIndicator() {
  const [s, setS] = useState('closed');
  useEffect(() => onStatus(setS), []);
  const label = s === 'open' ? 'Live' : s === 'reconnecting' ? 'Reconnecting…' : 'Offline';
  return (
    <span className="row small secondary" title="Real-time connection to the server">
      <span className={`dot ${s === 'open' ? 'up' : 'degraded'}`} style={{ width: 8, height: 8, animation: 'none' }} /> {label}
    </span>
  );
}

export default function Layout({ children }) {
  const { user, setUser, alerts, can } = useStore();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const activeAlerts = alerts.filter((a) => a.status === 'active' && !a.suppressed).length;

  const logout = async () => {
    await post('/auth/logout').catch(() => {});
    setUser(null);
    window.location.href = '/';
  };

  const link = (to, Icon, label, extra) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      <Icon size={17} /> {label} {extra}
    </NavLink>
  );

  return (
    <div className="app">
      <div className={`backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><Logo /> API Pulse</div>
        <nav className="nav" aria-label="Main">
          {link('/', LayoutDashboard, 'Dashboard')}
          {link('/alerts', Bell, 'Alerts', activeAlerts ? <span className="count">{activeAlerts}</span> : null)}
          <div className="nav-section">Testing</div>
          {link('/tests/latency', Gauge, 'Latency test')}
          {link('/tests/load', Zap, 'Load test')}
          {link('/runs', History, 'Test runs')}
          <div className="nav-section">Configure</div>
          {link('/profiles', Wifi, 'Network profiles')}
          {link('/channels', Send, 'Alert channels')}
          {link('/maintenance', CalendarClock, 'Maintenance')}
          {link('/variables', KeyRound, 'Variables & secrets')}
          {link('/settings', Settings, 'Settings')}
          {can('admin') && link('/audit', ScrollText, 'Audit log')}
        </nav>
        <div className="sidebar-foot col">
          <div className="row between"><LiveIndicator /><ThemeToggle /></div>
          <div className="row between">
            <div className="ellipsis small">
              <div className="ellipsis" style={{ fontWeight: 600 }}>{user.name || user.email}</div>
              <div className="muted">{user.role}</div>
            </div>
            <button type="button" className="btn ghost sm icon" onClick={logout} title="Sign out" aria-label="Sign out"><LogOut size={15} /></button>
          </div>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button type="button" className="btn ghost icon" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={18} /></button>
          <Logo size={22} /> <strong>API Pulse</strong>
          <span className="grow" />
          <LiveIndicator />
        </div>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
