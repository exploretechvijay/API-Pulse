import { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, AreaChart, Area, ReferenceLine,
} from 'recharts';
import { ms } from '../format.js';

const AXIS = { stroke: 'var(--axis)', tick: { fill: 'var(--muted)', fontSize: 11.5 }, tickLine: false };

function Tip({ active, payload, label, xFormat, yFormat, series }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="t">{xFormat ? xFormat(label) : label}</div>
      {series.map((s) => {
        const p = payload.find((x) => x.dataKey === s.key);
        if (!p) return null;
        return (
          <div className="r" key={s.key}>
            <span className="row"><span className="sw" style={{ background: s.color }} />{s.label}</span>
            <strong className="tabular">{p.value == null ? '—' : (s.format || yFormat)(p.value)}</strong>
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ series, box }) {
  if (!series || series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s) => (
        <span className="item" key={s.key}><span className={`sw ${box ? 'box' : ''}`} style={{ background: s.color }} />{s.label}</span>
      ))}
    </div>
  );
}

/**
 * Line chart over time (one y-axis only).
 * series: [{ key, label, color }]
 */
export function TimeChart({ data, series, height = 220, xKey = 't', xFormat, yFormat = (v) => v, area = false, refLine, yDomain }) {
  const Chart = area ? AreaChart : LineChart;
  // a line needs two points; with sparse data show markers so single values are visible
  const sparse = series.some((s) => data.filter((d) => d[s.key] != null).length < 3);
  const dot = sparse ? { r: 4, strokeWidth: 2, stroke: 'var(--surface)' } : false;
  return (
    <div>
      <Legend series={series} />
      <ResponsiveContainer width="100%" height={height}>
        <Chart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey={xKey} {...AXIS} tickFormatter={xFormat} minTickGap={40} />
          <YAxis {...AXIS} axisLine={false} tickFormatter={yFormat} width={64} domain={yDomain || [0, 'auto']} allowDecimals={false} />
          <Tooltip content={<Tip xFormat={xFormat} yFormat={yFormat} series={series} />} cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} />
          {refLine != null && <ReferenceLine y={refLine.y} stroke="var(--critical)" strokeDasharray="4 4" label={{ value: refLine.label, fill: 'var(--critical)', fontSize: 11, position: 'insideTopRight' }} />}
          {series.map((s) => (area
            ? <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} fill={s.color} fillOpacity={0.15} strokeWidth={2} dot={dot && { ...dot, fill: s.color }} isAnimationActive={false} connectNulls={false} />
            : <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={dot && { ...dot, fill: s.color }} isAnimationActive={false} connectNulls={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} />))}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

/** Uptime history: one cell per time bucket, coloured by status (icon-free cells carry a text tooltip). */
export function UptimeBar({ series, xFormat }) {
  return (
    <div>
      <div className="uptime-bar" role="img" aria-label="Uptime history">
        {series.map((b) => {
          const cls = b.total === 0 ? '' : b.fail > 0 && b.uptime < 50 ? 'bad' : b.fail > 0 || b.slow > 0 ? 'warn' : 'good';
          const title = b.total === 0 ? `${xFormat(b.t)} · no data`
            : `${xFormat(b.t)} · ${b.uptime}% up · ${b.total} checks${b.fail ? ` · ${b.fail} failed` : ''}${b.slow ? ` · ${b.slow} slow` : ''}`;
          return <div key={b.t} className={`cell ${cls}`} title={title} />;
        })}
      </div>
      <div className="legend" style={{ padding: '8px 0 0' }}>
        <span className="item"><span className="sw box" style={{ background: 'var(--good)' }} />All checks passed</span>
        <span className="item"><span className="sw box" style={{ background: 'var(--warning)' }} />Some failed or slow</span>
        <span className="item"><span className="sw box" style={{ background: 'var(--critical)' }} />Mostly down</span>
        <span className="item"><span className="sw box" style={{ background: 'var(--surface-2)' }} />No data</span>
      </div>
    </div>
  );
}

/** Histogram of response times. All histograms on a page share the same bins so they compare directly. */
export function makeBins(allValues, count = 24) {
  if (!allValues.length) return null;
  const sorted = [...allValues].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))]; // clip extreme tail
  const width = Math.max((hi - lo) / count, 0.01);
  return { lo, width, count };
}

export function Histogram({ values, bins, color = 'var(--series-1)', height = 180 }) {
  const data = useMemo(() => {
    if (!bins) return [];
    const out = Array.from({ length: bins.count }, (_, i) => ({ from: bins.lo + i * bins.width, to: bins.lo + (i + 1) * bins.width, n: 0 }));
    for (const v of values) {
      const i = Math.min(bins.count - 1, Math.max(0, Math.floor((v - bins.lo) / bins.width)));
      out[i].n++;
    }
    return out.map((b) => ({ ...b, mid: (b.from + b.to) / 2 }));
  }, [values, bins]);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }} barCategoryGap={2}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="mid" {...AXIS} tickFormatter={(v) => ms(v)} minTickGap={30} />
        <YAxis {...AXIS} axisLine={false} allowDecimals={false} width={40} />
        <Tooltip cursor={{ fill: 'var(--surface-hover)' }} content={({ active, payload }) => (active && payload?.length ? (
          <div className="chart-tip">
            <div className="t">{ms(payload[0].payload.from)} – {ms(payload[0].payload.to)}</div>
            <strong>{payload[0].payload.n}</strong> requests
          </div>) : null)} />
        <Bar dataKey="n" fill={color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export const PHASES = [
  { key: 'dns', label: 'DNS lookup', short: 'DNS', color: 'var(--series-1)' },
  { key: 'tcp', label: 'TCP connect', short: 'TCP', color: 'var(--series-2)' },
  { key: 'tls', label: 'TLS handshake', short: 'TLS', color: 'var(--series-3)' },
  { key: 'ttfb', label: 'Time to first byte', short: 'TTFB', color: 'var(--series-4)' },
  { key: 'download', label: 'Download', short: 'Download', color: 'var(--series-7)' },
];

/** Horizontal stacked bar of request phases, scaled to `max` so several rows compare. */
export function PhaseBar({ phases, max }) {
  const total = PHASES.reduce((a, p) => a + (phases?.[p.key] || 0), 0);
  const scale = max || total || 1;
  return (
    <div className="phase-bar" style={{ width: `${Math.max(2, (total / scale) * 100)}%` }}>
      {PHASES.map((p) => (phases?.[p.key] > 0 ? (
        <div key={p.key} style={{ flex: phases[p.key], background: p.color }} title={`${p.label}: ${ms(phases[p.key])}`} />
      ) : null))}
    </div>
  );
}
