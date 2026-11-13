#!/usr/bin/env node
// Air-gap scanner (Requirements 8.1, 8.7).
//
// Usage:
//   node scripts/airgap-scan.mjs [dir]          plain-text scan of every file under dir (default: src/)
//   node scripts/airgap-scan.mjs --dist [dir]   call-pattern scan of dir/**/*.js (default: dist/)
//
// Prints `file:line: word` for each match. Exit codes: 0 clean, 1 matches
// found, 2 usage error or unreadable directory.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIST_MATCHERS, SOURCE_MATCHERS, findMatches } from './airgap-words.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Service worker scripts skipped by the --dist scan, matched against file
 * names at the top level of the dist directory. The service worker fetches
 * same-origin precached files by design (Requirement 8.8). Update this list if
 * the build plugin (task 11.2) emits a different name.
 */
export const SERVICE_WORKER_FILES = Object.freeze([
  /^sw\.js$/,
  /^service-worker\.js$/,
  /^workbox-[\w-]+\.js$/,
])

export function isServiceWorkerFile(relativePath) {
  if (relativePath.includes('/')) return false
  return SERVICE_WORKER_FILES.some((pattern) => pattern.test(relativePath))
}

/** Lists every file under `dir` as a sorted, forward-slash relative path. */
function listFiles(dir) {
  const files = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative)
      else if (entry.isFile()) files.push(relative)
    }
  }
  walk(dir, '')
  return files.sort()
}

function scanFiles(dir, files, matchers) {
  const results = []
  for (const relative of files) {
    const text = readFileSync(path.join(dir, relative), 'utf8')
    for (const { line, word } of findMatches(text, matchers)) {
      results.push({ file: path.join(dir, relative), line, word })
    }
  }
  return results
}

/** Plain-text scan of every file under `dir`. Returns `{ file, line, word }[]`. */
export function scanSource(dir) {
  return scanFiles(dir, listFiles(dir), SOURCE_MATCHERS)
}

/** Call-pattern scan of every `.js` file under `dir` except the service worker. */
export function scanDist(dir) {
  const files = listFiles(dir).filter((f) => f.endsWith('.js') && !isServiceWorkerFile(f))
  return scanFiles(dir, files, DIST_MATCHERS)
}

/** Runs the CLI. Returns the exit code instead of exiting, so tests can call it. */
export function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const dist = argv.includes('--dist')
  const rest = argv.filter((arg) => arg !== '--dist')
  if (rest.length > 1 || rest.some((arg) => arg.startsWith('--'))) {
    err('usage: airgap-scan.mjs [--dist] [dir]')
    return 2
  }

  const dir = rest[0] ? path.resolve(cwd, rest[0]) : path.join(REPO_ROOT, dist ? 'dist' : 'src')
  const label = dist ? 'dist' : 'source'
  const show = (p) => (path.relative(cwd, p) || '.').split(path.sep).join('/')
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory')
  } catch {
    err(`airgap: cannot read ${label} directory ${show(dir)}`)
    return 2
  }

  const results = dist ? scanDist(dir) : scanSource(dir)
  for (const { file, line, word } of results) out(`${show(file)}:${line}: ${word}`)
  if (results.length > 0) {
    err(`airgap: ${results.length} forbidden network API match(es) in ${label} scan`)
    return 1
  }
  out(`airgap: ${label} scan clean`)
  return 0
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
