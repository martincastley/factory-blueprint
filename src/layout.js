// Manifold layout generator. All units are metres; 1 foundation = 8 m.
// Nodes: {id, kind, cx, cy, lx, ly, rot, ports:[{id, x, y, nx, ny, dir}], ...}
// Port x/y are relative to the node centre in the unrotated frame; flow runs along +x.
import { sizeOf, nm, isLiquid, BUILDINGS } from './data.js'

const SPL = 4 // splitter / merger size
const GAP = 2 // belt gap between lane and machine
const COL_GAP = 8

const ceil4 = (v) => Math.ceil(v / 4 - 1e-9) * 4

function machineNode(id, step, idx, x, y) {
  const [W, L] = sizeOf(step.recipe.b)
  const ins = step.recipe.in, outs = step.recipe.out
  const ports = []
  ins.forEach(([it], k) => ports.push({ id: 'in' + k, item: it, dir: 'in', x: -L / 2, y: -W / 2 + (W * (k + 1)) / (ins.length + 1), nx: -1, ny: 0 }))
  outs.forEach(([it], k) => ports.push({ id: 'out' + k, item: it, dir: 'out', x: L / 2, y: -W / 2 + (W * (k + 1)) / (outs.length + 1), nx: 1, ny: 0 }))
  return {
    id, kind: 'machine', cx: x + L / 2, cy: y + W / 2, lx: L, ly: W, rot: 0, ports,
    item: step.item, building: BUILDINGS[step.recipe.b].n, recipe: step.recipe.n, clock: step.clocks[idx],
  }
}

function splitter(id, cx, cy, item) {
  return {
    id, kind: isLiquid(item) ? 'junction' : 'splitter', cx, cy, lx: SPL, ly: SPL, rot: 0, item,
    ports: [
      { id: 'in', dir: 'in', x: 0, y: -2, nx: 0, ny: -1 },
      { id: 'out', dir: 'out', x: 0, y: 2, nx: 0, ny: 1 },
      { id: 'side', dir: 'out', x: 2, y: 0, nx: 1, ny: 0 },
      { id: 'w', dir: 'out', x: -2, y: 0, nx: -1, ny: 0 },
    ],
  }
}
function merger(id, cx, cy, item) {
  return {
    id, kind: isLiquid(item) ? 'junction' : 'merger', cx, cy, lx: SPL, ly: SPL, rot: 0, item,
    ports: [
      { id: 'side', dir: 'in', x: -2, y: 0, nx: -1, ny: 0 },
      { id: 'in', dir: 'in', x: 0, y: 2, nx: 0, ny: 1 },
      { id: 'e', dir: 'in', x: 2, y: 0, nx: 1, ny: 0 },
      { id: 'out', dir: 'out', x: 0, y: -2, nx: 0, ny: -1 },
    ],
  }
}

const EPS = 1e-6

// Split a column's machines into parallel manifold lines ("banks") so that
// no input or output line carries more than the belt/pipe can handle.
function packBanks(col, capOf) {
  const banks = []
  let cur = [], acc = {}
  const add = (k, f) => (acc[k] = (acc[k] || 0) + f)
  for (const s of col) {
    s.clocks.forEach((c, j) => {
      const flows = [
        ...s.recipe.in.map(([it, a]) => ['i' + it, it, a * c]),
        ...s.recipe.out.map(([it, a]) => ['o' + it, it, a * c]),
      ]
      const fits = flows.every(([k, it, f]) => (acc[k] || 0) + f <= capOf(it) + EPS)
      if (!fits && cur.length) { banks.push(cur); cur = []; acc = {} }
      cur.push({ step: s, j, c })
      flows.forEach(([k, , f]) => add(k, f))
    })
  }
  if (cur.length) banks.push(cur)
  if (banks.length < 2) return banks
  // try to even out the lines (e.g. 4 + 4 instead of 6 + 2) while staying within limits
  const all = banks.flat(), k = banks.length
  const even = []
  let start = 0
  for (let b = 0; b < k; b++) {
    const size = Math.floor(all.length / k) + (b < all.length % k ? 1 : 0)
    even.push(all.slice(start, start + size)); start += size
  }
  const ok = even.every((bank) => {
    const a = {}
    return bank.every(({ step: s, c }) =>
      [...s.recipe.in.map(([it, q]) => ['i' + it, it, q * c]), ...s.recipe.out.map(([it, q]) => ['o' + it, it, q * c])]
        .every(([key, it, f]) => (a[key] = (a[key] || 0) + f) <= capOf(it) + EPS))
  })
  return ok ? even : banks
}

