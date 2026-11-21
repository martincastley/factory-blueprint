import { useEffect, useMemo, useState } from 'react'
import {
  PRODUCIBLE, nm, fmt, unit, altRecipes, standardRecipe, BELTS, PIPES, MINER_BASE, OIL_BASE, PURITY,
  supplyKind, isLiquid, BUILDINGS,
} from './data.js'
import { unitChain, sharedInput, solve } from './solver.js'
import { buildLayout } from './layout.js'
import Blueprint from './Blueprint.jsx'

const MODES = [
  { id: 'perfect', t: '100 % efficiency', d: 'Every machine runs at exactly 100 % and never waits for input. May leave some resources unused.' },
  { id: 'max', t: 'Max output from my nodes', d: 'Uses all your resources. Each step has at most one underclocked machine.' },
  { id: 'fewest', t: 'Fewest buildings', d: 'Overclocks machines (up to 250 %) to cut building count. Needs power shards.' },
  { id: 'lowpower', t: 'Lowest power', d: 'Same output as max, with all machines in a step evenly underclocked.' },
]

const DEFAULT = {
  products: [], recipeMode: {}, choice: {}, supply: {}, belt: 2, pipe: 1,
  prioKind: 'equal', prioFirst: 0, custom: 50, mode: 'perfect', step: 0,
}
function load() { try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem('bp-planner') || '{}') } } catch { return DEFAULT } }

