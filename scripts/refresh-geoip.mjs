#!/usr/bin/env node
// refresh-geoip.mjs — fetch fresh MaxMind GeoLite2 City + ASN databases.
//
// Runs weekly via sgdi-geoip-refresh.timer. Idempotent: rerunning just
// pulls the latest .mmdb files, overwriting the existing ones atomically.
//
// Pipeline per edition:
//   1. Download .tar.gz from MaxMind's authenticated download endpoint
//   2. Fetch the matching .sha256 file from the same endpoint
//   3. Verify the tarball matches the published sha256
//   4. Extract the .mmdb (it's nested inside a dated dir in the tarball)
//   5. Smoke-test by opening with the maxmind reader (rejects corrupt files)
//   6. Atomic rename: <target>.tmp → <target> (with prior version → <target>.prev)
//
// Env (from /etc/default/sgdi-geoip.env):
//   MAXMIND_LICENSE_KEY  required
//   MAXMIND_ACCOUNT_ID   optional, not used by this endpoint
//
// Target dir defaults to /var/lib/sgdi/geoip. Writable by the running user.

import { mkdir, writeFile, rename, readFile, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { open as openMmdb } from 'maxmind';

const EDITIONS = [
  // We deliberately skip GeoLite2-Country: City supersedes it (every row
  // includes the country code), and one less file means one less weekly
  // failure mode.
  { id: 'GeoLite2-City', target: 'GeoLite2-City.mmdb' },
  { id: 'GeoLite2-ASN',  target: 'GeoLite2-ASN.mmdb'  },
];

const TARGET_DIR = process.env.SGDI_GEOIP_DIR || '/var/lib/sgdi/geoip';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`fatal: ${name} not set`); process.exit(2); }
  return v;
}

async function fetchToBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function fetchSha256(licenseKey, editionId) {
  const url = `https://download.maxmind.com/app/geoip_download?edition_id=${editionId}&license_key=${licenseKey}&suffix=tar.gz.sha256`;
  const body = (await fetchToBuffer(url)).toString('utf8');
  // Format: "<sha256>  <filename>\n"
  const match = body.match(/^([0-9a-f]{64})\s/i);
  if (!match) throw new Error(`unexpected sha256 body: ${body.slice(0, 80)}`);
  return match[1].toLowerCase();
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Extract a single .mmdb member from a gzipped tarball. We pipe through
 * the system `tar` to avoid a tarball-parser dependency — tar is on every
 * Linux box this runs on.
 *
 * The extracted file lands at <outDir>/<extractedName>. Returns its path.
 */
async function extractMmdbFromTarball(tarBuf, outDir, mmdbName) {
  await mkdir(outDir, { recursive: true });
  return new Promise((resolve, reject) => {
    // Use --wildcards to match the dated subdir prefix, --strip-components=1
    // to drop it. Result: <outDir>/<mmdbName>.
    const p = spawn('tar', [
      '-xzC', outDir,
      '--strip-components=1',
      '--wildcards', `*/${mmdbName}`,
    ]);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`tar exited ${code}: ${stderr.slice(0, 300)}`));
      resolve(join(outDir, mmdbName));
    });
    p.stdin.end(tarBuf);
  });
}

async function smokeTest(mmdbPath) {
  // Open + perform a known-answer lookup. Confirms the file isn't truncated
  // or wrong-format. 8.8.8.8 = Google US, present in every GeoLite2 release.
  const r = await openMmdb(mmdbPath);
  const probe = r.get('8.8.8.8');
  if (!probe) throw new Error(`smoke probe returned null for 8.8.8.8 (corrupt mmdb?)`);
}

async function fileExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function refresh(edition, licenseKey) {
  console.log(`\n=== ${edition.id} ===`);
  const tmpDir = join(TARGET_DIR, '.tmp-' + process.pid);
  await mkdir(tmpDir, { recursive: true });

  console.log(`  fetching tarball + sha256…`);
  const dlUrl = `https://download.maxmind.com/app/geoip_download?edition_id=${edition.id}&license_key=${licenseKey}&suffix=tar.gz`;
  const [tarBuf, expectedSha] = await Promise.all([
    fetchToBuffer(dlUrl),
    fetchSha256(licenseKey, edition.id),
  ]);
  console.log(`    tarball: ${(tarBuf.length / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    expected sha256: ${expectedSha.slice(0, 16)}…`);

  const actualSha = sha256Hex(tarBuf);
  if (actualSha !== expectedSha) {
    throw new Error(`sha256 mismatch for ${edition.id}: expected=${expectedSha} actual=${actualSha}`);
  }
  console.log(`    ✓ sha256 matches`);

  console.log(`  extracting…`);
  const extractedPath = await extractMmdbFromTarball(tarBuf, tmpDir, edition.target);

  console.log(`  smoke-testing…`);
  await smokeTest(extractedPath);
  console.log(`    ✓ lookup probe succeeded`);

  const finalPath = join(TARGET_DIR, edition.target);
  const prevPath  = finalPath + '.prev';

  if (await fileExists(finalPath)) {
    if (await fileExists(prevPath)) await unlink(prevPath);
    await rename(finalPath, prevPath);
  }
  await rename(extractedPath, finalPath);
  const st = await stat(finalPath);
  console.log(`  ✓ promoted → ${finalPath} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);

  // Clean up tmpDir (should now be empty, but rmdir tolerates non-empty via -rf safer here)
  try { await unlink(join(tmpDir, edition.target)); } catch {}
}

async function main() {
  const licenseKey = requireEnv('MAXMIND_LICENSE_KEY');
  await mkdir(TARGET_DIR, { recursive: true });
  console.log(`refresh-geoip → ${TARGET_DIR}`);

  let failed = 0;
  for (const e of EDITIONS) {
    try { await refresh(e, licenseKey); }
    catch (err) { console.error(`  ✗ ${e.id}: ${err?.message ?? err}`); failed++; }
  }
  console.log('');
  if (failed > 0) { console.error(`done with ${failed} failure(s) — existing files left in place`); process.exit(1); }
  console.log(`done: ${EDITIONS.length} edition(s) refreshed`);
}

main().catch((e) => { console.error('fatal:', e?.message ?? e); process.exit(1); });
