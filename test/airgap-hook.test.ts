// Tests for scripts/airgap-hook.mjs (Requirement 8.1).
//
// This file sits outside src/, so it may name the forbidden words.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluate, srcRelativePath } from '../scripts/airgap-hook.mjs'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/airgap-hook.mjs')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Builds a Kiro PreToolUse payload with cwd at the repository root. */
const payload = (tool_name: string, tool_input: unknown) =>
  JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', cwd: REPO, tool_name, tool_input })

describe('evaluate', () => {
  it('allows a clean write under src/', () => {
    expect(evaluate(payload('fs_write', { path: 'src/a.ts', text: 'const loadSamples = 1' })).code).toBe(0)
  })

  it('blocks a write under src/ that contains a forbidden word, naming file and word but not content', () => {
    const result = evaluate(payload('fs_write', { path: 'src/a.ts', text: 'secret-line\nconst fetchSamples = 1' }))
    expect(result.code).toBe(2)
    expect(result.message).toContain('src/a.ts: fetch')
    expect(result.message).not.toContain('secret-line')
  })

  it('allows a forbidden word outside src/', () => {
    expect(evaluate(payload('fs_write', { path: 'scripts/x.mjs', text: 'fetch(1)' })).code).toBe(0)
  })

  it('checks str_replace new text only', () => {
    expect(evaluate(payload('str_replace', { path: 'src/a.ts', oldStr: 'a', newStr: 'WebSocket' })).code).toBe(2)
    expect(evaluate(payload('str_replace', { path: 'src/a.ts', oldStr: 'fetch', newStr: 'load' })).code).toBe(0)
  })

  it('checks fs_append text', () => {
    expect(evaluate(payload('fs_append', { path: 'src/a.ts', text: 'sendBeacon' })).code).toBe(2)
  })

  it('allows empty, malformed, and content-free payloads', () => {
    expect(evaluate('').code).toBe(0)
    expect(evaluate('{not json').code).toBe(0)
    expect(evaluate(payload('fs_write', {})).code).toBe(0)
  })
})

describe('srcRelativePath', () => {
  it('accepts relative, backslash, and absolute paths inside src/', () => {
    expect(srcRelativePath('src/a/b.ts', { repoRoot: REPO, cwd: REPO })).toBe('a/b.ts')
    expect(srcRelativePath('src\\a\\b.ts', { repoRoot: REPO, cwd: REPO })).toBe('a/b.ts')
    expect(srcRelativePath(path.join(REPO, 'src', 'b.ts'), { repoRoot: REPO, cwd: '/' })).toBe('b.ts')
  })

  it('rejects paths outside src/', () => {
    expect(srcRelativePath('srcx/a.ts', { repoRoot: REPO, cwd: REPO })).toBeNull()
    expect(srcRelativePath('src/../test/a.ts', { repoRoot: REPO, cwd: REPO })).toBeNull()
    expect(srcRelativePath('src', { repoRoot: REPO, cwd: REPO })).toBeNull()
  })
})

describe('CLI', () => {
  const run = (input: string) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8' })

  it('exits 2 with the reason on stderr when blocking', () => {
    const result = run(payload('fs_write', { path: 'src/a.ts', text: 'EventSource' }))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('src/a.ts: EventSource')
    expect(result.stdout).toBe('')
  })

  it('exits 0 on a clean write and on malformed stdin', () => {
    expect(run(payload('fs_write', { path: 'src/a.ts', text: 'ok' })).status).toBe(0)
    expect(run('garbage').status).toBe(0)
  })
})