export default function App() {
  const [S, setS] = useState(load)
  const set = (patch) => setS((s) => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }))
  useEffect(() => { try { localStorage.setItem('bp-planner', JSON.stringify(S)) } catch { /* ignore */ } }, [S])

  const beltCap = BELTS[S.belt - 1].rate, pipeCap = PIPES[S.pipe - 1].rate
  const products = S.products.map((p) => ({ id: p.id, target: +p.target || 0 }))
  const choice = useMemo(() => {
    const c = {}
    S.products.forEach((p) => { if (S.recipeMode[p.id] === 'alt' && S.choice[p.id]) c[p.id] = S.choice[p.id] })
    return c
  }, [S.products, S.recipeMode, S.choice])
  const chains = useMemo(() => products.map((p) => unitChain(p.id, choice)), [S.products, choice]) // eslint-disable-line react-hooks/exhaustive-deps
  const shared = useMemo(() => sharedInput(chains), [chains])
  const rawNeeded = useMemo(() => [...new Set(chains.flatMap((c) => Object.keys(c.raw)))], [chains])

  const avail = useMemo(() => {
    const a = {}
    rawNeeded.forEach((r) => {
      const s = S.supply[r] || {}
      const kind = supplyKind(r)
      let v = +s.direct || 0
      if (kind === 'water' && s.unlimited !== false) v = Infinity
      ;(s.nodes || []).forEach((n) => {
        const base = kind === 'oil' ? OIL_BASE : MINER_BASE[n.mk]
        v += Math.min(base * PURITY[n.purity] * (n.clock / 100), kind === 'oil' ? pipeCap : beltCap)
      })
      a[r] = v
    })
    return a
  }, [rawNeeded, S.supply, beltCap, pipeCap])

  const prio = useMemo(() => {
    const n = products.length
    if (n < 2) return null
    if (shared.kind !== 'linked') return shared.kind === 'raw' ? { type: 'share', weights: Array(n).fill(1 / n) } : null
    if (S.prioKind === 'first') return { type: 'order', order: [S.prioFirst, ...products.map((_, i) => i).filter((i) => i !== S.prioFirst)] }
    if (S.prioKind === 'custom' && n === 2) return { type: 'share', weights: [S.custom / 100, 1 - S.custom / 100] }
    return { type: 'share', weights: Array(n).fill(1 / n) }
  }, [products.length, shared.kind, S.prioKind, S.prioFirst, S.custom]) // eslint-disable-line react-hooks/exhaustive-deps

  const steps = ['products', 'recipes', 'resources', ...(shared.kind === 'linked' ? ['priority'] : []), 'optimize', 'result']
  const stepIdx = Math.min(S.step, steps.length - 1)
  const cur = steps[stepIdx]

  const canNext = {
    products: S.products.length > 0,
    recipes: S.products.every((p) => S.recipeMode[p.id] !== 'alt' || S.choice[p.id]),
    resources: rawNeeded.every((r) => avail[r] > 0 || products.every((p) => p.target > 0)) && rawNeeded.every((r) => avail[r] > 0),
    priority: true, optimize: true, result: true,
  }[cur]

  const plan = useMemo(() => {
    if (!S.products.length || cur !== 'result' && cur !== 'optimize') return null
    try { return solve({ products, choice, avail, mode: S.mode, prio }) } catch (e) { console.error(e); return null }
  }, [cur, S.products, choice, avail, S.mode, prio]) // eslint-disable-line react-hooks/exhaustive-deps
  const layout = useMemo(() => (plan && cur === 'result' && plan.steps.length ? buildLayout(plan, beltCap, pipeCap) : null), [plan, cur, beltCap, pipeCap])
  const title = S.products.map((p) => nm(p.id)).join(' + ') || 'NEW FACTORY'

  return (
    <div className="app">
      <header className="top">
        <div className="logo">FACTORY<span>/</span>BLUEPRINT</div>
        <ol className="crumbs">
          {steps.map((s, i) => (
            <li key={s} className={i === stepIdx ? 'on' : i < stepIdx ? 'done' : ''} onClick={() => i < stepIdx && set({ step: i })}>
              <span>{String(i + 1).padStart(2, '0')}</span>{s}
            </li>
          ))}
        </ol>
      </header>
      <div className="body">
        <aside className="panel">
          {cur === 'products' && <Products S={S} set={set} />}
          {cur === 'recipes' && <Recipes S={S} set={set} />}
          {cur === 'resources' && <Resources S={S} set={set} raw={rawNeeded} avail={avail} chains={chains} beltCap={beltCap} pipeCap={pipeCap} />}
          {cur === 'priority' && <Priority S={S} set={set} shared={shared} />}
          {cur === 'optimize' && <Optimize S={S} set={set} products={products} choice={choice} avail={avail} prio={prio} />}
          {cur === 'result' && plan && <Result plan={plan} layout={layout} avail={avail} />}
          <div className="nav">
            {stepIdx > 0 && <button className="ghost" onClick={() => set({ step: stepIdx - 1 })}>← Back</button>}
            {cur !== 'result' && <button className="primary" disabled={!canNext} onClick={() => set({ step: stepIdx + 1 })}>{steps[stepIdx + 1] === 'result' ? 'Generate blueprint →' : 'Next →'}</button>}
            {cur === 'result' && <button className="ghost" onClick={() => set({ ...DEFAULT })}>New factory</button>}
          </div>
        </aside>
        <main className="stage">
          {layout ? <Blueprint layout={layout} title={title} /> : <EmptySheet cur={cur} />}
        </main>
      </div>
    </div>
  )
}

function EmptySheet({ cur }) {
  return (
    <div className="empty-sheet">
      <div className="stamp">
        <div>DRAWING PENDING</div>
        <small>{cur === 'optimize' ? 'Choose a goal and generate the blueprint' : 'Complete the steps on the left'}</small>
      </div>
    </div>
  )
}

// ---------------- steps ----------------
function Products({ S, set }) {
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  const rank = (id) => { const n = nm(id).toLowerCase(); return n === ql ? 0 : n.startsWith(ql) ? 1 : 2 }
  const matches = ql ? PRODUCIBLE.filter((id) => nm(id).toLowerCase().includes(ql) && !S.products.some((p) => p.id === id))
    .sort((a, b) => rank(a) - rank(b)).slice(0, 8) : []
  const add = (id) => { set((s) => ({ products: [...s.products, { id, target: '' }] })); setQ('') }
  return (
    <section>
      <h2>What are you making?</h2>
      <p className="lead">Add one or more products. Leave the rate empty to make as much as your resources allow.</p>
      <div className="search">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. Steel Beam"
          onKeyDown={(e) => e.key === 'Enter' && matches[0] && add(matches[0])} />
        {matches.length > 0 && <ul className="dropdown">{matches.map((id) => <li key={id} onClick={() => add(id)}>{nm(id)}</li>)}</ul>}
      </div>
      {S.products.map((p, i) => (
        <div className="card row" key={p.id}>
          <b className="grow">{nm(p.id)}</b>
          <input className="num small" type="number" min="0" placeholder="max" value={p.target}
            onChange={(e) => set((s) => ({ products: s.products.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)) }))} />
          <span className="muted">{unit(p.id)}</span>
          <button className="x" onClick={() => set((s) => ({ products: s.products.filter((_, j) => j !== i) }))}>×</button>
        </div>
      ))}
    </section>
  )
}

