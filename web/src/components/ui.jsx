import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  X, Plus, Trash2, CheckCircle2, AlertTriangle, XCircle, PauseCircle, Clock, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import { STATE_LABEL } from '../format.js';

// ---------- toasts ----------
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = 'info') => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- basic pieces ----------
export function Button({ variant = '', size = '', icon: Icon, children, className = '', ...rest }) {
  return (
    <button type="button" className={`btn ${variant} ${size} ${!children && Icon ? 'icon' : ''} ${className}`} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Input({ value, onChange, className = '', ...rest }) {
  return <input className={`input ${className}`} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} {...rest} />;
}

export function NumberInput({ value, onChange, ...rest }) {
  return (
    <input type="number" className="input tabular" value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value === '' ? null : Number(e.target.value))} {...rest} />
  );
}

export function Select({ value, onChange, options, className = '', ...rest }) {
  return (
    <select className={`input ${className}`} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} {...rest}>
      {options.map((o) => (typeof o === 'string'
        ? <option key={o} value={o}>{o}</option>
        : <option key={String(o.value)} value={o.value ?? ''}>{o.label}</option>))}
    </select>
  );
}

export function Textarea({ value, onChange, rows = 5, ...rest }) {
  return <textarea className="input" rows={rows} value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} {...rest} />;
}

export function Check({ checked, onChange, label, disabled }) {
  return (
    <label className="check">
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="btn-group" role="tablist">
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        return (
          <button type="button" key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)} role="tab" aria-selected={value === v}>
            {typeof o === 'string' ? o : o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button type="button" key={t.value} className={value === t.value ? 'on' : ''} onClick={() => onChange(t.value)} role="tab" aria-selected={value === t.value}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

const STATE_ICON = { up: CheckCircle2, degraded: AlertTriangle, down: XCircle, paused: PauseCircle, pending: Clock };
export function StatusBadge({ state }) {
  const Icon = STATE_ICON[state] || Clock;
  return <span className={`badge ${state}`}><Icon size={13} />{STATE_LABEL[state] || state}</span>;
}
export const StatusDot = ({ state }) => <span className={`dot ${state}`} aria-hidden="true" />;

export function Card({ title, actions, children, className = '', pad = true }) {
  return (
    <div className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div className="card-title">{title}</div>
          {actions && <div className="row wrap">{actions}</div>}
        </div>
      )}
      {pad ? <div className="card-body">{children}</div> : children}
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <div>{children}</div>
      {action && <div className="mt">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="error-box">{error.message || String(error)}</div>;
}

// ---------- modal ----------
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" icon={X} onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = (opts) => new Promise((resolve) => setState({ ...opts, resolve }));
  const node = state && (
    <Modal title={state.title || 'Are you sure?'} onClose={() => { state.resolve(false); setState(null); }}
      footer={<>
        <Button onClick={() => { state.resolve(false); setState(null); }}>Cancel</Button>
        <Button variant={state.danger ? 'danger solid' : 'primary'} onClick={() => { state.resolve(true); setState(null); }}>{state.confirmLabel || 'Confirm'}</Button>
      </>}>
      <div>{state.message}</div>
    </Modal>
  );
  return [confirm, node];
}

// ---------- key/value editor ----------
export function KeyValueEditor({ items, onChange, keyPlaceholder = 'Name', valuePlaceholder = 'Value', addLabel = 'Add' }) {
  const list = items || [];
  const set = (i, patch) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div>
      {list.map((it, i) => (
        <div className="kv-row" key={i}>
          <input className="input mono" placeholder={keyPlaceholder} value={it.key} onChange={(e) => set(i, { key: e.target.value })} />
          <input className="input mono" placeholder={valuePlaceholder} value={it.value} onChange={(e) => set(i, { value: e.target.value })} />
          <Button variant="ghost" icon={Trash2} onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label="Remove" />
        </div>
      ))}
      <Button size="sm" icon={Plus} onClick={() => onChange([...list, { key: '', value: '' }])}>{addLabel}</Button>
    </div>
  );
}

// ---------- pagination ----------
/** Footer pager: "1–10 of 1,234 · Rows [10] · « ‹ Page 1 of 124 › »". `page` is zero-based. */
export function Pager({ page, pageSize, total, onPage, onPageSize, sizes = [10, 25, 50, 100] }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="pager">
      <span className="small secondary tabular">{from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
      <span className="grow" />
      {onPageSize && (
        <label className="row small secondary">
          Rows
          <select className="input" style={{ width: 'auto', height: 28 }} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
      <div className="row" style={{ gap: 2 }}>
        <Button size="sm" variant="ghost" icon={ChevronsLeft} disabled={page === 0} onClick={() => onPage(0)} aria-label="First page" title="Newest" />
        <Button size="sm" variant="ghost" icon={ChevronLeft} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page" />
        <span className="small tabular nowrap" style={{ padding: '0 6px' }}>Page {page + 1} of {pages.toLocaleString()}</span>
        <Button size="sm" variant="ghost" icon={ChevronRight} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page" />
        <Button size="sm" variant="ghost" icon={ChevronsRight} disabled={page >= pages - 1} onClick={() => onPage(pages - 1)} aria-label="Last page" title="Oldest" />
      </div>
    </div>
  );
}

// ---------- data hook ----------
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const run = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fn();
      setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      setState({ data: null, error, loading: false });
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}
