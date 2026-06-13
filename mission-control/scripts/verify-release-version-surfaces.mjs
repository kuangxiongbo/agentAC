#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(serverRoot, '..');
const clientRoot = path.join(repoRoot, 'mission-control-client');
const trayRoot = path.join(repoRoot, 'mission-control-tray');

const failures = [];
const checks = [];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

function ok(message) {
  checks.push(message);
}

function fail(message) {
  failures.push(message);
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual ?? '<missing>'}`);
    return;
  }
  ok(`${label}: ${expected}`);
}

function assertExists(label, file) {
  if (!existsSync(file)) {
    fail(`${label}: missing ${file}`);
    return false;
  }
  ok(`${label}: ${path.relative(repoRoot, file)}`);
  return true;
}

function publicFileFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) {
    fail(`public asset url must be absolute: ${url}`);
    return null;
  }
  return path.join(serverRoot, 'public', url.slice(1));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function assertSha256(label, file, expected) {
  const actual = sha256(file);
  if (actual !== expected) {
    fail(`${label}: sha256 mismatch, expected ${expected}, got ${actual}`);
    return;
  }
  ok(`${label}: sha256 ${actual}`);
}

function assertTextIncludes(label, file, required) {
  const content = readText(file);
  for (const item of required) {
    if (!content.includes(item)) {
      fail(`${label}: missing source contract ${item}`);
    } else {
      ok(`${label}: contains ${item}`);
    }
  }
}

function assertZipHasNextStaticChunks(zipFile) {
  const result = spawnSync('unzip', ['-Z1', zipFile], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`edge runtime zip listing failed: ${result.stderr || result.stdout}`);
    return;
  }
  if (!result.stdout.includes('/.next/static/chunks/')) {
    fail('edge runtime zip missing .next/static/chunks; local web will render without CSS/JS');
    return;
  }
  ok('edge runtime zip includes .next/static/chunks');
}

const serverPackage = readJson(path.join(serverRoot, 'package.json'));
const targetVersion = process.argv[2] || serverPackage.version;

assertEqual('server package version', serverPackage.version, targetVersion);
assertEqual(
  'edge web package version',
  readJson(path.join(clientRoot, 'package.json')).version,
  targetVersion,
);
assertEqual(
  'tray package version',
  readJson(path.join(trayRoot, 'package.json')).version,
  targetVersion,
);
assertEqual(
  'tauri bundle version',
  readJson(path.join(trayRoot, 'src-tauri/tauri.conf.json')).version,
  targetVersion,
);

const runtimeManifest = readJson(path.join(serverRoot, 'public/edge-runtime/manifest.json'));
assertEqual('edge runtime manifest client_version', runtimeManifest.client_version, targetVersion);
for (const [platform, artifact] of Object.entries(runtimeManifest.platforms || {})) {
  if (!artifact.url?.includes(`client-runtime-${targetVersion}-`)) {
    fail(`edge runtime ${platform}: url does not include target version ${targetVersion}`);
  } else {
    ok(`edge runtime ${platform}: url ${artifact.url}`);
  }
  const artifactFile = publicFileFromUrl(artifact.url);
  if (artifactFile && assertExists(`edge runtime ${platform} artifact`, artifactFile)) {
    assertSha256(`edge runtime ${platform} artifact`, artifactFile, artifact.sha256);
    if (artifactFile.endsWith('.zip')) {
      assertZipHasNextStaticChunks(artifactFile);
    }
  }
}

const trayManifest = readJson(path.join(serverRoot, 'public/edge-tray/manifest.json'));
assertEqual('edge tray manifest center_version', trayManifest.center_version, targetVersion);
assertEqual('edge tray manifest tray_version', trayManifest.tray_version, targetVersion);
for (const [platform, artifact] of Object.entries(trayManifest.platforms || {})) {
  if (!artifact.url?.includes(`e-agent-edge-${targetVersion}-`)) {
    fail(`edge tray ${platform}: url does not include target version ${targetVersion}`);
  } else {
    ok(`edge tray ${platform}: url ${artifact.url}`);
  }
  const artifactFile = publicFileFromUrl(artifact.url);
  if (artifactFile && assertExists(`edge tray ${platform} artifact`, artifactFile)) {
    assertSha256(`edge tray ${platform} artifact`, artifactFile, artifact.sha256);
  }
}

const docsManifest = readJson(path.join(serverRoot, 'public/project-docs/manifest.json'));
assertEqual('project docs manifest version', docsManifest.version, targetVersion);
for (const [label, docUrl] of Object.entries(docsManifest.documents || {})) {
  const docFile = publicFileFromUrl(docUrl);
  if (docFile) {
    assertExists(`project docs ${label}`, docFile);
  }
}
for (const releaseUrl of docsManifest.releases || []) {
  if (!releaseUrl.includes(`${targetVersion}.md`)) {
    fail(`project docs release entry does not include target version: ${releaseUrl}`);
  } else {
    const releaseFile = publicFileFromUrl(releaseUrl);
    if (releaseFile) {
      assertExists('project docs release entry', releaseFile);
    }
  }
}

assertExists('server release notes', path.join(serverRoot, `docs/releases/${targetVersion}.md`));
assertExists('edge release notes', path.join(clientRoot, `docs/releases/${targetVersion}.md`));

for (const file of [
  path.join(repoRoot, '文档/00-核心主文档/01-主需求文档.md'),
  path.join(repoRoot, '文档/00-核心主文档/02-主架构文档.md'),
  path.join(repoRoot, '文档/00-核心主文档/03-主接口文档.md'),
]) {
  const content = readText(file);
  if (!content.includes(`适用产品版本 | ${targetVersion}`)) {
    fail(`${path.relative(repoRoot, file)}: missing master doc target version ${targetVersion}`);
  } else {
    ok(`${path.relative(repoRoot, file)}: target version ${targetVersion}`);
  }
}

assertTextIncludes('edge download page', path.join(serverRoot, 'src/app/edge/download/page.tsx'), [
  'info.tray_version',
  'downloadDmg',
]);
assertTextIncludes(
  'edge download-info api',
  path.join(serverRoot, 'src/app/api/edge/download-info/route.ts'),
  ['resolveTrayDownloadUrl', 'resolveTrayVersion', 'tray_version'],
);
assertTextIncludes('server loading/version surface', path.join(serverRoot, 'src/components/ui/loader.tsx'), [
  'APP_VERSION',
]);

if (failures.length > 0) {
  console.error(`release surface verification failed for ${targetVersion}`);
  for (const item of failures) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log(`release surface verification passed for ${targetVersion}`);
for (const item of checks) {
  console.log(`- ${item}`);
}
