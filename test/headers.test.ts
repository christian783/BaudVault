// Tests for public/_headers, the Netlify response headers (Requirements 8.6, 8.8).
//
// Netlify combines the headers of every rule whose path matches a request, and
// a browser enforces every CSP header it receives. So each path below must get
// exactly one Content-Security-Policy across all matching rules, and no
// wildcard rule may set one.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SERVICE_WORKER_FILE } from '../scripts/sw-plugin.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HEADERS_FILE = path.join(ROOT, 'public', '_headers')
const NETLIFY_TOML = path.join(ROOT, 'netlify.toml')

const HTML_PATHS = ['/', '/index.html'] as const
const SW_PATH = `/${SERVICE_WORKER_FILE}`

/** The HTML policy from design.md, "Production headers". */
const HTML_POLICY: Record<string, string[]> = {
  'default-src': ["'self'"],
  'connect-src': ["'none'"],
  'img-src': ["'self'", 'blob:', 'data:'],
  'media-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
}

interface Header {
  name: string
  value: string
}

interface Rule {
  path: string
  headers: Header[]
}

/**
 * Parses Netlify `_headers` text: an unindented line starts a rule for that
 * path, indented `Name: value` lines add headers to it, and `#` lines are
 * comments.
 */
function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    if (!/^\s/.test(line)) {
      rules.push({ path: trimmed, headers: [] })
      return
    }
    const colon = trimmed.indexOf(':')
    const rule = rules.at(-1)
    if (rule === undefined || colon <= 0) throw new Error(`_headers line ${index + 1} is not a header of a rule`)
    rule.headers.push({ name: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() })
  })
  return rules
}

/**
 * Turns a Netlify rule path into a matcher. `*` matches any rest of the path
 * and `:name` matches one segment. Matching ignores case, so a rule that
 * differs only in case still counts as a match.
 */
function rulePattern(rulePath: string): RegExp {
  const body = rulePath
    .split(/(\*|:[A-Za-z0-9_]+)/)
    .map((part) => {
      if (part === '*') return '.*'
      if (part.startsWith(':')) return '[^/]+'
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${body}$`, 'i')
}

function isWildcard(rulePath: string): boolean {
  return /\*|:[A-Za-z0-9_]/.test(rulePath)
}

function isCsp(header: Header): boolean {
  return header.name.toLowerCase() === 'content-security-policy'
}

/** Every CSP value Netlify would send for `requestPath`, across all matching rules. */
function cspFor(rules: readonly Rule[], requestPath: string): string[] {
  return rules
    .filter((rule) => rulePattern(rule.path).test(requestPath))
    .flatMap((rule) => rule.headers.filter(isCsp).map((h) => h.value))
}

/** Splits a policy into directive name and source list. */
function directives(policy: string): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) result[name.toLowerCase()] = sources
  }
  return result
}

const rules = parseHeaders(readFileSync(HEADERS_FILE, 'utf8'))

describe('parseHeaders and rulePattern', () => {
  it('reads paths, headers, and comments in Netlify format', () => {
    const parsed = parseHeaders('# note\n/a\n  X-One: 1\n  # inner note\n\n/b/*\n  X-Two: a: b\n')
    expect(parsed).toEqual([
      { path: '/a', headers: [{ name: 'X-One', value: '1' }] },
      { path: '/b/*', headers: [{ name: 'X-Two', value: 'a: b' }] },
    ])
  })

  it('matches splats and placeholders the way Netlify does', () => {
    expect(rulePattern('/*').test('/')).toBe(true)
    expect(rulePattern('/*').test(SW_PATH)).toBe(true)
    expect(rulePattern('/:file').test('/index.html')).toBe(true)
    expect(rulePattern('/:file').test('/')).toBe(false)
    expect(rulePattern('/index.html').test('/indexXhtml')).toBe(false)
    expect(rulePattern('/SW.JS').test('/sw.js')).toBe(true)
  })
})

describe('public/_headers', () => {
  it.each(HTML_PATHS)('sends one CSP with the design policy and connect-src none on %s', (requestPath) => {
    const policies = cspFor(rules, requestPath)
    expect(policies).toHaveLength(1)
    const policy = directives(policies[0]!)
    expect(policy['connect-src']).toEqual(["'none'"])
    expect(policy).toEqual(HTML_POLICY)
  })

  it('sends one CSP of default-src self on the service worker path', () => {
    const policies = cspFor(rules, SW_PATH)
    expect(policies).toHaveLength(1)
    const policy = directives(policies[0]!)
    expect(policy['default-src']).toEqual(["'self'"])
    expect(policy['connect-src']).toBeUndefined()
  })

  it('has an exact rule for the service worker file the build plugin emits', () => {
    expect(rules.map((r) => r.path)).toContain(SW_PATH)
  })

  it('has no /* rule and no wildcard rule that sets a CSP', () => {
    expect(rules.map((r) => r.path)).not.toContain('/*')
    const wildcardCsp = rules.filter((r) => isWildcard(r.path) && r.headers.some(isCsp)).map((r) => r.path)
    expect(wildcardCsp).toEqual([])
  })

  it('is the only place headers are set, so netlify.toml adds no second CSP', () => {
    expect(readFileSync(NETLIFY_TOML, 'utf8')).not.toMatch(/^\s*\[\[headers\]\]/m)
  })
})
