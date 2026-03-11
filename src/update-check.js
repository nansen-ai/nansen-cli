/**
 * Update check — lightweight, non-blocking, zero-dependency.
 *
 * getUpdateNotification(currentVersion) — reads cached result, returns string or null
 * scheduleUpdateCheck()                — spawns detached background fetch if cache is stale
 */

import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.nansen');
const CACHE_FILE = path.join(CONFIG_DIR, 'update-check.json');
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const PACKAGE_NAME = 'nansen-cli';

/**
 * Compare two semver strings. Returns true if latest > current.
 */
function isNewer(latest, current) {
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [lM, lm, lp] = parse(latest);
  const [cM, cm, cp] = parse(current);
  if (lM !== cM) return lM > cM;
  if (lm !== cm) return lm > cm;
  return lp > cp;
}

const LAST_VERSION_FILE = path.join(CONFIG_DIR, 'last-version.json');

/**
 * After an update, show a one-time "what's new" notice on the first run.
 * Compares current version against the stored last-seen version.
 * Returns a notice string or null. Writes current version to disk.
 */
export function getUpgradeNotice(currentVersion) {
  try {
    if (process.env.NO_UPDATE_NOTIFIER || process.env.CI) return null;

    let previousVersion = null;
    if (fs.existsSync(LAST_VERSION_FILE)) {
      const raw = fs.readFileSync(LAST_VERSION_FILE, 'utf8');
      const data = JSON.parse(raw);
      previousVersion = data.version;
    }

    // Always update the stored version
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
    fs.writeFileSync(LAST_VERSION_FILE, JSON.stringify({ version: currentVersion }));

    // If no previous version stored, this is a fresh install — no notice
    if (!previousVersion) return null;

    // If versions match, no update happened
    if (previousVersion === currentVersion) return null;

    // Version changed — show notice
    return `\n  ✨ Updated to ${currentVersion} (was ${previousVersion}). Run \`nansen changelog --since ${previousVersion}\` for details.\n`;
  } catch {
    return null;
  }
}

/**
 * Read the cached check result and return a notification string (or null).
 */
export function getUpdateNotification(currentVersion) {
  try {
    if (process.env.NO_UPDATE_NOTIFIER || process.env.CI) return null;
    if (!fs.existsSync(CACHE_FILE)) return null;

    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const { latest } = JSON.parse(raw);
    if (!latest) return null;

    if (isNewer(latest, currentVersion)) {
      return `Update available: ${currentVersion} → ${latest}  (npm i -g ${PACKAGE_NAME})`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * If the cache is missing or stale, spawn a detached background process to refresh it.
 */
export function scheduleUpdateCheck() {
  try {
    if (process.env.NO_UPDATE_NOTIFIER || process.env.CI) return;

    // Check staleness
    if (fs.existsSync(CACHE_FILE)) {
      const { checkedAt } = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (checkedAt && Date.now() - checkedAt < STALE_MS) return;
    }

    // Inline script executed by the detached child
    const script = `
      const https = require('https');
      const fs = require('fs');
      const path = require('path');
      const dir = ${JSON.stringify(CONFIG_DIR)};
      const file = ${JSON.stringify(CACHE_FILE)};
      const req = https.get('https://registry.npmjs.org/${PACKAGE_NAME}/latest', { timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const { version } = JSON.parse(body);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
            fs.writeFileSync(file, JSON.stringify({ latest: version, checkedAt: Date.now() }));
          } catch {}
        });
      });
      req.on('error', () => {});
      req.setTimeout(5000, () => req.destroy());
    `;

    const child = childProcess.spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch {
    // silent
  }
}
