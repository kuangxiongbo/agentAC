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

function assertTextExcludes(label, file, forbidden) {
  const content = readText(file);
  for (const item of forbidden) {
    if (content.includes(item)) {
      fail(`${label}: contains stale source contract ${item}`);
    } else {
      ok(`${label}: excludes ${item}`);
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
const trayPackage = readJson(path.join(trayRoot, 'package.json'));
const targetVersion = process.argv[2] || serverPackage.version;
const trayNativeVersion = trayPackage.version;
const licenseSchema = readJson(path.join(serverRoot, 'license-schema.json'));

assertEqual('server package version', serverPackage.version, targetVersion);
assertEqual(
  'edge web package version',
  readJson(path.join(clientRoot, 'package.json')).version,
  targetVersion,
);
ok(`tray package version: ${trayNativeVersion}`);
assertEqual(
  'tauri bundle version',
  readJson(path.join(trayRoot, 'src-tauri/tauri.conf.json')).version,
  trayNativeVersion,
);
assertEqual('license schema appId', licenseSchema.appId, 'mission-control');
for (const entitlement of ['enableHumanWatch', 'enableLocalCliElevation']) {
  const found = Array.isArray(licenseSchema.entitlements)
    && licenseSchema.entitlements.some((item) => item?.key === entitlement);
  if (!found) {
    fail(`license schema missing entitlement ${entitlement}`);
  } else {
    ok(`license schema entitlement: ${entitlement}`);
  }
}

const trayConfigSource = readText(path.join(trayRoot, 'src-tauri/src/config.rs'));
if (!trayConfigSource.includes(`DEFAULT_CLIENT_VERSION: &str = "${targetVersion}"`)) {
  fail(`tray DEFAULT_CLIENT_VERSION must match ${targetVersion}`);
} else {
  ok(`tray DEFAULT_CLIENT_VERSION: ${targetVersion}`);
}

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
assertEqual('edge tray manifest tray_version', trayManifest.tray_version, trayNativeVersion);
for (const [platform, artifact] of Object.entries(trayManifest.platforms || {})) {
  if (!artifact.url?.includes(`e-agent-edge-${trayNativeVersion}-`)) {
    fail(`edge tray ${platform}: url does not include tray version ${trayNativeVersion}`);
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
  'downloadByChipTitle',
  'downloadPlatformButton',
]);
assertTextIncludes(
  'edge download-info api',
  path.join(serverRoot, 'src/app/api/edge/download-info/route.ts'),
  ['resolveTrayDownloadUrl', 'resolveTrayVersion', 'tray_version'],
);
assertTextIncludes('server tray version resolver', path.join(serverRoot, 'src/lib/edge-download.ts'), [
  'APP_VERSION',
  'resolveBundledTrayFromManifest',
]);
assertTextExcludes('server tray version resolver', path.join(serverRoot, 'src/lib/edge-download.ts'), [
  "'2.0.2'",
  '"2.0.2"',
]);
assertTextIncludes('server login build label', path.join(serverRoot, 'src/app/login/page.tsx'), [
  'APP_VERSION',
  'NEXT_PUBLIC_MC_BUILD_LABEL',
]);
assertTextExcludes('server login build label', path.join(serverRoot, 'src/app/login/page.tsx'), [
  "'2.0.2'",
  '"2.0.2"',
]);
assertTextIncludes(
  'edge provision tray runtime api',
  path.join(clientRoot, 'src/app/api/edge/provision-tray-runtime/route.ts'),
  ['APP_VERSION', 'VERSION'],
);
assertTextExcludes(
  'edge provision tray runtime api',
  path.join(clientRoot, 'src/app/api/edge/provision-tray-runtime/route.ts'),
  ["'2.0.2'", '"2.0.2"'],
);
assertTextIncludes('server loading/version surface', path.join(serverRoot, 'src/components/ui/loader.tsx'), [
  'APP_VERSION',
]);
assertTextIncludes('edge loading/version surface', path.join(clientRoot, 'src/components/ui/loader.tsx'), [
  'APP_VERSION',
]);
assertTextIncludes('server nav version surface', path.join(serverRoot, 'src/components/layout/nav-rail.tsx'), [
  'APP_VERSION',
]);
assertTextIncludes('edge nav version surface', path.join(clientRoot, 'src/components/layout/nav-rail.tsx'), [
  'APP_VERSION',
]);
assertTextIncludes('tray runtime update logic', path.join(trayRoot, 'src-tauri/src/runtime.rs'), [
  'fetch_manifest(cfg)',
  'runtime 版本需要更新',
  'let target_version = manifest.client_version.clone()',
  'clear_cached_manifest',
]);
assertTextIncludes('tray supervisor runtime update loop', path.join(trayRoot, 'src-tauri/src/supervisor.rs'), [
  'RUNTIME_UPDATE_CHECK_INTERVAL',
  'runtime_update_target',
  'process::stop()',
  'runtime::ensure_runtime(&cfg)',
]);
assertTextIncludes('license verifier app id', path.join(serverRoot, 'src/lib/license-verifier.ts'), [
  "'mission-control'",
  'app_id: LICENSE_APP_ID',
  'client_id: LICENSE_APP_ID',
]);
assertTextIncludes('1Panel compose image tag', path.join(serverRoot, 'deploy/docker-compose.1panel.yml'), [
  `agentcenter:${targetVersion}`,
]);
for (const deployDoc of ['deploy/README.md', 'deploy/EDGE-RUNTIME.md']) {
  const content = readText(path.join(serverRoot, deployDoc));
  if (content.includes('agentcenter:2.0.1')) {
    fail(`${deployDoc}: contains stale agentcenter:2.0.1 reference`);
  } else {
    ok(`${deployDoc}: no stale agentcenter:2.0.1 reference`);
  }
}
assertTextExcludes('docker buildx script', path.join(serverRoot, 'scripts/docker-buildx-multiarch.sh'), [
  'agentcenter:2.0.1',
]);
assertTextIncludes('server mcp server info', path.join(serverRoot, 'scripts/mc-mcp-server.cjs'), [
  `version: '${targetVersion}'`,
]);
assertTextIncludes('edge mcp server info', path.join(clientRoot, 'scripts/mc-mcp-server.cjs'), [
  `version: '${targetVersion}'`,
]);
assertTextExcludes('edge runtime deploy doc', path.join(serverRoot, 'deploy/EDGE-RUNTIME.md'), [
  'client-runtime-2.0.1',
  'e-agent-edge-2.0.1',
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
