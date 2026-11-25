import { CryptoHasher, file } from 'bun'
import { join } from 'node:path'
interface TreeEntry {
  lfs?: { oid?: string; size?: number }
  path?: string
  type?: string
}
interface UpstreamFile {
  path: string
  sha256: string
  size: number
}
const UPSTREAM = {
  commit: 'b8a0526c20bd73e7d009f7e2d94ca6abbccd9a2d',
  commitDate: '2025-05-06T01:31:24.000Z',
  dataset: 'projectlosangeles/soundfonts4u',
  excluded: ['8Rock11e.sf2']
} as const
const FETCH_TIMEOUT_MS = 60_000
const isTreeEntry = (value: unknown): value is TreeEntry => typeof value === 'object' && value !== null
const fetchTree = async (url: string): Promise<unknown[]> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`upstream tree fetch failed: HTTP ${response.status} for ${url}`)
  const body: unknown = await response.json()
  if (!Array.isArray(body)) throw new TypeError(`upstream tree is not an array: ${url}`)
  const entries: unknown[] = body
  return entries
}
const lfsFileOf = (entry: TreeEntry): undefined | UpstreamFile => {
  const { lfs, path, type } = entry
  const sha256 = lfs?.oid
  const size = lfs?.size
  return type === 'file' && path !== undefined && sha256 !== undefined && size !== undefined
    ? { path, sha256, size }
    : undefined
}
const fetchUpstreamFiles = async (): Promise<UpstreamFile[]> => {
  const url = `https://huggingface.co/api/datasets/${UPSTREAM.dataset}/tree/${UPSTREAM.commit}?recursive=true`
  const entries = (await fetchTree(url)).filter(isTreeEntry)
  const files: UpstreamFile[] = []
  for (const entry of entries) {
    const found = lfsFileOf(entry)
    if (found !== undefined) files.push(found)
  }
  if (files.length === 0) throw new Error(`upstream tree lists no LFS files: ${url}`)
  return files
}
const sha256Of = async (path: string): Promise<string> => {
  const hasher = new CryptoHasher('sha256')
  for await (const chunk of file(path).stream()) hasher.update(chunk)
  return hasher.digest('hex')
}
const verifyInput = async (inputDir: string): Promise<UpstreamFile[]> => {
  const upstream = await fetchUpstreamFiles()
  const failures: string[] = []
  const checked = await Promise.all(
    upstream.map(async u => {
      const local = file(join(inputDir, u.path))
      if (!(await local.exists())) return `missing ${u.path}`
      if (local.size !== u.size) return `size ${u.path}: local ${local.size}, upstream ${u.size}`
      const digest = await sha256Of(join(inputDir, u.path))
      return digest === u.sha256 ? '' : `sha256 ${u.path}: local ${digest}, upstream ${u.sha256}`
    })
  )
  for (const message of checked) if (message.length > 0) failures.push(message)
  if (failures.length > 0) throw new Error(`input does not match upstream ${UPSTREAM.commit}:\n${failures.join('\n')}`)
  const excluded = new Set<string>(UPSTREAM.excluded)
  return upstream.filter(u => !excluded.has(u.path))
}
export type { UpstreamFile }
export { UPSTREAM, verifyInput }
