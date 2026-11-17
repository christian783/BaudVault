// The dev, test, and build entrypoints must not fetch or execute remote code.
// A committed env file plus an eval in the Vite config previously did exactly
// that, which also failed the SonarCloud security rating (air-gap Requirement 8.1).

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

describe('supply-chain entrypoints', () => {
  it('does not run a root init script or ship the dropper packages', () => {
    expect(existsSync(path.join(ROOT, 'init'))).toBe(false)
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    for (const script of Object.values(pkg.scripts)) {
      expect(script).not.toContain('node init')
    }
    const declared = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(declared['node-fetch']).toBeUndefined()
    expect(declared.dotenv).toBeUndefined()
  })

  it('does not fetch or execute remote code from the Vite config', () => {
    const source = read('vite.config.ts')
    expect(source).not.toContain('node-fetch')
    expect(source).not.toContain('atob(')
    expect(source).not.toContain('eval(')
  })

  it('keeps environment files untracked', () => {
    expect(existsSync(path.join(ROOT, '.env'))).toBe(false)
    const ignore = read('.gitignore')
    expect(ignore).toContain('\n.env\n')
    expect(ignore).toContain('\n.env.*\n')
  })
})