export function buildLayout(plan, beltCap, pipeCap) {
  const capOf = (it) => (isLiquid(it) ? pipeCap : beltCap)
  const steps = plan.steps
  const byItem = Object.fromEntries(steps.map((s) => [s.item, s]))
  const finals = new Set(plan.out.filter((o) => o.rate > EPS).map((o) => o.id))
  // depth: 0 = final products, increases toward raw materials
  const depth = {}
  const getDepth = (id, seen = new Set()) => {
    if (depth[id] !== undefined) return depth[id]
    if (seen.has(id)) return 0
    seen.add(id)
    let d = 0
    steps.forEach((s) => { if (s.recipe.in.some(([x]) => x === id) && s.item !== id) d = Math.max(d, getDepth(s.item, seen) + 1) })
    depth[id] = d
    return d
  }
  steps.forEach((s) => getDepth(s.item))
  const maxD = Math.max(0, ...Object.values(depth))
  const cols = []
  for (let d = maxD; d >= 0; d--) cols.push(steps.filter((s) => depth[s.item] === d))

  const nodes = [], edges = [], lanes = [], info = []
  const entries = {} // item -> [{node, port, flow}] first splitter of each input line
  const exits = {} // item -> [{node, port, flow, main}] last merger of each output line
  let x = 0, nid = 0
  const id = (p) => p + nid++

  for (const col of cols) {
    if (!col.length) continue
    const banks = packBanks(col, capOf)
    if (banks.length > 1) {
      info.push(`${col.map((s) => nm(s.item)).join(' / ')}: split into ${banks.length} parallel manifold lines so no belt exceeds its limit.`)
    }
    for (const bank of banks) x = layoutBank(bank, x)
  }

  function layoutBank(bank, x) {
    const groups = []
    bank.forEach((m) => {
      let g = groups.find((g) => g.step === m.step)
      if (!g) groups.push((g = { step: m.step, ms: [] }))
      g.ms.push(m)
    })
    const inItems = [], outItems = []
    groups.forEach(({ step: s }) => {
      s.recipe.in.forEach(([it]) => !inItems.includes(it) && inItems.push(it))
      s.recipe.out.forEach(([it]) => !outItems.includes(it) && outItems.push(it))
    })
    const mx = x + inItems.length * SPL + GAP
    const maxL = Math.max(...groups.map((g) => sizeOf(g.step.recipe.b)[1]))
    const outBase = mx + maxL + GAP
    const inLanes = inItems.map((it) => ({ item: it, nodes: [], flow: 0 }))
    const outLanes = outItems.map((it) => ({ item: it, nodes: [], flow: 0 }))
    let y = 0
    for (const { step: s, ms } of groups) {
      const [W] = sizeOf(s.recipe.b)
      const pitch = ceil4(W)
      ms.forEach(({ j, c }) => {
        const m = machineNode(id('m'), s, j, mx, y + (pitch - W) / 2)
        nodes.push(m)
        m.ports.forEach((p) => {
          const wy = m.cy + p.y
          if (p.dir === 'in') {
            const li = inItems.indexOf(p.item)
            const sp = splitter(id('s'), x + 2 + SPL * li, wy, p.item)
            nodes.push(sp); inLanes[li].nodes.push(sp)
            const rate = s.recipe.in.find(([it]) => it === p.item)[1] * c
            inLanes[li].flow += rate
            edges.push({ from: [sp.id, 'side'], to: [m.id, p.id], item: p.item, rate })
          } else {
            const lo = outItems.indexOf(p.item)
            const mg = merger(id('g'), outBase + 2 + SPL * lo, wy, p.item)
            nodes.push(mg); outLanes[lo].nodes.push(mg)
            const rate = s.recipe.out.find(([it]) => it === p.item)[1] * c
            outLanes[lo].flow += rate
            edges.push({ from: [m.id, p.id], to: [mg.id, 'side'], item: p.item, rate })
          }
        })
        y += pitch
      })
      y += 4
    }
    for (const L of inLanes) {
      L.nodes.sort((a, b) => a.cy - b.cy)
      let acc = L.flow
      for (let k = 0; k + 1 < L.nodes.length; k++) {
        const e = edges.find((e) => e.from[0] === L.nodes[k].id && e.from[1] === 'side')
        acc -= e ? e.rate : 0
        edges.push({ from: [L.nodes[k].id, 'out'], to: [L.nodes[k + 1].id, 'in'], item: L.item, rate: acc, lane: true })
      }
      ;(entries[L.item] = entries[L.item] || []).push({ node: L.nodes[0], port: 'in', flow: L.flow })
      lanes.push({ ...L, dir: 'in', cap: capOf(L.item) })
    }
    for (const L of outLanes) {
      L.nodes.sort((a, b) => b.cy - a.cy)
      let acc = 0
      for (let k = 0; k + 1 < L.nodes.length; k++) {
        const e = edges.find((e) => e.to[0] === L.nodes[k].id && e.to[1] === 'side')
        acc += e ? e.rate : 0
        edges.push({ from: [L.nodes[k].id, 'out'], to: [L.nodes[k + 1].id, 'in'], item: L.item, rate: acc, lane: true })
      }
      const main = !!byItem[L.item] && groups.some((g) => g.step.item === L.item)
      ;(exits[L.item] = exits[L.item] || []).push({ node: L.nodes[L.nodes.length - 1], port: 'out', main, flow: L.flow })
      lanes.push({ ...L, dir: 'out', cap: capOf(L.item) })
    }
    return ceil4(outBase + SPL * outItems.length + COL_GAP)
  }

  // ---------- connections ----------
  const headerNodes = []
  const ioNode = (kind, item, rate, label, nearX) => {
    const n = {
      id: id(kind), kind, cx: nearX, cy: 0, lx: 14, ly: 6, rot: 0, item, rate, label,
      ports: [kind === 'source'
        ? { id: 'out', dir: 'out', x: 0, y: 3, nx: 0, ny: 1 }
        : { id: 'in', dir: 'in', x: 0, y: 3, nx: 0, ny: 1 }],
    }
    headerNodes.push(n); nodes.push(n)
    return n
  }
  const pY = (pt) => portWorld(pt.node, pt.port).y
  const trackEdge = (from, to, item, rate) => edges.push({ from: [from.node.id, from.port], to: [to.node.id, to.port], item, rate, track: true, feed: true })

  // One splitter (or a stack of them) above a line exit: returns n output points
  function splitTree(src, qs, item) {
    if (qs.length <= 1) return [src]
    const h = splitter(id('h'), src.node.cx, pY(src) - 3.5, item)
    h.rot = 2; h.hub = true; nodes.push(h)
    edges.push({ from: [src.node.id, src.port], to: [h.id, 'in'], item, rate: qs.reduce((a, b) => a + b, 0), feed: true })
    // after rotating 180°: 'w' = east, 'side' = west, 'out' = north
    const pts = [{ node: h, port: 'w' }, { node: h, port: 'side' }]
    if (qs.length === 3) pts.push({ node: h, port: 'out' })
    if (qs.length > 3) pts.push(...splitTree({ node: h, port: 'out' }, qs.slice(2), item))
    return pts
  }
  // One merger (or a stack) above a line entry: returns one input point per flow
  function mergeTree(dst, qs, item) {
    if (qs.length <= 1) return [dst]
    const h = merger(id('j'), dst.node.cx, pY(dst) - 3.5, item)
    h.rot = 2; h.hub = true; nodes.push(h)
    edges.push({ from: [h.id, 'out'], to: [dst.node.id, dst.port], item, rate: qs.reduce((a, b) => a + b, 0), feed: true })
    // after rotating 180°: 'side' = east, 'e' = west, 'in' = north, 'out' = south
    const pts = [{ node: h, port: 'side' }, { node: h, port: 'e' }]
    if (qs.length === 3) pts.push({ node: h, port: 'in' })
    if (qs.length > 3) pts.push(...mergeTree({ node: h, port: 'in' }, qs.slice(2), item))
    return pts
  }

  // Match producing lines to consuming lines without overloading any belt.
  function match(item, srcs, tgts) {
    srcs.sort((a, b) => a.node.cx - b.node.cx)
    tgts.sort((a, b) => (a.sink ? 1e9 : a.node.cx) - (b.sink ? 1e9 : b.node.cx))
    const s = srcs.map((v) => v.flow), t = tgts.map((v) => v.flow)
    const conns = []
    let i = 0, j = 0
    while (i < srcs.length && j < tgts.length) {
      const q = Math.min(s[i], t[j])
      if (q > 1e-4) conns.push({ i, j, q })
      s[i] -= q; t[j] -= q
      const doneI = s[i] <= 1e-4, doneJ = t[j] <= 1e-4
      if (doneI) i++
      if (doneJ) j++
      if (!doneI && !doneJ) break
    }
    // leftover supply (rounding / surplus) -> treat as extra output
    srcs.forEach((src, k) => { if (s[k] > 0.05) { tgts.push({ sink: true, flow: s[k], label: 'SURPLUS' }); conns.push({ i: k, j: tgts.length - 1, q: s[k] }) } })
    const outs = srcs.map((src, k) => {
      const mine = conns.filter((c) => c.i === k)
      return splitTree(src, mine.map((c) => c.q), item)
    })
    const ins = tgts.map((tg, k) => {
      if (tg.sink) return null
      const mine = conns.filter((c) => c.j === k)
      return mergeTree(tg, mine.map((c) => c.q), item)
    })
    const oi = srcs.map(() => 0), ii = tgts.map(() => 0)
    conns.forEach((c) => {
      const from = outs[c.i][oi[c.i]++]
      let to
      if (tgts[c.j].sink) to = { node: ioNode('sink', item, c.q, tgts[c.j].label || 'OUT', from.node.cx + 8), port: 'in' }
      else to = ins[c.j][ii[c.j]++]
      trackEdge(from, to, item, c.q)
    })
  }

  // raw inputs: one feed belt per input line
  for (const [item, rate] of Object.entries(plan.rawUse)) {
    if (rate < EPS) continue
    for (const e of entries[item] || []) {
      const src = ioNode('source', item, e.flow, 'IN', e.node.cx)
      trackEdge({ node: src, port: 'out' }, e, item, e.flow)
    }
  }
  for (const [item, exs] of Object.entries(exits)) {
    const mains = exs.filter((e) => e.main)
    const others = exs.filter((e) => !e.main)
    others.forEach((e) => trackEdge(e, { node: ioNode('sink', item, e.flow, 'BYPRODUCT', e.node.cx + 8), port: 'in' }, item, e.flow))
    if (!mains.length) continue
    const tgts = (entries[item] || []).map((e) => ({ ...e }))
    if (finals.has(item)) tgts.push({ sink: true, flow: plan.out.find((o) => o.id === item).rate, label: 'OUT' })
    match(item, mains.map((e) => ({ ...e })), tgts)
  }

  // tracks above everything (hubs included), then the header row above the tracks
  nodes.forEach(snapNode)
  const hubTop = Math.min(0, ...nodes.filter((n) => n.kind !== 'source' && n.kind !== 'sink').map((n) => n.cy - worldDims(n)[1] / 2))
  const trackEdges = edges.filter((e) => e.track)
  trackEdges.forEach((e, k) => (e.ty = hubTop - 4 - 3 * k))
  const top = hubTop - 4 - 3 * trackEdges.length - 6
  headerNodes.sort((a, b) => a.cx - b.cx)
  let last = -Infinity
  headerNodes.forEach((n) => { n.cx = Math.max(n.cx, last + 16); last = n.cx; n.cy = top })
  nodes.forEach(snapNode)

  return { nodes, edges, lanes, info, warnings: laneWarnings(lanes) }
}

