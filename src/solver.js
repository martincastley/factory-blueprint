// Production solver: turns products + recipes + available resources into machine counts.
import { recipeById, standardRecipe, isRaw, BUILDINGS } from './data.js'

const EPS = 1e-6
const POWER_EXP = 1.321929

export function recipeFor(id, choice) {
  if (isRaw(id)) return null
  return (choice[id] && recipeById[choice[id]]) || standardRecipe(id)
}

// Everything needed for ONE machine of the product's final recipe running at 100 %.
export function unitChain(pid, choice) {
  const r0 = recipeFor(pid, choice)
  const rate = r0.out.find((o) => o[0] === pid)[1]
  const order = [], state = {}, cyc = new Set()
  const visit = (id) => {
    if (state[id] === 2) return
    if (state[id] === 1) { cyc.add(id); return }
    state[id] = 1
    const r = recipeFor(id, choice)
    if (r) r.in.forEach(([x]) => visit(x))
    state[id] = 2
    order.push(id)
  }
  visit(pid)
  order.reverse()
  const need = { [pid]: rate }, steps = {}, raw = {}, cons = {}, by = {}
  for (const id of order) {
    const q = need[id] || 0
    if (q < EPS) continue
    const r = recipeFor(id, choice)
    if (!r || (cyc.has(id) && id !== pid && steps[id])) { raw[id] = (raw[id] || 0) + q; continue }
    const per = r.out.find((o) => o[0] === id)[1]
    const m = q / per
    steps[id] = (steps[id] || 0) + m
    r.in.forEach(([x, a]) => {
      need[x] = (need[x] || 0) + a * m
      cons[x] = (cons[x] || 0) + a * m
    })
    r.out.forEach(([x, a]) => { if (x !== id) by[x] = (by[x] || 0) + a * m })
  }
  return { pid, rate, steps, raw, cons, by }
}

// Which items do the products' chains share? Returns {kind: 'linked'|'raw'|'none', item}
export function sharedInput(chains) {
  if (chains.length < 2) return { kind: 'none' }
  const count = {}, total = {}
  chains.forEach((c) => Object.entries(c.cons).forEach(([x, q]) => {
    count[x] = (count[x] || 0) + 1
    total[x] = (total[x] || 0) + q
  }))
  const shared = Object.keys(count).filter((x) => count[x] >= 2)
  const inter = shared.filter((x) => !isRaw(x)).sort((a, b) => total[b] - total[a])
  if (inter.length) return { kind: 'linked', item: inter[0] }
  const raws = shared.sort((a, b) => total[b] - total[a])
  if (raws.length) return { kind: 'raw', item: raws[0] }
  return { kind: 'none' }
}

// ---------- allocation (how many final machines of each product) ----------

function resList(chains) {
  const s = new Set()
  chains.forEach((c) => Object.keys(c.raw).forEach((r) => s.add(r)))
  return [...s]
}

// Continuous allocation following the priority rule.
function allocate(chains, avail, caps, prio, shared) {
  const res = resList(chains)
  const rem = {}; res.forEach((r) => (rem[r] = avail[r] ?? 0))
  const x = chains.map(() => 0)
  const take = (i, v) => { x[i] = v; res.forEach((r) => (rem[r] -= v * (chains[i].raw[r] || 0))) }
  const maxFor = (i) => {
    let v = caps[i]
    res.forEach((r) => { const u = chains[i].raw[r] || 0; if (u > EPS) v = Math.min(v, Math.max(0, rem[r]) / u) })
    return v
  }
  const greedy = (idxs) => idxs.forEach((i) => take(i, maxFor(i)))

  if (prio.type === 'order') { greedy(prio.order); return x }

  // share mode: split the shared item according to weights (water-filling)
  const u = chains.map((c) => c.cons[shared] || c.raw[shared] || 0)
  let F = chains.map((_, i) => i).filter((i) => u[i] > EPS && prio.weights[i] > EPS)
  const others = chains.map((_, i) => i).filter((i) => !F.includes(i))
  let guard = 0
  while (F.length && guard++ < 20) {
    const wsum = F.reduce((s, i) => s + prio.weights[i], 0)
    const w = (i) => prio.weights[i] / wsum
    let T = Infinity, capHit = -1
    res.forEach((r) => {
      const d = F.reduce((s, i) => s + (w(i) / u[i]) * (chains[i].raw[r] || 0), 0)
      if (d > EPS) T = Math.min(T, Math.max(0, rem[r]) / d)
    })
    F.forEach((i) => { const t = (caps[i] * u[i]) / w(i); if (t < T - EPS) { T = t; capHit = i } })
    if (capHit >= 0) { take(capHit, caps[capHit]); F = F.filter((i) => i !== capHit); continue }
    F.forEach((i) => take(i, (w(i) * T) / u[i]))
    F = []
  }
  greedy(others)
  return x
}

