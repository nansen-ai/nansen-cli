#!/usr/bin/env node

/**
 * Report whether the mcp-remote pin in src/mcp-client-config.json is behind
 * the latest npm release (API-322).
 *
 *   npm run mcp:check-pin            human report
 *   npm run mcp:check-pin -- --json  machine-readable report
 *
 * Exit codes: 0 = the pin is the latest release, 3 = the pin needs review
 * (behind, deprecated, missing, or the source changed), 2 = the check itself
 * failed (registry unreachable, bad response, bad config).
 *
 * The pin is deliberately NOT bumped automatically: mcp-remote carries the API
 * key on every request, so a human reviews each release first. The report
 * shows the npm provenance source (the GitHub repository that built the
 * tarball, from the registry's signed SLSA attestation), the declared
 * repository and the current npm maintainers, because a change of owner is a
 * reason to review with extra care.
 * .github/workflows/mcp-remote-pin.yml runs this weekly and opens an issue.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 30_000;
export const EXIT = Object.freeze({ OK: 0, CHECK_FAILED: 2, NEEDS_REVIEW: 3 });
/** A pin must be at least this old when it is adopted. */
export const MIN_RELEASE_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compare two x.y.z versions; prerelease or odd versions sort as null (ignored). */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** github.com/owner/repo, lower-cased, from any npm repository form. */
export function normalizeRepository(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/github(?:\.com[/:]|:)([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[#/].*)?$/i);
  return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : raw;
}

function describeVersion(packument, version, provenance) {
  const meta = packument.versions?.[version];
  if (!meta) return null;
  return {
    version,
    publishedAt: packument.time?.[version] ?? null,
    repository: normalizeRepository(meta.repository),
    provenance: provenance?.[version] ?? null,
    deprecated: meta.deprecated ?? null,
  };
}

/** Pure: build the report from a registry packument and per-version provenance repos. */
export function evaluatePin(packument, pinnedVersion, provenance = {}, { now = Date.now() } = {}) {
  const latestVersion = packument?.['dist-tags']?.latest ?? null;
  const pinned = describeVersion(packument, pinnedVersion, provenance);
  const latest = latestVersion ? describeVersion(packument, latestVersion, provenance) : null;
  const newer = Object.keys(packument?.versions ?? {})
    .filter(v => compareVersions(v, pinnedVersion) === 1)
    .sort((a, b) => compareVersions(a, b) ?? 0);
  // Newest newer release that meets the minimum release age: the only valid bump target.
  const ageCutoff = now - MIN_RELEASE_AGE_DAYS * DAY_MS;
  const isOldEnough = v => {
    const published = Date.parse(packument?.time?.[v] ?? '');
    return Number.isFinite(published) && published <= ageCutoff;
  };
  const eligibleVersion = [...newer].reverse().find(isOldEnough) ?? null;
  const eligible = eligibleVersion ? describeVersion(packument, eligibleVersion, provenance) : null;

  const problems = [];
  if (!pinned) problems.push(`pinned version ${pinnedVersion} does not exist on the registry`);
  if (pinned?.deprecated) problems.push(`pinned version ${pinnedVersion} is deprecated: ${pinned.deprecated}`);
  if (pinned && !isOldEnough(pinnedVersion)) {
    problems.push(`pinned version ${pinnedVersion} is younger than ${MIN_RELEASE_AGE_DAYS} days`);
  }
  if (latest && compareVersions(latest.version, pinnedVersion) === 1) {
    problems.push(`pinned version ${pinnedVersion} is behind latest ${latest.version} (${newer.length} newer release(s))`);
  }
  if (pinned && latest && pinned.repository !== latest.repository) {
    problems.push(`declared repository changed: ${pinned.repository} -> ${latest.repository}`);
  }
  if (pinned && latest && pinned.provenance !== latest.provenance) {
    problems.push(`provenance source changed: ${pinned.provenance ?? 'none'} -> ${latest.provenance ?? 'none'}`);
  }
  const maintainers = (packument?.maintainers ?? []).map(m => m?.name).filter(Boolean).sort();
  return { package: packument?.name ?? 'mcp-remote', pinned, latest, eligible, newerReleases: newer, maintainers, ok: problems.length === 0, problems };
}

// Registry text goes into a GitHub issue code block; keep it from closing the fence.
const safe = value => String(value ?? 'unknown').replace(/[`~]/g, "'");

export function formatReport(report) {
  const line = (label, v) => (v
    ? `${label}: ${safe(v.version)} (published ${safe(v.publishedAt)}, provenance ${safe(v.provenance ?? 'none')}, repository ${safe(v.repository)})`
    : `${label}: unknown`);
  const lines = [
    `${safe(report.package)} pin check (src/mcp-client-config.json)`,
    line('Pinned', report.pinned),
    line('Latest', report.latest),
    line(`Newest release at least ${MIN_RELEASE_AGE_DAYS} days old`, report.eligible),
    `Current npm maintainers: ${report.maintainers.map(safe).join(', ') || 'unknown'}`,
  ];
  if (report.ok) {
    lines.push('OK: the pin is the latest release.');
  } else {
    for (const problem of report.problems) lines.push(`REVIEW: ${safe(problem)}`);
    lines.push(`To bump: pick a version at least ${MIN_RELEASE_AGE_DAYS} days old, review the release notes and source diff, then follow AGENTS.md > MCP client config.`);
  }
  return lines.join('\n');
}

async function getJson(fetchFn, url) {
  const response = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response.json();
}

/** Source repository from the npm SLSA provenance attestation, or null when there is none. */
export async function provenanceRepository(fetchFn, name, version) {
  const body = await getJson(fetchFn, `${REGISTRY}/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`);
  for (const attestation of body?.attestations ?? []) {
    if (!String(attestation?.predicateType).includes('slsa.dev/provenance')) continue;
    try {
      const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
      const repo = statement?.predicate?.buildDefinition?.externalParameters?.workflow?.repository;
      if (typeof repo === 'string') return normalizeRepository(repo);
    } catch { /* malformed attestation: treat as none */ }
  }
  return null;
}

export async function run(argv, { fetchFn = fetch, log = console.log, error = console.error, loadConfig } = {}) {
  try {
    const config = loadConfig ? loadConfig() : (await import('../src/mcp-client-config.js')).MCP_CLIENT_CONFIG;
    const { package: name, version } = config.mcpRemote;
    const packument = await getJson(fetchFn, `${REGISTRY}/${encodeURIComponent(name)}`);
    if (!packument?.versions) throw new Error(`registry has no versions for ${name}`);
    const latest = packument['dist-tags']?.latest;
    const provenance = {};
    for (const v of new Set([version, latest].filter(Boolean))) {
      if (packument.versions[v]) provenance[v] = await provenanceRepository(fetchFn, name, v);
    }
    const report = evaluatePin(packument, version, provenance);
    log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.ok ? EXIT.OK : EXIT.NEEDS_REVIEW;
  } catch (err) {
    error(`mcp-remote pin check failed: ${err.message}`);
    return EXIT.CHECK_FAILED;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2));
}
