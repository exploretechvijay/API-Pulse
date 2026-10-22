import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { get } from './api.js';
import { StoreProvider } from './store.jsx';
import Layout from './components/Layout.jsx';
import { Login, Setup } from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import MonitorDetail from './pages/MonitorDetail.jsx';
import MonitorForm from './pages/MonitorForm.jsx';
import Alerts from './pages/Alerts.jsx';
import LatencyTest from './pages/LatencyTest.jsx';
import LoadTest from './pages/LoadTest.jsx';
import Runs from './pages/Runs.jsx';
import RunDetail from './pages/RunDetail.jsx';
import Compare from './pages/Compare.jsx';
import Profiles from './pages/Profiles.jsx';
import Channels from './pages/Channels.jsx';
import Maintenance from './pages/Maintenance.jsx';
import Variables from './pages/Variables.jsx';
import Settings from './pages/Settings.jsx';
import Audit from './pages/Audit.jsx';
import StatusPage from './pages/StatusPage.jsx';

export default function App() {
  const [auth, setAuth] = useState(null); // { needsSetup, user }
  const loc = useLocation();

  useEffect(() => {
    get('/auth/status').then(setAuth).catch(() => setAuth({ needsSetup: false, user: null }));
    const onUnauth = () => setAuth((a) => ({ ...a, user: null }));
    window.addEventListener('pulse:unauthorized', onUnauth);
    return () => window.removeEventListener('pulse:unauthorized', onUnauth);
  }, []);

  if (loc.pathname === '/status') return <StatusPage />;
  if (!auth) return null;
  const setUser = (user) => setAuth({ needsSetup: false, user });
  if (auth.needsSetup) return <Setup onDone={setUser} />;
  if (!auth.user) return <Login onDone={setUser} />;

  return (
    <StoreProvider user={auth.user} setUser={setUser}>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/monitors/new" element={<MonitorForm />} />
          <Route path="/monitors/:id" element={<MonitorDetail />} />
          <Route path="/monitors/:id/edit" element={<MonitorForm />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/tests/latency" element={<LatencyTest />} />
          <Route path="/tests/load" element={<LoadTest />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/compare" element={<Compare />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/maintenance" element={<Maintenance />} />
          <Route path="/variables" element={<Variables />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </StoreProvider>
  );
}
