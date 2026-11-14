// Tests for scripts/sw-plugin.ts (Requirements 8.3, 8.7, 8.8).
//
// This file sits outside src/, so it may name the forbidden words. The worker
// runs in a small stand-in for the service worker global scope; its `fetch`
// is a local recorder, so no request leaves the test.

import { describe, expect, it } from 'vitest'
import { SERVICE_WORKER_FILE as SCANNER_SKIP } from '../scripts/airgap-scan.mjs'
import {
  type BuildFile,
  CACHE_PREFIX,
  SERVICE_WORKER_FILE,
  precacheManifest,
  renderServiceWorker,
} from '../scripts/sw-plugin.ts'

const ORIGIN = 'https://vault.example'

const BUILD: BuildFile[] = [
  { fileName: 'index.html', source: '<!doctype html>' },
  { fileName: 'assets/index-abc.js', source: 'console.log(1)' },
  { fileName: 'assets/index-abc.css', source: 'body{}' },
  { fileName: 'assets/mic-worklet-xyz.js', source: 'registerProcessor()' },
  { fileName: 'favicon.svg', source: new Uint8Array([60, 115, 118, 103, 62]) },
  { fileName: '_headers', source: '/\n  X: y\n' },
  { fileName: 'sw.js', source: 'old worker' },
]

describe('precacheManifest', () => {
  it('lists every build file as a relative path, with index.html under ./', () => {
    const { urls } = precacheManifest(BUILD)
    expect(urls).toEqual(['assets/index-abc.css', 'assets/index-abc.js', 'assets/mic-worklet-xyz.js', 'favicon.svg', './'])
    for (const url of urls) expect(new URL(url, `${ORIGIN}/sw.js`).origin).toBe(ORIGIN)
  })

  it('excludes sw.js and _headers', () => {
    const { urls } = precacheManifest(BUILD)
    expect(urls).not.toContain('sw.js')
    expect(urls).not.toContain('_headers')
  })

  it('versions the cache name by file names and contents', () => {
    const a = precacheManifest(BUILD).cacheName
    expect(a).toMatch(new RegExp(`^${CACHE_PREFIX}[0-9a-f]{16}$`))
    expect(precacheManifest([...BUILD].reverse()).cacheName).toBe(a)
    const changed = BUILD.map((f) => (f.fileName === 'favicon.svg' ? { ...f, source: 'other' } : f))
    expect(precacheManifest(changed).cacheName).not.toBe(a)
  })

  it.each(['https://cdn.example/x.js', '//cdn.example/x.js', '/abs.js', '../up.js', 'a/./b.js', 'a\\b.js'])(
    'refuses the non-relative path %s',
    (fileName) => {
      expect(() => precacheManifest([...BUILD, { fileName, source: '' }])).toThrow(/non-relative/)
    },
  )

  it('requires index.html', () => {
    expect(() => precacheManifest(BUILD.filter((f) => f.fileName !== 'index.html'))).toThrow(/index\.html/)
  })

  it('emits the file name the --dist scan skips', () => {
    expect(SERVICE_WORKER_FILE).toBe(SCANNER_SKIP)
  })
})

type Listener = (event: unknown) => void

/** Loads the generated worker into a stand-in global scope at ORIGIN/sw.js. */
function loadWorker() {
  const manifest = precacheManifest(BUILD)
  const listeners = new Map<string, Listener>()
  const stores = new Map<string, Map<string, string>>([['baudvault-old', new Map()], ['other-app', new Map()]])
  const requested: string[] = []
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    clients: { claim: async () => undefined },
  }
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)!
      return {
        addAll: async (urls: string[]) => {
          for (const url of urls) {
            requested.push(url)
            store.set(url, `cached:${url}`)
          }
        },
        match: async (url: string) => store.get(url),
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  }
  const network = async (url: string) => {
    requested.push(url)
    return `net:${url}`
  }
  new Function('self', 'caches', 'fetch', renderServiceWorker(manifest))(self, caches, network)

  const lifecycle = async (type: 'install' | 'activate') => {
    let done: Promise<unknown> = Promise.resolve()
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (done = p) })
    await done
  }
  /** Dispatches a fetch event; resolves to the response, or undefined when the worker ignores it. */
  const request = async (url: string, init: { method?: string; mode?: string } = {}) => {
    let response: Promise<unknown> | undefined
    listeners.get('fetch')!({
      request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' },
      respondWith: (p: Promise<unknown>) => (response = p),
    })
    return response
  }
  return { manifest, stores, requested, lifecycle, request }
}

describe('generated worker', () => {
  it('precaches only same-origin URLs on install', async () => {
    const w = loadWorker()
    await w.lifecycle('install')
    expect(w.requested).toHaveLength(w.manifest.urls.length)
    for (const url of w.requested) expect(new URL(url).origin).toBe(ORIGIN)
    expect(w.requested).toContain(`${ORIGIN}/`)
    expect(w.requested).toContain(`${ORIGIN}/assets/mic-worklet-xyz.js`)
  })

  it('deletes older BaudVault caches on activate and keeps other caches', async () => {
    const w = loadWorker()
    await w.lifecycle('install')
    await w.lifecycle('activate')
    expect([...w.stores.keys()].sort()).toEqual([w.manifest.cacheName, 'other-app'].sort())
  })

  it('serves precached files, / and /index.html from the cache', async () => {
    const w = loadWorker()
    await w.lifecycle('install')
    w.requested.length = 0
    expect(await w.request(`${ORIGIN}/assets/index-abc.js`)).toBe(`cached:${ORIGIN}/assets/index-abc.js`)
    expect(await w.request(`${ORIGIN}/`, { mode: 'navigate' })).toBe(`cached:${ORIGIN}/`)
    expect(await w.request(`${ORIGIN}/index.html`, { mode: 'navigate' })).toBe(`cached:${ORIGIN}/`)
    expect(await w.request(`${ORIGIN}/?tab=receive`, { mode: 'navigate' })).toBe(`cached:${ORIGIN}/`)
    expect(w.requested).toEqual([])
  })

  it('falls back to the cached page for other same-origin navigations', async () => {
    const w = loadWorker()
    await w.lifecycle('install')
    expect(await w.request(`${ORIGIN}/somewhere`, { mode: 'navigate' })).toBe(`cached:${ORIGIN}/`)
  })

  it('ignores cross-origin, non-GET, and unlisted requests', async () => {
    const w = loadWorker()
    await w.lifecycle('install')
    w.requested.length = 0
    expect(await w.request('https://cdn.example/assets/index-abc.js')).toBeUndefined()
    expect(await w.request('https://cdn.example/', { mode: 'navigate' })).toBeUndefined()
    expect(await w.request(`${ORIGIN}/assets/index-abc.js`, { method: 'POST' })).toBeUndefined()
    expect(await w.request(`${ORIGIN}/assets/unknown.js`)).toBeUndefined()
    expect(await w.request(`${ORIGIN}/sw.js`)).toBeUndefined()
    expect(await w.request(`${ORIGIN}/_headers`)).toBeUndefined()
    expect(w.requested).toEqual([])
  })

  it('on a cache miss requests only the same precached URL', async () => {
    const w = loadWorker()
    expect(await w.request(`${ORIGIN}/favicon.svg`)).toBe(`net:${ORIGIN}/favicon.svg`)
    expect(w.requested).toEqual([`${ORIGIN}/favicon.svg`])
  })
})