function io(r) {
  const f = (a) => a.map(([x, q]) => `${fmt(q)} ${nm(x)}`).join(' + ')
  return `${f(r.in)} → ${f(r.out)}`
}

function Recipes({ S, set }) {
  return (
    <section>
      <h2>Recipes</h2>
      <p className="lead">Standard or alternate recipe for each product? Intermediate parts use standard recipes for now.</p>
      {S.products.map((p) => {
        const alts = altRecipes(p.id)
        const mode = S.recipeMode[p.id] || 'standard'
        const std = standardRecipe(p.id)
        return (
          <div className="card" key={p.id}>
            <b>{nm(p.id)}</b>
            <div className="seg">
              <button className={mode === 'standard' ? 'on' : ''} onClick={() => set((s) => ({ recipeMode: { ...s.recipeMode, [p.id]: 'standard' } }))}>Standard</button>
              <button className={mode === 'alt' ? 'on' : ''} disabled={!alts.length} onClick={() => set((s) => ({ recipeMode: { ...s.recipeMode, [p.id]: 'alt' } }))}>Alternative{!alts.length && ' (none)'}</button>
            </div>
            {mode === 'standard' && <div className="recipe muted">{BUILDINGS[std.b].n}: {io(std)} per min</div>}
            {mode === 'alt' && alts.map((r) => (
              <label key={r.id} className={'opt' + (S.choice[p.id] === r.id ? ' on' : '')}>
                <input type="radio" name={'alt' + p.id} checked={S.choice[p.id] === r.id} onChange={() => set((s) => ({ choice: { ...s.choice, [p.id]: r.id } }))} />
                <div><b>{r.n.replace('Alternate: ', '')}</b> <span className="muted">· {BUILDINGS[r.b].n}</span><div className="recipe">{io(r)} per min</div></div>
              </label>
            ))}
          </div>
        )
      })}
    </section>
  )
}