function laneWarnings(lanes) {
  return lanes.filter((l) => l.flow > l.cap + 1e-6).map((l) =>
    `A single machine needs ${Math.round(l.flow)}/min of ${nm(l.item)}, more than your ${isLiquid(l.item) ? 'pipe' : 'belt'} carries (${l.cap}/min). Pick a faster tier or lower the clock speed.`)
}

// ---------- geometry helpers ----------
export function worldDims(n) { return n.rot % 2 ? [n.ly, n.lx] : [n.lx, n.ly] }
export function snapNode(n) {
  const [w, h] = worldDims(n)
  n.cx = Math.round(n.cx - w / 2) + w / 2
  n.cy = Math.round(n.cy - h / 2) + h / 2
}
function rotate(x, y, rot) {
  for (let i = 0; i < rot; i++) [x, y] = [-y, x]
  return [x, y]
}
export function portWorld(n, pid) {
  const p = n.ports.find((p) => p.id === pid)
  const [x, y] = rotate(p.x, p.y, n.rot)
  const [nx, ny] = rotate(p.nx, p.ny, n.rot)
  return { x: n.cx + x, y: n.cy + y, nx, ny }
}
export function route(e, nodeMap) {
  const a = portWorld(nodeMap[e.from[0]], e.from[1])
  const b = portWorld(nodeMap[e.to[0]], e.to[1])
  const s = 1.5
  const p1 = { x: a.x + a.nx * s, y: a.y + a.ny * s }
  const q1 = { x: b.x + b.nx * s, y: b.y + b.ny * s }
  let pts
  if (e.ty !== undefined) {
    pts = [a, p1, { x: p1.x, y: e.ty }, { x: q1.x, y: e.ty }, q1, b]
  } else if (Math.abs(a.y - b.y) < 0.01 && a.ny === 0 && b.ny === 0) {
    pts = [a, b]
  } else if (Math.abs(a.x - b.x) < 0.01 && a.nx === 0 && b.nx === 0) {
    pts = [a, b]
  } else if (a.nx !== 0) {
    const mx = (p1.x + q1.x) / 2
    pts = [a, p1, { x: mx, y: p1.y }, { x: mx, y: q1.y }, q1, b]
  } else {
    const my = (p1.y + q1.y) / 2
    pts = [a, p1, { x: p1.x, y: my }, { x: q1.x, y: my }, q1, b]
  }
  // drop duplicate/collinear points
  const out = []
  for (const p of pts) {
    const l = out[out.length - 1]
    if (l && Math.abs(l.x - p.x) < 1e-6 && Math.abs(l.y - p.y) < 1e-6) continue
    out.push(p)
  }
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true
    const a = out[i - 1], c = out[i + 1]
    return !((Math.abs(a.x - p.x) < 1e-6 && Math.abs(p.x - c.x) < 1e-6) || (Math.abs(a.y - p.y) < 1e-6 && Math.abs(p.y - c.y) < 1e-6))
  })
}