// 100 % efficiency: integer machine counts at every step, nothing underclocked.
function allocatePerfect(chains, avail, caps, prio, shared, upper) {
  const res = resList(chains)
  const stepIds = [...new Set(chains.flatMap((c) => Object.keys(c.steps)))]
  const N = upper.map((v) => Math.max(0, Math.floor(Math.min(v, 500) + EPS)))
  let total = N.reduce((p, n) => p * (n + 1), 1)
  const lim = N.map((n) => n)
  // keep search size reasonable
  while (total > 400000) {
    const k = lim.indexOf(Math.max(...lim)); lim[k] = Math.floor(lim[k] * 0.8)
    total = lim.reduce((p, n) => p * (n + 1), 1)
  }
  const u = chains.map((c) => c.cons[shared] || c.raw[shared] || 0)
  let best = null, bestScore = -Infinity
  const n = chains.map(() => 0)
  const score = () => {
    if (prio.type === 'order') {
      let s = 0; prio.order.forEach((i, rank) => (s += n[i] * Math.pow(1000, chains.length - rank))); return s
    }
    const T = n.reduce((s, v, i) => s + v * u[i], 0)
    if (T < EPS) return n.reduce((s, v, i) => s + v / Math.max(1, N[i]), 0) * 1e-3
    const wsum = prio.weights.reduce((a, b) => a + b, 0) || 1
    let dev = 0
    n.forEach((v, i) => { if (u[i] > EPS) dev = Math.max(dev, Math.abs((v * u[i]) / T - prio.weights[i] / wsum)) })
    return T * (1 - 2 * dev)
  }
  const check = () => {
    if (n.every((v) => v === 0)) return
    for (const r of res) {
      const use = n.reduce((s, v, i) => s + v * (chains[i].raw[r] || 0), 0)
      if (use > (avail[r] ?? 0) + EPS) return
    }
    for (const s of stepIds) {
      const m = n.reduce((acc, v, i) => acc + v * (chains[i].steps[s] || 0), 0)
      if (Math.abs(m - Math.round(m)) > 1e-4) return
    }
    const sc = score()
    if (sc > bestScore + EPS) { bestScore = sc; best = n.slice() }
  }
  const rec = (k) => {
    if (k === chains.length) return check()
    for (let v = 0; v <= lim[k]; v++) { n[k] = v; rec(k + 1) }
  }
  rec(0)
  return best
}

// ---------- main entry ----------
// products: [{id, target}] ; choice: {item: recipeId} ; avail: {raw: rate} ; mode ; prio
export function solve({ products, choice, avail, mode, prio }) {
  const notes = []
  const chains = products.map((p) => unitChain(p.id, choice))
  const caps = products.map((p, i) => (p.target > 0 ? p.target / chains[i].rate : Infinity))
  const shared = sharedInput(chains)
  let pr = prio
  if (!pr || chains.length < 2) pr = { type: 'order', order: chains.map((_, i) => i) }
  if (pr.type === 'share' && !shared.item) pr = { type: 'order', order: chains.map((_, i) => i) }

  let x = allocate(chains, avail, caps, pr, shared.item)
  if (x.some((v) => !Number.isFinite(v))) {
    notes.push('Unlimited output – set a target rate or limit a resource.')
    x = x.map((v) => (Number.isFinite(v) ? v : 0))
  }
  let usedMode = mode
  if (mode === 'perfect') {
    // upper bound per product: what it could do alone
    const upper = chains.map((_, i) => {
      const o = chains.map((__, j) => (j === i ? 0 : 1))
      return allocate(chains, avail, caps, { type: 'order', order: [i, ...o.map((_, j) => j).filter((j) => j !== i)] }, null)[i]
    })
    const best = allocatePerfect(chains, avail, caps, pr, shared.item, upper)
    if (best) x = best
    else {
      usedMode = 'max'
      notes.push('No layout with every machine at exactly 100 % fits your resources. Showing max output instead (one machine per step underclocked).')
    }
  }

  // aggregate steps
  const agg = {}
  chains.forEach((c, i) => Object.entries(c.steps).forEach(([id, m]) => (agg[id] = (agg[id] || 0) + m * x[i])))
  const steps = []
  let power = 0, shards = 0, machines = 0
  for (const [id, m] of Object.entries(agg)) {
    if (m < EPS) continue
    const r = recipeFor(id, choice)
    let clocks
    if (usedMode === 'perfect') clocks = Array(Math.round(m)).fill(1)
    else if (usedMode === 'max') {
      const f = Math.floor(m + EPS), rem = m - f
      clocks = Array(f).fill(1); if (rem > 1e-4) clocks.push(rem)
    } else if (usedMode === 'lowpower') {
      const n = Math.ceil(m - EPS); clocks = Array(n).fill(m / n)
    } else { // fewest
      const n = Math.ceil(m / 2.5 - EPS); clocks = Array(n).fill(m / n)
    }
    const base = r.vp ? r.mp : BUILDINGS[r.b].p
    const pw = clocks.reduce((s, c) => s + base * Math.pow(c, POWER_EXP), 0)
    const sh = clocks.reduce((s, c) => s + (c > 1 + EPS ? Math.ceil((c - 1 - EPS) / 0.5) : 0), 0)
    power += pw; shards += sh; machines += clocks.length
    steps.push({ item: id, recipe: r, m, clocks, power: pw, shards: sh })
  }
  const rawUse = {}, byproducts = {}
  chains.forEach((c, i) => {
    Object.entries(c.raw).forEach(([r, q]) => (rawUse[r] = (rawUse[r] || 0) + q * x[i]))
    Object.entries(c.by).forEach(([r, q]) => (byproducts[r] = (byproducts[r] || 0) + q * x[i]))
  })
  const out = products.map((p, i) => ({ id: p.id, rate: x[i] * chains[i].rate, machines: x[i] }))
  return { steps, rawUse, byproducts, out, power, shards, machines, notes, mode: usedMode, shared, chains }
}