function Resources({ S, set, raw, avail, chains, beltCap, pipeCap }) {
  const upd = (r, f) => set((s) => ({ supply: { ...s.supply, [r]: f({ nodes: [], ...(s.supply[r] || {}) }) } }))
  return (
    <section>
      <h2>Resources</h2>
      <p className="lead">This chain needs {raw.map(nm).join(', ')}. Tell me what you have access to.</p>
      <div className="card row">
        <span className="grow">Best belt</span>
        <select value={S.belt} onChange={(e) => set({ belt: +e.target.value })}>{BELTS.map((b) => <option key={b.mk} value={b.mk}>Mk{b.mk} · {b.rate}/min</option>)}</select>
      </div>
      {raw.some(isLiquid) && (
        <div className="card row">
          <span className="grow">Best pipe</span>
          <select value={S.pipe} onChange={(e) => set({ pipe: +e.target.value })}>{PIPES.map((b) => <option key={b.mk} value={b.mk}>Mk{b.mk} · {b.rate} m³/min</option>)}</select>
        </div>
      )}
      {raw.map((r) => {
        const kind = supplyKind(r)
        const s = S.supply[r] || { nodes: [] }
        const perUnit = chains.reduce((a, c) => a + (c.raw[r] || 0), 0)
        return (
          <div className="card" key={r}>
            <div className="row"><b className="grow">{nm(r)}</b><span className="tag">{Number.isFinite(avail[r]) ? fmt(avail[r], 1) : '∞'} {unit(r)} available</span></div>
            {kind === 'water' && (
              <label className="check"><input type="checkbox" checked={s.unlimited !== false} onChange={(e) => upd(r, (x) => ({ ...x, unlimited: e.target.checked }))} /> Unlimited – I'll place Water Extractors as needed</label>
            )}
            {(kind === 'miner' || kind === 'oil') && (s.nodes || []).map((n, i) => {
              const base = kind === 'oil' ? OIL_BASE : MINER_BASE[n.mk]
              const rawRate = base * PURITY[n.purity] * (n.clock / 100)
              const cap = kind === 'oil' ? pipeCap : beltCap
              return (
                <div className="node-row" key={i}>
                  <select value={n.purity} onChange={(e) => upd(r, (x) => ({ ...x, nodes: x.nodes.map((m, j) => (j === i ? { ...m, purity: e.target.value } : m)) }))}>
                    <option value="impure">Impure</option><option value="normal">Normal</option><option value="pure">Pure</option>
                  </select>
                  {kind === 'miner' && (
                    <select value={n.mk} onChange={(e) => upd(r, (x) => ({ ...x, nodes: x.nodes.map((m, j) => (j === i ? { ...m, mk: +e.target.value } : m)) }))}>
                      <option value={1}>Miner Mk1</option><option value={2}>Miner Mk2</option><option value={3}>Miner Mk3</option>
                    </select>
                  )}
                  {kind === 'oil' && <span className="muted">Oil Extractor</span>}
                  <input className="num tiny" type="number" min="1" max="250" value={n.clock} onChange={(e) => upd(r, (x) => ({ ...x, nodes: x.nodes.map((m, j) => (j === i ? { ...m, clock: Math.min(250, +e.target.value || 0) } : m)) }))} />
                  <span className="muted">%</span>
                  <span className={'rate' + (rawRate > cap ? ' warn' : '')} title={rawRate > cap ? 'Limited by your belt/pipe' : ''}>{fmt(Math.min(rawRate, cap), 1)}</span>
                  <button className="x" onClick={() => upd(r, (x) => ({ ...x, nodes: x.nodes.filter((_, j) => j !== i) }))}>×</button>
                </div>
              )
            })}
            {(kind === 'miner' || kind === 'oil') && (
              <button className="ghost small" onClick={() => upd(r, (x) => ({ ...x, nodes: [...(x.nodes || []), { purity: 'normal', mk: 1, clock: 100 }] }))}>+ Add node</button>
            )}
            <div className="row direct">
              <span className="muted grow">{kind === 'direct' ? 'Supply rate' : 'Other supply (train, storage…)'}</span>
              <input className="num small" type="number" min="0" placeholder="0" value={s.direct || ''} onChange={(e) => upd(r, (x) => ({ ...x, direct: e.target.value }))} />
              <span className="muted">{unit(r)}</span>
            </div>
            <div className="hint">One {nm(chains[0]?.pid)} machine needs {fmt(chains[0]?.raw[r] || perUnit)} {unit(r)} of this.</div>
          </div>
        )
      })}
    </section>
  )
}

function Priority({ S, set, shared }) {
  const two = S.products.length === 2
  return (
    <section>
      <h2>Priority</h2>
      <p className="lead">Your products share <b>{nm(shared.item)}</b>. How should it be divided?</p>
      {S.products.map((p, i) => (
        <label key={p.id} className={'opt' + (S.prioKind === 'first' && S.prioFirst === i ? ' on' : '')}>
          <input type="radio" checked={S.prioKind === 'first' && S.prioFirst === i} onChange={() => set({ prioKind: 'first', prioFirst: i })} />
          <div><b>Prioritize {nm(p.id)}</b><div className="muted">As much as possible; the rest gets what's left.</div></div>
        </label>
      ))}
      <label className={'opt' + (S.prioKind === 'equal' ? ' on' : '')}>
        <input type="radio" checked={S.prioKind === 'equal'} onChange={() => set({ prioKind: 'equal' })} />
        <div><b>Divide equally</b><div className="muted">Each product gets the same amount of {nm(shared.item)}.</div></div>
      </label>
      {two && (
        <label className={'opt' + (S.prioKind === 'custom' ? ' on' : '')}>
          <input type="radio" checked={S.prioKind === 'custom'} onChange={() => set({ prioKind: 'custom' })} />
          <div className="grow"><b>Custom split</b>
            <input type="range" min="0" max="100" value={S.custom} onChange={(e) => set({ prioKind: 'custom', custom: +e.target.value })} />
            <div className="muted">{S.custom}% {nm(S.products[0].id)} · {100 - S.custom}% {nm(S.products[1].id)}</div>
          </div>
        </label>
      )}
    </section>
  )
}

