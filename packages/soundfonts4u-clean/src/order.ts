import { agnes } from 'ml-hclust'
import { cosineDistance } from './embed.js'
interface Orderable {
  embedding: number[]
  key: string
}
const distanceMatrix = (items: Orderable[]): number[][] =>
  items.map(a => items.map(b => (a === b ? 0 : Math.max(0, cosineDistance(a.embedding, b.embedding)))))
const orderBySimilarity = <T extends Orderable>(items: T[]): T[] => {
  const sorted = items.toSorted((a, b) => a.key.localeCompare(b.key))
  if (sorted.length < 3) return sorted
  const tree = agnes(distanceMatrix(sorted), { isDistanceMatrix: true, method: 'average' })
  const order = tree.indices()
  if (order.length !== sorted.length) throw new Error(`leaf order has ${order.length} of ${sorted.length} items`)
  return order.map(i => {
    const item = sorted[i]
    if (item === undefined) throw new Error(`leaf index ${i} out of range`)
    return item
  })
}
const centroid = (vectors: number[][]): number[] => {
  const [first] = vectors
  if (first === undefined) throw new Error('centroid of no vectors')
  const sum = first.map((_, d) => {
    let total = 0
    for (const v of vectors) total += v[d] ?? 0
    return total
  })
  const norm = Math.hypot(...sum)
  return sum.map(x => x / norm)
}
export type { Orderable }
export { centroid, orderBySimilarity }
