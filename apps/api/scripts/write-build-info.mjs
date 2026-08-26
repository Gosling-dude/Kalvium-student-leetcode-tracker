/**
 * Record which commit this build came from, at build time.
 *
 * The deployment smoke test needs to tell "the pushed commit is live" from "the host is
 * still serving the previous build". A healthy `/health` cannot answer that.
 *
 * This is the *fallback* source, not the primary one. At runtime the config prefers the
 * host's injected variable, which is the more authoritative answer and the one that
 * actually populates on Render — inside a Docker build, `RENDER_GIT_COMMIT` is not present
 * (env vars are not build args), the alpine image has no `git`, and the build context may
 * not carry `.git`. So on that path this file legitimately records `null` and the runtime
 * env var supplies the value. It earns its place for hosts that build outside Docker, or
 * that inject nothing at runtime.
 *
 * **This script must never fail a build.** A non-zero exit here would fail the deploy and
 * freeze production on its previous release — over a diagnostic. Every step is therefore
 * wrapped, and an unwritable file is reported and shrugged off: the cost is one deployment
 * check degraded to a warning.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveCommit() {
  const injected =
    process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? process.env.SOURCE_VERSION;
  if (injected?.trim()) return injected.trim();

  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

try {
  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(here, '../dist/build-info.json');
  const commit = resolveCommit();

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`build-info: commit=${commit ?? '(unknown — runtime env var will supply it)'}`);
} catch (error) {
  // Deliberately exit 0. See the note above: a failed deploy is far worse than a missing
  // commit id.
  console.warn(`build-info: could not be written (${error.message}). Continuing.`);
}
