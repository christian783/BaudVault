// Tests for scripts/airgap-scan.mjs (Requirements 8.1, 8.7).
//
// This file sits outside src/, so it may name the forbidden words.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SERVICE_WORKER_FILE, isServiceWorkerFile, main, scanDist, scanSource } from '../scripts/airgap-scan.mjs'
import { FORBIDDEN_WORDS } from '../scripts/airgap-words.mjs'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/airgap-scan.mjs')

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'airgap-scan-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes `text` to `relative` under the temp root, creating parent folders. */
function put(relative: string, text: string): void {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Runs main() with cwd at the temp root and captures both output streams. */
function run(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = main(argv, { cwd: root, out: (s: string) => out.push(s), err: (s: string) => err.push(s) })
  return { code, out, err }
}

describe('source mode', () => {
  it('exits 0 for a clean directory', () => {
    put('src/clean.ts', 'export const loadSamples = () => new Float32Array(8)\n')
    const { code, out } = run(['src'])
    expect(code).toBe(0)
    expect(out).toContain('airgap: source scan clean')
  })

  it.each(FORBIDDEN_WORDS)('catches %s as a bare word', (word) => {
    put('src/a.ts', `const x = 1\nconst y = ${word}\n`)
    const { code, out } = run(['src'])
    expect(code).toBe(1)
    expect(out).toContain(`src/a.ts:2: ${word}`)
  })

  it('catches a word inside a comment', () => {
    put('src/a.ts', '// do not call fetch here\nexport {}\n')
    expect(run(['src']).out).toContain('src/a.ts:1: fetch')
  })

  it('catches a word inside a string', () => {
    put('src/a.ts', "export {}\n\nconst label = 'WebSocket'\n")
    expect(run(['src']).out).toContain('src/a.ts:3: WebSocket')
  })

  it('catches a word inside a longer identifier', () => {
    put('src/a.ts', 'export function fetchSamples() {}\n')
    expect(run(['src']).out).toContain('src/a.ts:1: fetch')
  })

  it('reports one line per matching word, with correct line numbers', () => {
    put('src/a.ts', 'ok\nnew XMLHttpRequest(); navigator.sendBeacon()\nok\nnew EventSource()\n')
    const { code, out } = run(['src'])
    expect(code).toBe(1)
    expect(out).toEqual(
      expect.arrayContaining([
        'src/a.ts:2: XMLHttpRequest',
        'src/a.ts:2: sendBeacon',
        'src/a.ts:4: EventSource',
      ]),
    )
  })

  it('scans nested subdirectories', () => {
    put('src/deep/er/nested.ts', 'new RTCPeerConnection()\n')
    expect(run(['src']).out).toContain('src/deep/er/nested.ts:1: RTCPeerConnection')
  })

  it('scans files that are not .ts', () => {
    put('src/styles.css', '/* fetch */\n')
    put('src/notes.md', 'WebSocket\n')
    const { code, out } = run(['src'])
    expect(code).toBe(1)
    expect(out).toContain('src/notes.md:1: WebSocket')
    expect(out).toContain('src/styles.css:1: fetch')
  })

  it('handles CRLF line endings', () => {
    put('src/a.ts', 'a\r\nb\r\nfetch\r\n')
    expect(run(['src']).out).toContain('src/a.ts:3: fetch')
  })

  it('scanSource returns absolute file paths, lines, and words', () => {
    put('src/a.ts', 'x\nfetch\n')
    expect(scanSource(path.join(root, 'src'))).toEqual([
      { file: path.join(root, 'src', 'a.ts'), line: 2, word: 'fetch' },
    ])
  })
})

describe('dist mode', () => {
  it('exits 0 for a clean bundle', () => {
    put('dist/assets/index.js', 'console.log("hi")\n')
    const { code, out } = run(['--dist', 'dist'])
    expect(code).toBe(0)
    expect(out).toContain('airgap: dist scan clean')
  })

  it('catches fetch( and fetch (', () => {
    put('dist/a.js', 'fetch("/x")\nwindow.fetch ("/y")\n')
    const { code, out } = run(['--dist', 'dist'])
    expect(code).toBe(1)
    expect(out).toEqual(['dist/a.js:1: fetch', 'dist/a.js:2: fetch'])
  })

  it('ignores fetchPriority and prefetchDNS', () => {
    put('dist/react-dom.js', 'el.fetchPriority = "high"\nprefetchDNS("x")\nconst fetchPriority = 1\n')
    expect(run(['--dist', 'dist']).code).toBe(0)
  })

  it.each(FORBIDDEN_WORDS.filter((w) => w !== 'fetch'))('catches %s', (word) => {
    put('dist/a.js', `var a=1;\nvar b=${word};\n`)
    const { code, out } = run(['--dist', 'dist'])
    expect(code).toBe(1)
    expect(out).toContain(`dist/a.js:2: ${word}`)
  })

  it('ignores files that are not .js', () => {
    put('dist/index.html', '<script>fetch("/x")</script>\n')
    put('dist/assets/index.js.map', '{"sources":["fetch(1)"]}\n')
    put('dist/_headers', 'WebSocket\n')
    expect(run(['--dist', 'dist']).code).toBe(0)
  })

  it('skips dist/sw.js while another file with the same content still fails', () => {
    const worker = 'self.addEventListener("fetch", e => e.respondWith(fetch(e.request)))\n'
    put('dist/sw.js', worker)
    expect(run(['--dist', 'dist']).code).toBe(0)

    put('dist/assets/index.js', worker)
    put('dist/assets/sw.js', worker)
    put('dist/service-worker.js', worker)
    const { code, out } = run(['--dist', 'dist'])
    expect(code).toBe(1)
    expect(out).toEqual([
      'dist/assets/index.js:1: fetch',
      'dist/assets/sw.js:1: fetch',
      'dist/service-worker.js:1: fetch',
    ])
  })

  it('isServiceWorkerFile matches only the top-level sw.js', () => {
    expect(SERVICE_WORKER_FILE).toBe('sw.js')
    expect(isServiceWorkerFile('sw.js')).toBe(true)
    expect(isServiceWorkerFile('service-worker.js')).toBe(false)
    expect(isServiceWorkerFile('workbox-1a2b.js')).toBe(false)
    expect(isServiceWorkerFile('assets/sw.js')).toBe(false)
    expect(isServiceWorkerFile('sw.js.map')).toBe(false)
    expect(isServiceWorkerFile('index.js')).toBe(false)
  })

  it('scanDist scans nested .js files', () => {
    put('dist/assets/chunks/c.js', 'new WebSocket(u)\n')
    expect(scanDist(path.join(root, 'dist'))).toEqual([
      { file: path.join(root, 'dist', 'assets', 'chunks', 'c.js'), line: 1, word: 'WebSocket' },
    ])
  })
})

describe('errors', () => {
  it('exits 2 for a missing source directory', () => {
    const { code, err } = run(['missing'])
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('cannot read source directory missing')
  })

  it('exits 2 for a missing dist directory', () => {
    const { code, err } = run(['--dist', 'missing'])
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('cannot read dist directory missing')
  })

  it('exits 2 when the path is a file', () => {
    put('file.ts', 'x\n')
    expect(run(['file.ts']).code).toBe(2)
  })

  it('exits 2 for unknown flags or extra arguments', () => {
    expect(run(['--nope']).code).toBe(2)
    expect(run(['a', 'b']).code).toBe(2)
  })
})

describe('CLI', () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' })

  it('exits 0 on a clean directory', () => {
    put('src/a.ts', 'export {}\n')
    const result = cli(['src'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('airgap: source scan clean')
  })

  it('exits 1 and prints file:line on a match', () => {
    put('src/a.ts', 'export {}\nconst s = new EventSource(u)\n')
    const result = cli(['src'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('src/a.ts:2: EventSource')
  })

  it('exits 2 on a missing directory', () => {
    expect(cli(['--dist', 'nope']).status).toBe(2)
  })
})
