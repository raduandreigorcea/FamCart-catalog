// .env.scripts, read from the two places it can live.
//
// The superproject first: this repository is a submodule at catalog/ inside the
// app, and the credentials live at the app root next to the app's own. A bare
// clone with no app around it falls back to its own copy, which is what keeps
// `npm ci && npm test` working with nothing else checked out.
//
// Six lines of parsing rather than dotenv, for the same reason the previous
// scripts did it: this is the only place in the repository that reads a config
// file, and a dependency whose whole job is `split('=')` is a dependency to
// audit forever.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const CANDIDATES = ['../../../.env.scripts', '../../.env.scripts']

export function loadEnvFiles(): void {
  for (const relative of CANDIDATES) {
    const path = fileURLToPath(new URL(relative, import.meta.url))
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      // The environment wins. A value exported in the shell is the more
      // deliberate of the two, and this is how CI overrides a file it does not
      // have.
      if (!(key in process.env)) process.env[key] = value
    }
  }
}
