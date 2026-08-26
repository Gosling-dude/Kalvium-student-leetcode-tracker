/**
 * Record which commit this build came from, at build time.
 *
 * The deployment smoke test needs to tell "the pushed commit is live" from "the host is
 * still serving the previous build". A healthy `/health` cannot answer that, and the host's
 * own injected variable is not always there — Render exposes `RENDER_GIT_COMMIT` for some
 * service configurations and not others, and relying on it left the check degraded to a
 * warning on every run.
 *
 * Reading it here instead makes it independent of the host: the build happens in a git
 * clone, so `git rev-parse HEAD` answers even when nothing was injected. Every source is
 * tried, and failing to find one is not a build failure — a missing commit id degrades the
 * deployment check to a warning, which is a far smaller problem than a deploy that will not
 * build.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../dist/build-info.json');

function resolveCommit() {
  // Host-injected first: it names the commit the host *intended* to deploy, which is the
  // more authoritative answer when the two could differ.
  const injected = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? process.env.SOURCE_VERSION;
  if (injected) return injected.trim();

  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const commit = resolveCommit();
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`build-info: commit=${commit ?? '(unknown)'}`);