function Optimize({ S, set, products, choice, avail, prio }) {
  const previews = useMemo(() => MODES.map((m) => {
    try { return solve({ products, choice, avail, mode: m.id, prio }) } catch { return null }
  }), [products, choice, avail, prio]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section>
      <h2>Optimize for</h2>
      <p className="lead">Preview of what each goal produces with your resources.</p>
      {MODES.map((m, i) => {
        const p = previews[i]
        return (
          <label key={m.id} className={'opt' + (S.mode === m.id ? ' on' : '')}>
            <input type="radio" checked={S.mode === m.id} onChange={() => set({ mode: m.id })} />
            <div className="grow"><b>{m.t}</b>{m.id === 'perfect' && <span className="tag">recommended</span>}
              <div className="muted">{m.d}</div>
              {p && (
                <div className="preview">
                  {p.out.map((o) => <span key={o.id}>{nm(o.id)} <b>{fmt(o.rate, 1)}</b>/min</span>)}
                  <span>{p.machines} machines · {fmt(p.power, 0)} MW{p.shards ? ` · ${p.shards} shards` : ''}</span>
                  {p.mode !== m.id && <span className="warn">No perfect build possible – falls back to max output</span>}
                </div>
              )}
            </div>
          </label>
        )
      })}
    </section>
  )
}

function Result({ plan, layout, avail }) {
  return (
    <section>
      <h2>Production plan</h2>
      {plan.notes.map((n, i) => <div key={i} className="note">{n}</div>)}
      <div className="card">
        {plan.out.map((o) => <div className="row" key={o.id}><span className="grow">{nm(o.id)}</span><b className="big">{fmt(o.rate, 2)}</b><span className="muted">{unit(o.id)}</span></div>)}
      </div>
      <div className="kpis">
        <div><b>{plan.machines}</b><span>machines</span></div>
        <div><b>{fmt(plan.power, 1)}</b><span>MW</span></div>
        {plan.shards > 0 && <div><b>{plan.shards}</b><span>power shards</span></div>}
      </div>
      <h3>Machines</h3>
      <table>
        <tbody>
          {plan.steps.map((s) => {
            const groups = {}
            s.clocks.forEach((c) => { const k = fmt(c * 100, 3); groups[k] = (groups[k] || 0) + 1 })
            return (
              <tr key={s.item}>
                <td>{s.clocks.length}× {BUILDINGS[s.recipe.b].n}<div className="muted">{s.recipe.n}</div></td>
                <td className="r">{Object.entries(groups).map(([k, n]) => <div key={k}>{n}× {k}%</div>)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <h3>Resources</h3>
      <table>
        <tbody>
          {Object.entries(plan.rawUse).map(([r, q]) => (
            <tr key={r}><td>{nm(r)}</td><td className="r">{fmt(q, 1)} / {Number.isFinite(avail[r]) ? fmt(avail[r], 1) : '∞'}
              {Number.isFinite(avail[r]) && avail[r] - q > 0.05 && <div className="muted">{fmt(avail[r] - q, 1)} spare</div>}</td></tr>
          ))}
        </tbody>
      </table>
      {Object.keys(plan.byproducts).length > 0 && <>
        <h3>Byproducts</h3>
        {Object.entries(plan.byproducts).map(([r, q]) => <div key={r} className="row"><span className="grow">{nm(r)}</span>{fmt(q, 1)} {unit(r)}</div>)}
      </>}
      {layout && layout.info.map((w, i) => <div key={'i' + i} className="note">{w}</div>)}
      {layout && layout.warnings.map((w, i) => <div key={i} className="note warn">{w}</div>)}
      <p className="hint">Blueprint: scroll or pinch to zoom, drag the background to pan, drag machines and splitters to move them. Belts follow. Hover a belt to see its flow.</p>
    </section>
  )
}
