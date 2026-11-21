import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { route, worldDims, snapNode, bbox, overlaps } from './layout.js'
import { nm, fmt, isLiquid } from './data.js'

const F = 8 // foundation size in metres

export default function Blueprint({ layout, title }) {
  const [nodes, setNodes] = useState(layout.nodes)
  const [hist, setHist] = useState([])
  const [sel, setSel] = useState(null)
  const [hover, setHover] = useState(null)
  const [view, setView] = useState({ x: 0, y: 0, s: 6 })
  const svgRef = useRef(null)
  const drag = useRef(null)

  useEffect(() => { setNodes(layout.nodes.map((n) => ({ ...n }))); setHist([]); setSel(null) }, [layout])

  const nodeMap = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes])
  const bb = useMemo(() => bbox(nodes, layout.edges, nodeMap), [nodes, layout.edges, nodeMap])
  const fb = useMemo(() => {
    const x0 = Math.floor((bb.x0 - 0.5) / F) * F, y0 = Math.floor((bb.y0 - 0.5) / F) * F
    const x1 = Math.ceil((bb.x1 + 0.5) / F) * F, y1 = Math.ceil((bb.y1 + 0.5) / F) * F
    return { x0, y0, x1, y1, w: (x1 - x0) / F, h: (y1 - y0) / F }
  }, [bb])
  const bad = useMemo(() => overlaps(nodes), [nodes])

  const fit = useCallback(() => {
    const el = svgRef.current; if (!el) return
    const all = bbox(nodes, layout.edges, nodeMap, true)
    const W = el.clientWidth, H = el.clientHeight
    const s = Math.min(W / (all.x1 - all.x0 + 16), H / (all.y1 - all.y0 + 16))
    setView({ s, x: W / 2 - ((all.x0 + all.x1) / 2) * s, y: H / 2 - ((all.y0 + all.y1) / 2) * s })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])
  useEffect(() => { const t = setTimeout(fit, 30); return () => clearTimeout(t) }, [fit])

  const toWorld = (cx, cy) => {
    const r = svgRef.current.getBoundingClientRect()
    return { x: (cx - r.left - view.x) / view.s, y: (cy - r.top - view.y) / view.s }
  }
  const zoomAt = (px, py, f) => setView((v) => {
    const s = Math.min(60, Math.max(0.5, v.s * f))
    const k = s / v.s
    return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
  })
  useEffect(() => {
    const el = svgRef.current
    const onWheel = (e) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const pointers = useRef(new Map())
  const onDown = (e, node) => {
    e.stopPropagation()
    svgRef.current.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) { drag.current = { pinch: true, d: pinchDist(), view }; return }
    if (node && node.kind !== 'source' && node.kind !== 'sink') {
      const w = toWorld(e.clientX, e.clientY)
      setSel(node.id)
      drag.current = { id: node.id, dx: w.x - node.cx, dy: w.y - node.cy, before: nodes, moved: false }
    } else {
      if (!node) setSel(null)
      drag.current = { pan: true, x: e.clientX, y: e.clientY, view }
    }
  }
  const pinchDist = () => { const [a, b] = [...pointers.current.values()]; return Math.hypot(a.x - b.x, a.y - b.y) }
  const onMove = (e) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const d = drag.current; if (!d) return
    if (d.pinch && pointers.current.size === 2) {
      const r = svgRef.current.getBoundingClientRect()
      const [a, b] = [...pointers.current.values()]
      const f = pinchDist() / d.d
      const s = Math.min(60, Math.max(0.5, d.view.s * f)), k = s / d.view.s
      const px = (a.x + b.x) / 2 - r.left, py = (a.y + b.y) / 2 - r.top
      setView({ s, x: px - (px - d.view.x) * k, y: py - (py - d.view.y) * k })
      return
    }
    if (d.pan) { setView({ ...d.view, x: d.view.x + e.clientX - d.x, y: d.view.y + e.clientY - d.y }); return }
    const w = toWorld(e.clientX, e.clientY)
    setNodes((ns) => ns.map((n) => {
      if (n.id !== d.id) return n
      const m = { ...n, cx: w.x - d.dx, cy: w.y - d.dy }
      snapNode(m)
      if (m.cx !== n.cx || m.cy !== n.cy) d.moved = true
      return m
    }))
  }
  const onUp = (e) => {
    pointers.current.delete(e.pointerId)
    const d = drag.current
    if (d && d.id && d.moved) setHist((h) => [...h.slice(-50), d.before])
    drag.current = null
  }
  const rotateSel = useCallback(() => {
    if (!sel) return
    setHist((h) => [...h.slice(-50), nodes])
    setNodes((ns) => ns.map((n) => { if (n.id !== sel) return n; const m = { ...n, rot: (n.rot + 1) % 4 }; snapNode(m); return m }))
  }, [sel, nodes])
  const undo = useCallback(() => {
    setHist((h) => { if (!h.length) return h; setNodes(h[h.length - 1]); return h.slice(0, -1) })
  }, [])
  useEffect(() => {
    const k = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.key === 'r' || e.key === 'R') rotateSel()
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo() }
    }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [rotateSel, undo])

  const showFine = view.s > 4
  const selNode = sel && nodeMap[sel]

  return (
    <div className="bp-wrap">
      <svg ref={svgRef} className="bp" onPointerDown={(e) => onDown(e, null)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <defs>
          <pattern id="g1" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" className="grid1" /></pattern>
          <pattern id="g8" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M8 0H0V8" fill="none" className="grid8" /></pattern>
          <marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" className="arrow" /></marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.s})`}>
          <rect x="-2000" y="-2000" width="4000" height="4000" fill="url(#g8)" />
          {showFine && <rect x="-2000" y="-2000" width="4000" height="4000" fill="url(#g1)" />}
          {/* foundation footprint */}
          <rect x={fb.x0} y={fb.y0} width={fb.x1 - fb.x0} height={fb.y1 - fb.y0} className="footprint" />
          <text x={fb.x0} y={fb.y1 + 4} className="dim">{fb.w} × {fb.h} FOUNDATIONS ({fb.w * F} m × {fb.h * F} m)</text>
          {layout.edges.map((e, i) => {
            const pts = route(e, nodeMap)
            const d = pts.map((p) => `${p.x},${p.y}`).join(' ')
            const liq = isLiquid(e.item)
            const hov = hover === i
            return (
              <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <polyline points={d} className={'belt-bed' + (liq ? ' pipe' : '') + (hov ? ' hov' : '')} />
                <polyline points={d} className={'belt-line' + (liq ? ' pipe' : '')} markerEnd="url(#arr)" />
              </g>
            )
          })}
          {nodes.map((n) => <NodeShape key={n.id} n={n} sel={sel === n.id} bad={bad.has(n.id)} onDown={onDown} fine={showFine} />)}
          {hover !== null && layout.edges[hover] && (() => {
            const e = layout.edges[hover]; const p = route(e, nodeMap)
            const mid = p[Math.floor(p.length / 2)]
            return <text x={mid.x + 1} y={mid.y - 1} className="tip">{nm(e.item)}{e.rate !== undefined ? ` · ${fmt(e.rate)}/min` : ''}</text>
          })()}
        </g>
      </svg>

      <div className="bp-tools">
        <button onClick={() => { const r = svgRef.current.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.3) }}>+</button>
        <button onClick={() => { const r = svgRef.current.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.3) }}>−</button>
        <button onClick={fit}>Fit</button>
        <button onClick={rotateSel} disabled={!sel}>Rotate (R)</button>
        <button onClick={undo} disabled={!hist.length}>Undo</button>
        <button onClick={() => { setHist((h) => [...h, nodes]); setNodes(layout.nodes.map((n) => ({ ...n }))) }}>Reset layout</button>
      </div>

      {selNode && selNode.kind === 'machine' && (
        <div className="bp-sel">
          <b>{selNode.building}</b> · {nm(selNode.item)}<br />
          Recipe: {selNode.recipe}<br />
          Clock: {fmt(selNode.clock * 100, 3)}%<br />
          <span className="muted">Drag to move · R to rotate</span>
        </div>
      )}

      <div className="titleblock">
        <div className="tb-row tb-title">{title}</div>
        <div className="tb-grid">
          <span>FOUNDATIONS</span><b>{fb.w} × {fb.h} = {fb.w * fb.h}</b>
          <span>SIZE</span><b>{fb.w * F} × {fb.h * F} m</b>
          <span>GRID</span><b>{showFine ? '1 m / 8 m' : '8 m'}</b>
          <span>CLASHES</span><b className={bad.size ? 'warn' : ''}>{bad.size ? bad.size + ' overlapping' : 'none'}</b>
        </div>
      </div>
    </div>
  )
}

