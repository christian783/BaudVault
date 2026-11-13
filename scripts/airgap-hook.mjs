#!/usr/bin/env node
// Air-gap pre-write hook (Requirement 8.1, BV-03 hook a).
//
// Run by the Kiro `PreToolUse` command hook `.kiro/hooks/airgap-guard.json`
// before every file-writing tool call. Kiro writes the pending call to stdin
// as JSON and closes it:
//
//   { "session_id", "hook_event_name", "cwd", "tool_name", "tool_input": { ... } }
//
// Older IDE builds used camelCase (`toolName`, `toolArgs`). Both are read, and
// a bare tool input object with no wrapper is accepted too.
//
// When the write targets a file under the repository's src/ and its new text
// contains a forbidden word, this script prints the file and the word(s) on
// stderr and exits 2. Exit 2 is the only code Kiro treats as a block, and only
// stderr reaches the agent. It never prints the content itself, because files
// under src/ can hold secret material.
//
// Everything else exits 0, including empty or malformed stdin. Failing open is
// deliberate: the PostFileSave hook (airgap-save-check.json) and `npm run
// airgap` in `npm test` scan the files on disk and catch anything missed here.
//
// Known gaps, all covered by the on-disk scan:
// - str_replace is checked on its new text only, so a word split across the
//   replacement boundary is not seen.
// - Moves into src/ (no content in the payload) and patch-style tools that
//   embed paths in their text are not inspected.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_MATCHERS, findMatches } from './airgap-words.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Fields that name the file a tool writes. The first string found wins. */
const PATH_KEYS = Object.freeze([
  'path',
  'file_path',
  'filePath',
  'targetFile',
  'target_file',
  'file',
  'filename',
])

/**
 * Fields that carry text the tool will put in the file: full content for
 * create/overwrite, appended text, and replacement text for edits. Old text
 * (`oldStr`, `old_string`) is deliberately absent so removing a word is allowed.
 * `newName` covers symbol renames.
 */
const CONTENT_KEYS = Object.freeze([
  'text',
  'content',
  'contents',
  'file_text',
  'fileText',
  'newStr',
  'new_str',
  'newString',
  'new_string',
  'newText',
  'new_text',
  'insert_text',
  'newName',
])

/** Nesting depth searched for per-file edit lists such as `edits: [{ path, newStr }]`. */
const MAX_DEPTH = 4

/** How long to wait for Kiro to close stdin before giving up and allowing the call. */
const STDIN_TIMEOUT_MS = 10_000

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Picks the tool input out of the hook payload. Returns null if there is none. */
function toolInputOf(payload) {
  if (!isObject(payload)) return null
  for (const key of ['tool_input', 'toolInput', 'toolArgs']) {
    let value = payload[key]
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return null
      }
    }
    if (isObject(value)) return value
  }
  return payload
}

/**
 * Collects `{ file, texts }` for every object in the tool input that carries
 * content. Nested objects inherit the nearest enclosing path.
 */
function collectWrites(input) {
  const writes = []
  const walk = (node, inheritedFile, depth) => {
    if (depth > MAX_DEPTH) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritedFile, depth + 1)
      return
    }
    if (!isObject(node)) return
    const ownFile = PATH_KEYS.map((key) => node[key]).find((v) => typeof v === 'string' && v !== '')
    const file = ownFile ?? inheritedFile
    const texts = CONTENT_KEYS.map((key) => node[key]).filter((v) => typeof v === 'string')
    if (texts.length > 0) writes.push({ file, texts })
    for (const [key, value] of Object.entries(node)) {
      if (CONTENT_KEYS.includes(key) || PATH_KEYS.includes(key)) continue
      if (typeof value === 'object' && value !== null) walk(value, file, depth + 1)
    }
  }
  walk(input, undefined, 0)
  return writes
}

/**
 * Returns the target's path relative to `<repoRoot>/src` with forward slashes,
 * or null when the target is not inside src/. Relative paths resolve against
 * the payload's `cwd`. Backslashes are accepted on every platform, and the
 * comparison is case-insensitive on Windows (path.win32.relative).
 */
export function srcRelativePath(file, { repoRoot = REPO_ROOT, cwd = process.cwd() } = {}) {
  let target = file.trim()
  if (target.startsWith('file:')) {
    try {
      target = fileURLToPath(target)
    } catch {
      return null
    }
  }
  if (path.sep === '/') target = target.replace(/\\/g, '/')
  const srcDir = path.resolve(repoRoot, 'src')
  const relative = path.relative(srcDir, path.resolve(cwd, target))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

/**
 * Checks one hook payload (the raw stdin text). Returns `{ code, message }`:
 * code 2 with a stderr message when a write under src/ adds a forbidden word,
 * otherwise code 0 and an empty message.
 */
export function evaluate(raw, { repoRoot = REPO_ROOT, cwd } = {}) {
  const allow = { code: 0, message: '' }
  if (typeof raw !== 'string' || raw.trim() === '') return allow
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return allow
  }
  const input = toolInputOf(payload)
  if (input === null) return allow
  const base = cwd ?? (isObject(payload) && typeof payload.cwd === 'string' ? payload.cwd : process.cwd())

  /** Forbidden words per src-relative file, in first-seen order. */
  const hits = new Map()
  for (const { file, texts } of collectWrites(input)) {
    if (file === undefined) continue
    const relative = srcRelativePath(file, { repoRoot, cwd: base })
    if (relative === null) continue
    const words = hits.get(relative) ?? new Set()
    for (const text of texts) {
      for (const { word } of findMatches(text, SOURCE_MATCHERS)) words.add(word)
    }
    if (words.size > 0) hits.set(relative, words)
  }
  if (hits.size === 0) return allow

  const lines = [...hits].map(([file, words]) => `  src/${file}: ${[...words].join(', ')}`)
  const message = [
    'Air-gap guard blocked this write (Requirement 8.1). Files under src/ must not contain',
    'these network API words anywhere, including comments, strings, and longer identifiers:',
    ...lines,
    'Rename or remove them (for example loadSamples, not fetchSamples). See .kiro/steering/air-gap.md.',
  ].join('\n')
  return { code: 2, message }
}

/** Reads stdin to the end, or resolves with '' if it is a TTY or never closes. */
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    const chunks = []
    const finish = (text) => {
      clearTimeout(timer)
      process.stdin.removeAllListeners()
      process.stdin.destroy()
      resolve(text)
    }
    const timer = setTimeout(() => finish(''), timeoutMs)
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => finish(''))
  })
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const raw = await readStdin(STDIN_TIMEOUT_MS)
  let result
  try {
    result = evaluate(raw)
  } catch {
    result = { code: 0, message: '' }
  }
  if (result.code !== 0) process.stderr.write(`${result.message}\n`)
  process.exitCode = result.code
}
