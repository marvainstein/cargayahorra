import { useEffect, useState } from 'react';
import { FUEL_TYPE_LABELS } from '../../core/labels';
import { FUEL_TYPES, type FuelType, type TriState } from '../../core/types';
import { api, getToken, setToken } from '../api';
import type { ProfileData } from '../App';
import { ars, parsePesosInput, pesosText, toast, Tri } from '../components/ui';

export function Settings({ data, onSaved }: { data: ProfileData | null; onSaved: () => Promise<void> }) {
  const [methods, setMethods] = useState<string[]>([]);
  const [segments, setSegments] = useState<Record<string, TriState>>({});
  const [memberships, setMemberships] = useState<string[]>([]);
  const [apps, setApps] = useState<string[]>([]);
  const [region, setRegion] = useState('');
  const [station, setStation] = useState<string | null>(null);
  const [stationQuery, setStationQuery] = useState('');
  const [split, setSplit] = useState<TriState>('UNKNOWN');
  const [fuel, setFuel] = useState<FuelType>('SUPER');
  const [price, setPrice] = useState('');
  const [tank, setTank] = useState('');
  const [budget, setBudget] = useState('');
  const [token, setTokenInput] = useState(getToken());
  const [adj, setAdj] = useState({ poolId: '', amount: '', date: '', note: '' });

  useEffect(() => {
    if (!data) return;
    const p = data.profile;
    setMethods(p.paymentMethods.map((m) => m.id));
    setSegments(p.segments);
    setMemberships(p.loyaltyMemberships);
    setApps(p.apps);
    setRegion(p.region ?? '');
    setStation(p.defaultStationId);
    setSplit(p.allowSplitPayment);
    setFuel(p.defaultFuelType);
    setPrice(pesosText(p.defaultPricePerLitre));
    setTank(pesosText(p.maxLoadAmount));
    setBudget(pesosText(p.estimatedMonthlyFuelBudget));
  }, [data]);

  if (!data) return <div className="skeleton" />;
  const cat = data.catalog;
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = async () => {
    try {
      await api.put('/profile', {
        paymentMethodIds: methods,
        segments,
        loyaltyMemberships: memberships,
        apps,
        region: region || null,
        defaultStationId: station,
        allowSplitPayment: split,
        defaultFuelType: fuel,
        defaultPricePerLitre: parsePesosInput(price),
        maxLoadAmount: parsePesosInput(tank),
        estimatedMonthlyFuelBudget: parsePesosInput(budget),
      });
      setToken(token.trim());
      await onSaved();
      toast('Ajustes guardados');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const addAdjustment = async () => {
    const amount = parsePesosInput(adj.amount);
    if (!adj.poolId || !amount || !adj.date) return toast('Completá tope, monto y fecha.');
    try {
      await api.post('/adjustments', { poolId: adj.poolId, amount, date: adj.date, note: adj.note });
      setAdj({ poolId: '', amount: '', date: '', note: '' });
      await onSaved();
      toast('Consumo registrado');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const selectedStation = station ? cat.stations.find((st) => st.id === station) ?? null : null;
  const words = norm(stationQuery).split(/\s+/).filter(Boolean);
  const stationMatches = stationQuery.trim().length >= 3 ? cat.stations.filter((st) => words.every((w) => norm(st.name).includes(w))).slice(0, 15) : [];
  // Tarjetas agrupadas por banco/programa, con sus planes (grupos excluyentes) y preguntas sueltas.
  const providerCards = cat.providers
    .map((provider) => {
      const programme = cat.programmes.find((pg) => pg.id === provider.id) ?? null;
      const segs = cat.segments.filter((sg) => sg.providerId === provider.id);
      const groups = cat.segmentGroups
        .filter((g) => g.providerId === provider.id)
        .map((g) => ({ ...g, segments: segs.filter((sg) => sg.groupId === g.id) }))
        .filter((g) => g.segments.length > 0);
      return { provider, programme, methods: cat.paymentMethods.filter((m) => m.providerId === provider.id), groups, singles: segs.filter((sg) => !sg.groupId) };
    })
    .filter((c) => c.methods.length > 0 || c.programme);
  type Group = (typeof providerCards)[number]['groups'][number];
  const groupValue = (g: Group): string => {
    const yes = g.segments.find((sg) => segments[sg.id] === 'YES');
    if (yes) return yes.id;
    if (g.segments.every((sg) => segments[sg.id] === 'NO')) return 'NONE';
    return 'UNKNOWN';
  };
  const setGroup = (g: Group, value: string) => {
    const next = { ...segments };
    for (const sg of g.segments) next[sg.id] = value === 'UNKNOWN' ? 'UNKNOWN' : sg.id === value ? 'YES' : 'NO';
    setSegments(next);
  };

  return (
    <>
      <header className="topbar">
        <div>
          <div className="eyebrow">Tu perfil</div>
          <h1>Ajustes</h1>
        </div>
      </header>
      <div className="banner info">Sólo se guarda qué medios y beneficios tenés. Nunca números de tarjeta, claves ni credenciales.</div>

      <h2>¿Qué tenés?</h2>
      <p className="small muted" style={{ margin: '-4px 4px 10px' }}>
        Marcá tus tarjetas y planes: la recomendación se calcula sólo con lo que tenés.
      </p>
      {providerCards.map(({ provider, methods: pms, groups, singles, programme }) => {
        const enabled = programme ? memberships.includes(programme.id) : pms.some((m) => methods.includes(m.id));
        return (
          <div className="card" key={provider.id} style={{ marginBottom: 12 }}>
            <div className="title" style={{ fontWeight: 800, fontSize: 18, marginBottom: 6 }}>
              {provider.name}
            </div>
            {programme && (
              <label className="check">
                <input type="checkbox" checked={enabled} onChange={() => setMemberships(toggle(memberships, programme.id))} />
                <span>Soy usuario de {programme.name}</span>
              </label>
            )}
            {pms.map((m) => (
              <label className="check" key={m.id}>
                <input type="checkbox" checked={methods.includes(m.id)} onChange={() => setMethods(toggle(methods, m.id))} />
                <span>{m.name}</span>
              </label>
            ))}
            {enabled &&
              groups.map((g) => (
                <div className="field" key={g.id} style={{ marginTop: 10, marginBottom: 4 }}>
                  <span>{g.label}</span>
                  <div className="chips" style={{ flexWrap: 'wrap', marginTop: 0 }}>
                    {[...g.segments.map((sg) => ({ value: sg.id, label: sg.name })), ...(g.allowNone ? [{ value: 'NONE', label: g.noneLabel ?? 'Ninguno' }] : []), { value: 'UNKNOWN', label: 'No sé' }].map((o) => (
                      <button type="button" key={o.value} className={`chip ${groupValue(g) === o.value ? 'active' : ''}`} onClick={() => setGroup(g, o.value)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            {enabled &&
              singles.map((sg) => (
                <div key={sg.id} style={{ marginTop: 10 }}>
                  <div className="small" style={{ marginBottom: 6 }}>
                    {sg.question ?? sg.name}
                  </div>
                  <Tri value={segments[sg.id] ?? 'UNKNOWN'} onChange={(v) => setSegments({ ...segments, [sg.id]: v })} />
                </div>
              ))}
          </div>
        );
      })}

      <h2>Apps que usás para pagar</h2>
      <div className="card">
        {cat.apps.map((a) => (
          <label className="check" key={a.id}>
            <input type="checkbox" checked={apps.includes(a.id)} onChange={() => setApps(toggle(apps, a.id))} />
            <span>{a.name}</span>
          </label>
        ))}
      </div>

      <h2>Tu estación</h2>
      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          Algunas promociones sólo valen en estaciones adheridas. Elegí dónde cargás habitualmente.
        </p>
        {selectedStation ? (
          <div className="row">
            <div>
              <div className="title" style={{ fontWeight: 700 }}>
                {selectedStation.name}
              </div>
              <div className="small muted">{data.provinces.find((p) => p.code === selectedStation.region)?.name ?? ''}</div>
            </div>
            <button className="btn small" onClick={() => setStation(null)}>
              Cambiar
            </button>
          </div>
        ) : (
          <>
            <label className="field" style={{ marginBottom: 8 }}>
              <span>Buscar por calle o localidad</span>
              <input value={stationQuery} onChange={(e) => setStationQuery(e.target.value)} placeholder="Ej. Congreso, Villa Urquiza" autoComplete="off" />
            </label>
            {stationMatches.map((st) => (
              <button
                key={st.id}
                className="list-item"
                style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer', borderTop: '1px solid var(--line)' }}
                onClick={() => {
                  setStation(st.id);
                  if (!region && st.region) setRegion(st.region);
                  setStationQuery('');
                }}
              >
                <span>{st.name}</span>
              </button>
            ))}
            {stationQuery.trim().length >= 3 && stationMatches.length === 0 && (
              <p className="small muted">No aparece en la lista de estaciones conocidas ({cat.stations.length}).</p>
            )}
          </>
        )}
      </div>

      <h2>Cómo cargás</h2>
      <div className="card">
        <label className="field">
          <span>Combustible habitual</span>
          <select value={fuel} onChange={(e) => setFuel(e.target.value as FuelType)}>
            {FUEL_TYPES.map((f) => (
              <option key={f} value={f}>
                {FUEL_TYPE_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Provincia</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">Sin indicar</option>
            {data.provinces.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>¿Tu estación te deja pagar una carga en dos operaciones (dos tarjetas)?</span>
          <Tri value={split} onChange={setSplit} />
        </div>
        <div className="grid2">
          <label className="field">
            <span>Tanque lleno ($)</span>
            <input inputMode="decimal" placeholder="Ej. 60.000" value={tank} onChange={(e) => setTank(e.target.value)} />
          </label>
          <label className="field">
            <span>Precio por litro ($)</span>
            <input inputMode="decimal" placeholder="Opcional" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
        </div>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Presupuesto mensual estimado ($)</span>
          <input inputMode="decimal" placeholder="Ej. 250.000" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
      </div>

      <div className="spacer" />
      <button className="btn primary block" onClick={save}>
        Guardar ajustes
      </button>

      {data.pools.length > 0 && (
        <>
          <h2>Consumos fuera de la app</h2>
          <div className="card">
            <p className="small muted" style={{ marginTop: 0 }}>
              Algunos topes se comparten con otros rubros (p. ej. supermercado). Registrá acá lo que ya usaste para que el cálculo sea exacto.
            </p>
            {data.adjustments.map((a) => (
              <div className="list-item" key={a.id}>
                <div>
                  <div className="title">{a.poolId}</div>
                  <div className="meta">
                    {a.date} {a.note && `· ${a.note}`}
                  </div>
                </div>
                <div className="row">
                  <span className="amount-strong">{ars(a.amount)}</span>
                  <button
                    className="btn small danger"
                    onClick={async () => {
                      await api.del(`/adjustments/${a.id}`);
                      await onSaved();
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <div className="spacer" />
            <label className="field">
              <span>Tope</span>
              <select value={adj.poolId} onChange={(e) => setAdj({ ...adj, poolId: e.target.value })}>
                <option value="">Elegí…</option>
                {data.pools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.promotions.join(' / ')}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid2">
              <label className="field">
                <span>Beneficio usado ($)</span>
                <input inputMode="decimal" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} />
              </label>
              <label className="field">
                <span>Fecha</span>
                <input type="date" value={adj.date} onChange={(e) => setAdj({ ...adj, date: e.target.value })} />
              </label>
            </div>
            <button className="btn block" onClick={addAdjustment}>
              Agregar consumo
            </button>
          </div>
        </>
      )}

      <h2>Acceso</h2>
      <div className="card">
        <label className="field">
          <span>Token de acceso (si el servidor usa APP_TOKEN)</span>
          <input type="password" value={token} onChange={(e) => setTokenInput(e.target.value)} autoComplete="off" />
        </label>
        <a className="btn block" href="#/admin">
          Administración de promociones ›
        </a>
      </div>
    </>
  );
}