function NodeShape({ n, sel, bad, onDown, fine }) {
  const [w, h] = worldDims(n)
  const cls = ['node', n.kind, sel && 'sel', bad && 'bad'].filter(Boolean).join(' ')
  const x = n.cx - w / 2, y = n.cy - h / 2
  if (n.kind === 'source' || n.kind === 'sink') {
    return (
      <g className={cls}>
        <rect x={x} y={y} width={w} height={h} rx="1" />
        <text x={n.cx} y={n.cy - 0.6} className="io-l">{n.label}</text>
        <text x={n.cx} y={n.cy + 1.6} className="io-t">{nm(n.item)} {fmt(n.rate, 1)}/min</text>
      </g>
    )
  }
  if (n.kind !== 'machine') {
    const glyph = n.kind === 'merger' ? 'M' : n.kind === 'junction' ? '+' : 'S'
    return (
      <g className={cls} onPointerDown={(e) => onDown(e, n)}>
        <rect x={x} y={y} width={w} height={h} />
        {n.kind === 'junction' ? <circle cx={n.cx} cy={n.cy} r="1.2" className="glyph-c" /> : <text x={n.cx} y={n.cy + 0.6} className="glyph">{glyph}</text>}
      </g>
    )
  }
  const rotLabel = n.rot % 2 ? `rotate(-90 ${n.cx} ${n.cy})` : undefined
  // text runs along the machine's length (lx); shrink to fit the building name
  const fs = Math.min(1.6, n.ly / 5.5, (n.lx * 0.82) / (n.building.length * 0.62))
  return (
    <g className={cls} onPointerDown={(e) => onDown(e, n)}>
      <rect x={x} y={y} width={w} height={h} />
      <rect x={x + 0.6} y={y + 0.6} width={w - 1.2} height={h - 1.2} className="inner" />
      <g transform={rotLabel}>
        <text x={n.cx} y={n.cy - fs * 0.6} className="m-name" style={{ fontSize: fs }}>{n.building.toUpperCase()}</text>
        <text x={n.cx} y={n.cy + fs * 0.7} className="m-item" style={{ fontSize: fs * 0.8 }}>{nm(n.item)}</text>
        {fine && <text x={n.cx} y={n.cy + fs * 1.8} className="m-clock" style={{ fontSize: fs * 0.7 }}>{fmt(n.clock * 100, 1)}%</text>}
      </g>
    </g>
  )
}
