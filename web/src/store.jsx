import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, on, connectEvents, disconnectEvents } from './api.js';

const Ctx = createContext(null);
const ROLE = { viewer: 1, editor: 2, admin: 3 };

/** Keeps the user, the monitor list and open alerts in sync with the server via SSE. */
export function StoreProvider({ user, setUser, children }) {
  const [monitors, setMonitors] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [profiles, setProfiles] = useState([]);

  const refresh = useCallback(async () => {
    const [m, a, p] = await Promise.all([get('/monitors'), get('/alerts?status=open'), get('/profiles')]);
    setMonitors(m);
    setAlerts(a);
    setProfiles(p);
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
    connectEvents();
    const upsert = (m) => setMonitors((list) => {
      if (!list) return list;
      const i = list.findIndex((x) => x.id === m.id);
      if (i === -1) return [...list, m];
      const copy = list.slice();
      copy[i] = { ...copy[i], ...m };
      return copy;
    });
    const offs = [
      on('check', ({ monitor }) => upsert(monitor)),
      on('monitor', upsert),
      on('monitorDeleted', ({ id }) => setMonitors((list) => list?.filter((m) => m.id !== id))),
      on('alert', (a) => setAlerts((list) => {
        const rest = list.filter((x) => x.id !== a.id);
        return a.status === 'resolved' ? rest : [a, ...rest].sort((x, y) => y.startedAt - x.startedAt);
      })),
    ];
    // resync after the stream reconnects (events may have been missed)
    const t = setInterval(() => refresh().catch(() => {}), 60_000);
    return () => { offs.forEach((f) => f()); clearInterval(t); disconnectEvents(); };
  }, [refresh]);

  const value = useMemo(() => ({
    user, setUser, monitors, alerts, profiles, refresh, setProfiles,
    can: (role) => ROLE[user?.role] >= ROLE[role],
  }), [user, setUser, monitors, alerts, profiles, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStore = () => useContext(Ctx);
