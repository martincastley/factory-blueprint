// Game data helpers. Recipe data: Satisfactory 1.0 via the open-source SatisfactoryTools project.
import raw from './data.json' with { type: 'json' }

export const ITEMS = raw.items
export const RECIPES = raw.recipes
export const BUILDINGS = raw.buildings
const RESOURCE_SET = new Set(raw.resources)

export const recipeById = {}
export const byOut = {}
export const byIn = {}
for (const r of RECIPES) {
  recipeById[r.id] = r
  r.out.forEach(([it]) => (byOut[it] = byOut[it] || []).push(r))
  r.in.forEach(([it]) => (byIn[it] = byIn[it] || []).push(r))
}

export const nm = (id) => (ITEMS[id] ? ITEMS[id].n : id)
export const isLiquid = (id) => !!(ITEMS[id] && ITEMS[id].l)
export const unit = (id) => (isLiquid(id) ? 'm³/min' : '/min')
export const isRaw = (id) => RESOURCE_SET.has(id) || !(byOut[id] || []).length
export const isResource = (id) => RESOURCE_SET.has(id)

// Building footprints in metres: [W = across the flow, L = along the flow (input side -> output side)]
// Sources: satisfactory-calculator.com structure pages / wiki. Marked approx where unverified.
export const SIZE = {
  Desc_SmelterMk1_C: [6, 9],
  Desc_ConstructorMk1_C: [8, 10],
  Desc_AssemblerMk1_C: [10, 15],
  Desc_FoundryMk1_C: [10, 9],
  Desc_ManufacturerMk1_C: [18, 20],
  Desc_OilRefinery_C: [10, 20],
  Desc_Blender_C: [18, 16],
  Desc_Packager_C: [8, 8],
  Desc_HadronCollider_C: [24, 38],
  Desc_Converter_C: [16, 16],
  Desc_QuantumEncoder_C: [22, 48],
}
export const APPROX_SIZE = new Set(['Desc_HadronCollider_C', 'Desc_Converter_C', 'Desc_QuantumEncoder_C'])
export const sizeOf = (b) => SIZE[b] || [10, 10]

export const BELTS = [
  { mk: 1, rate: 60 }, { mk: 2, rate: 120 }, { mk: 3, rate: 270 },
  { mk: 4, rate: 480 }, { mk: 5, rate: 780 }, { mk: 6, rate: 1200 },
]
export const PIPES = [{ mk: 1, rate: 300 }, { mk: 2, rate: 600 }]
export const MINER_BASE = { 1: 60, 2: 120, 3: 240 } // normal node, 100 %
export const OIL_BASE = 120 // oil extractor, normal node
export const PURITY = { impure: 0.5, normal: 1, pure: 2 }

export const WATER = 'Desc_Water_C'
export const OIL = 'Desc_LiquidOil_C'
// How a raw item is obtained
export function supplyKind(id) {
  if (id === WATER) return 'water'
  if (id === OIL) return 'oil'
  if (!isResource(id) || isLiquid(id)) return 'direct'
  return 'miner'
}

// Default ("standard") recipe for an item: non-alternate, item is the main product, no packaging/converter tricks
export function recipeOptions(id) {
  const score = (r) =>
    (r.out[0][0] === id ? 0 : 2) + (r.alt ? 1 : 0) +
    (/^(Packaged|Unpackage)/.test(r.n) || BUILDINGS[r.b].n === 'Converter' ? 4 : 0)
  return (byOut[id] || []).slice().sort((a, b) => score(a) - score(b))
}
export const standardRecipe = (id) => recipeOptions(id)[0]
export const altRecipes = (id) => (byOut[id] || []).filter((r) => r.alt && r.out[0][0] === id)

// Items a player can choose as a product
export const PRODUCIBLE = Object.keys(byOut)
  .filter((id) => !isResource(id))
  .sort((a, b) => nm(a).localeCompare(nm(b)))

export const fmt = (x, d = 2) =>
  Number.isFinite(x) ? (+x.toFixed(d)).toLocaleString('en', { maximumFractionDigits: d }) : '∞'