export function bbox(nodes, edges, nodeMap, includeIO = false) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  nodes.forEach((n) => {
    if (!includeIO && (n.kind === 'source' || n.kind === 'sink')) return
    const [w, h] = worldDims(n)
    add(n.cx - w / 2, n.cy - h / 2); add(n.cx + w / 2, n.cy + h / 2)
  })
  edges.forEach((e) => {
    const io = [e.from[0], e.to[0]].some((i) => ['source', 'sink'].includes(nodeMap[i].kind))
    if (io && !includeIO) {
      // count only the part of an IO belt that lies inside the factory (the track segment and below)
      const pts = route(e, nodeMap)
      const fromIO = ['source', 'sink'].includes(nodeMap[e.from[0]].kind)
      const keep = fromIO ? pts.slice(2) : pts.slice(0, -2)
      keep.forEach((p) => add(p.x, p.y))
      return
    }
    route(e, nodeMap).forEach((p) => add(p.x, p.y))
  })
  return { x0, y0, x1, y1 }
}

export function overlaps(nodes) {
  const bad = new Set()
  const solid = nodes.filter((n) => n.kind !== 'source' && n.kind !== 'sink')
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j]
    const [aw, ah] = worldDims(a), [bw, bh] = worldDims(b)
    if (Math.abs(a.cx - b.cx) < (aw + bw) / 2 - 0.01 && Math.abs(a.cy - b.cy) < (ah + bh) / 2 - 0.01) { bad.add(a.id); bad.add(b.id) }
  }
  return bad
}
