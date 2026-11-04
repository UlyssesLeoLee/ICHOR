#!/usr/bin/env node
/**
 * ATS-102 -- generate the dependency manifest (依赖清单) for the shipped tree.
 *
 * The manifest is derived from the COMMITTED lockfiles, not from a live
 * node_modules, so it describes exactly what `npm ci` would install and it can
 * be regenerated on a machine that never ran an install.
 *
 * Two facts are recorded for every dependency:
 *
 *   - the pinned version, the resolved tarball URL and the integrity hash
 *     (the value npm verifies on install). This part comes from the lockfile
 *     and is therefore deterministic.
 *   - the licence the package publishes, plus the SPDX id when the package
 *     declares one. This part comes from the npm registry metadata, NOT from
 *     the installed tree, because the installed tree only contains the
 *     platform-specific optional binaries of the current OS. Sourcing it from
 *     the registry keeps the manifest identical on every platform, which is
 *     what makes `--check` meaningful in CI.
 *
 * Licences already recorded in the committed manifest are reused as-is, so a
 * regeneration needs no network. `--refresh-licences` forces a fresh registry
 * lookup, which is how the licence data is (re)built.
 *
 * Licences that require a legal review before a closed-source commercial
 * distribution are flagged (ADR-008). The flag is a REVIEW marker, not a
 * licence classification: the licence id itself is always the one the package
 * publishes.
 *
 * Output: docs/dependencies/dependency-manifest.json  (machine readable)
 *         docs/dependencies/dependency-manifest.md    (human readable)
 *
 * Usage:
 *   node tools/gen_dep_manifest.mjs                    # write both files
 *   node tools/gen_dep_manifest.mjs --refresh-licences # re-query the registry
 *   node tools/gen_dep_manifest.mjs --check            # verify the committed
 *                                                    # manifest matches the
 *                                                    # lockfiles; exit 1 on drift
 *   node tools/gen_dep_manifest.mjs --json             # print JSON to stdout
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'dependencies');
const JSON_OUT = path.join(OUT_DIR, 'dependency-manifest.json');
const MD_OUT = path.join(OUT_DIR, 'dependency-manifest.md');

/**
 * The npm projects of this repository. Each entry names the directory that
 * carries its own package.json / package-lock.json.
 */
const PROJECTS = [
  { id: 'root', dir: '.', label: 'Node Bridge (server/)' },
  { id: 'studio', dir: 'apps/studio', label: 'Next.js 16 Studio UI' },
];

/**
 * Licences that are known to require a legal review before a closed-source
 * commercial distribution. This is the ADR-008 concern.
 *
 * Two tiers are distinguished, because they carry different obligations:
 *
 *   - `strong` (AGPL/GPL/SSPL/BUSL/Elastic/Commons-Clause): copyleft or
 *     source-available terms that can oblige disclosure of the combined
 *     work, or forbid it outright.
 *   - `weak` (LGPL/MPL/EPL/CDDL): weak copyleft -- the obligation is
 *     usually confined to the library itself, but the exact duty (dynamic vs
 *     static linking, whether the binary must be relinkable, whether notices
 *     must travel) depends on how the package is used, so it still needs a
 *     human decision rather than an automated one.
 *   - `attribution` (CC-BY-*): attribution and notice obligations.
 *
 * The flag is a REVIEW marker, not a licence classification: the licence id
 * itself is always the one the package publishes.
 */
const REVIEW_LICENCES = {
  strong: new Set([
    'AGPL-1.0-only', 'AGPL-1.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
    'GPL-1.0-only', 'GPL-1.0-or-later', 'GPL-2.0-only', 'GPL-2.0-or-later',
    'GPL-3.0-only', 'GPL-3.0-or-later',
    'SSPL-1.0', 'BUSL-1.1', 'Elastic-2.0', 'Commons-Clause',
  ]),
  weak: new Set([
    'LGPL-2.0-only', 'LGPL-2.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
    'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MPL-1.1', 'MPL-2.0',
    'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'CDDL-1.1',
  ]),
  attribution: new Set([
    'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0',
  ]),
};

const REGISTRY = process.env.ATS_NPM_REGISTRY || 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 20000;
const FETCH_CONCURRENCY = 8;

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const REFRESH = argv.includes('--refresh-licences');
const TO_STDOUT = argv.includes('--json');

/** Read a lockfile and return its `packages` map. */
function readLock(project) {
  const lockPath = path.join(REPO_ROOT, project.dir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    throw new Error(`${project.dir}/package-lock.json is missing -- the lockfiles must be committed before the manifest can be generated`);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  return { lock, lockPath };
}

/**
 * Normalise the many shapes of a licence declaration into a single string.
 * The registry returns a string; the installed package.json may return a
 * string, an object with `type`, or an array.
 */
function licenceOf(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (Array.isArray(raw)) {
    const parts = raw.map(licenceOf).filter(Boolean);
    return parts.length ? parts.join(' OR ') : null;
  }
  if (typeof raw === 'object') {
    if (typeof raw.type === 'string') return raw.type.trim() || null;
    if (Array.isArray(raw.type)) return licenceOf(raw.type);
  }
  return null;
}

/**
 * Classify a licence expression for the review marker.
 *
 * The expression may use OR / AND / parentheses, so every licence id token
 * in it is examined. The strongest tier found wins, because a package under
 * "Apache-2.0 AND LGPL-3.0-or-later" carries both obligations.
 */
function reviewTier(expression) {
  if (!expression) return null;
  const tokens = expression.match(/[A-Za-z0-9.+-]+/g) || [];
  const ids = tokens.filter((t) => /[A-Za-z]/.test(t));
  if (ids.some((t) => REVIEW_LICENCES.strong.has(t))) return 'strong';
  if (ids.some((t) => REVIEW_LICENCES.weak.has(t))) return 'weak';
  if (ids.some((t) => REVIEW_LICENCES.attribution.has(t))) return 'attribution';
  return null;
}

/**
 * The licences already recorded in the committed manifest, keyed by
 * `name@version`. Reusing them keeps a regeneration offline and deterministic.
 */
function loadCommittedLicences() {
  if (!fs.existsSync(JSON_OUT)) return new Map();
  try {
    const manifest = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8'));
    const map = new Map();
    for (const project of manifest.projects || []) {
      for (const p of project.packages || []) {
        if (p.licence && p.licence !== 'UNKNOWN') map.set(`${p.name}@${p.version}`, p);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Fetch one package's registry metadata. Returns null when unavailable. */
async function fetchMeta(name, version) {
  const url = `${REGISTRY}/${name}/${version}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      licence: licenceOf(body.license) ?? licenceOf(body.licenses),
      spdx: typeof body.sbomId === 'string' && body.sbomId ? body.sbomId : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up the licence of every package the committed manifest does not
 * already cover. Runs with bounded concurrency.
 */
async function fetchMissingLicences(needed) {
  const out = new Map();
  if (!needed.length) return out;
  const queue = [...needed];
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const key = queue.shift();
      if (!key) return;
      const at = key.lastIndexOf('@');
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      out.set(key, await fetchMeta(name, version));
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Build the manifest for one project from its lockfile.
 */
function collect(project, committed, fetched) {
  const { lock, lockPath } = readLock(project);
  const lockRel = path.relative(REPO_ROOT, lockPath).replace(/\\/g, '/');

  const declared = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, project.dir, 'package.json'), 'utf8'),
  );
  const directNames = new Set([
    ...Object.keys(declared.dependencies || {}),
    ...Object.keys(declared.devDependencies || {}),
  ]);

  const packages = [];
  for (const [location, meta] of Object.entries(lock.packages || {})) {
    // location "" is the project itself; "node_modules/x" is a dependency.
    if (!location) continue;
    const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!meta.version) continue;

    const key = `${name}@${meta.version}`;
    const known = committed.get(key);
    const fetchedMeta = fetched.get(key);
    const licence = (fetchedMeta && fetchedMeta.licence) || (known && known.licence) || null;
    const spdx = (fetchedMeta && fetchedMeta.spdx) || (known && known.spdx) || null;

    packages.push({
      name,
      version: meta.version,
      direct: directNames.has(name),
      dev: Boolean(meta.dev),
      optional: Boolean(meta.optional),
      licence: licence || 'UNKNOWN',
      spdx: spdx || null,
      resolved: meta.resolved || null,
      integrity: typeof meta.integrity === 'string' ? meta.integrity : null,
      licenseReviewRequired: reviewTier(licence),
    });
  }

  packages.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));

  const withLicence = packages.filter((p) => p.licence !== 'UNKNOWN').length;
  return {
    id: project.id,
    label: project.label,
    directory: project.dir,
    lockfile: lockRel,
    lockfileVersion: lock.lockfileVersion,
    declaredDependencies: {
      dependencies: declared.dependencies || {},
      devDependencies: declared.devDependencies || {},
    },
    counts: {
      total: packages.length,
      direct: packages.filter((p) => p.direct).length,
      devOnly: packages.filter((p) => p.dev).length,
      optional: packages.filter((p) => p.optional).length,
      licenceKnown: withLicence,
      licenceUnknown: packages.length - withLicence,
      licenseReviewRequired: packages.filter((p) => p.licenseReviewRequired).length,
      licenseReviewStrong: packages.filter((p) => p.licenseReviewRequired === 'strong').length,
      licenseReviewWeak: packages.filter((p) => p.licenseReviewRequired === 'weak').length,
      licenseReviewAttribution: packages.filter((p) => p.licenseReviewRequired === 'attribution').length,
    },
    packages,
  };
}

/** The SHA-256 of the lockfile, so the manifest states which lock it describes. */
function lockDigest(project) {
  const { lockPath } = readLock(project);
  return crypto.createHash('sha256')
    .update(fs.readFileSync(lockPath))
    .digest('hex');
}

/** Every `name@version` the lockfiles pin. */
function allKeys() {
  const keys = [];
  for (const project of PROJECTS) {
    const { lock } = readLock(project);
    for (const [location, meta] of Object.entries(lock.packages || {})) {
      if (!location || !meta.version) continue;
      const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
      keys.push(`${name}@${meta.version}`);
    }
  }
  return [...new Set(keys)];
}

/** Assemble the whole manifest. */
async function build() {
  const committed = loadCommittedLicences();
  const keys = allKeys();

  // Only the packages the committed manifest does not already cover need a
  // registry lookup; --refresh-licences forces every one of them.
  const needed = REFRESH ? keys : keys.filter((k) => !committed.has(k));
  const fetched = await fetchMissingLicences(needed);

  const projects = PROJECTS.map((p) => collect(p, committed, fetched));
  const all = projects.flatMap((p) => p.packages);

  const licenceCounts = new Map();
  for (const p of all) licenceCounts.set(p.licence, (licenceCounts.get(p.licence) || 0) + 1);

  return {
    schema: 'ai-test-studio/dependency-manifest/1',
    // Where the licence data came from: the npm registry metadata (not the
    // installed tree, which is platform-dependent).
    licenceSource: 'npm-registry-metadata',
    node: {
      required: '>=22',
      note: 'The engines field of the root package.json is the single source of truth for the Node version.',
    },
    totals: {
      projects: projects.length,
      packages: all.length,
      licenceKnown: all.filter((p) => p.licence !== 'UNKNOWN').length,
      licenceUnknown: all.filter((p) => p.licence === 'UNKNOWN').length,
      licenseReviewRequired: all.filter((p) => p.licenseReviewRequired).length,
      licenseReviewStrong: all.filter((p) => p.licenseReviewRequired === 'strong').length,
      licenseReviewWeak: all.filter((p) => p.licenseReviewRequired === 'weak').length,
      licenseReviewAttribution: all.filter((p) => p.licenseReviewRequired === 'attribution').length,
    },
    licenceDistribution: [...licenceCounts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([licence, count]) => ({ licence, count })),
    projects: projects.map((p) => ({
      ...p,
      lockfileSha256: lockDigest(PROJECTS.find((x) => x.id === p.id)),
    })),
  };
}

/** Render the human-readable summary. */
function renderMarkdown(manifest) {
  const lines = [];
  lines.push('# 依赖清单 / Dependency Manifest');
  lines.push('');
  lines.push('> 本文件由 `tools/gen_dep_manifest.mjs` 从**已提交的 lockfile** 生成，请勿手工编辑。');
  lines.push('> 重新生成：`node tools/gen_dep_manifest.mjs`；校验漂移：`node tools/gen_dep_manifest.mjs --check`。');
  lines.push('');
  lines.push(`- 许可数据来源：npm registry 元数据（\`${manifest.licenceSource}\`），非本机 \`node_modules\`——因此清单在各平台一致`);
  lines.push(`- 依赖总数：**${manifest.totals.packages}**（直接依赖 ${manifest.projects.reduce((n, p) => n + p.counts.direct, 0)}）`);
  lines.push(`- 许可已知：**${manifest.totals.licenceKnown}**；许可未知：**${manifest.totals.licenceUnknown}**`);
  lines.push(`- 需法务复核的许可：**${manifest.totals.licenseReviewRequired}**`
    + `（强 copyleft ${manifest.totals.licenseReviewStrong}，弱 copyleft ${manifest.totals.licenseReviewWeak}，署名义务 ${manifest.totals.licenseReviewAttribution}）`);
  lines.push('');
  lines.push('## 许可分布');
  lines.push('');
  lines.push('| 许可 | 依赖数 |');
  lines.push('|---|---|');
  for (const row of manifest.licenceDistribution) lines.push(`| ${row.licence} | ${row.count} |`);
  lines.push('');
  for (const project of manifest.projects) {
    lines.push(`## ${project.label}（\`${project.directory}\`）`);
    lines.push('');
    lines.push(`- lockfile：\`${project.lockfile}\`（lockfileVersion ${project.lockfileVersion}）`);
    lines.push(`- lockfile SHA-256：\`${project.lockfileSha256}\``);
    lines.push(`- 依赖 ${project.counts.total}（直接 ${project.counts.direct}，dev ${project.counts.devOnly}，可选 ${project.counts.optional}）`);
    lines.push(`- 许可已知 ${project.counts.licenceKnown} / 未知 ${project.counts.licenceUnknown}；需法务复核 ${project.counts.licenseReviewRequired}`
      + `（强 ${project.counts.licenseReviewStrong}，弱 ${project.counts.licenseReviewWeak}，署名 ${project.counts.licenseReviewAttribution}）`);
    if (project.counts.total === 0) {
      lines.push('');
      lines.push('本项目**无第三方依赖**：Node Bridge 只用 Node 内置模块，测试用内置 `node:test`。');
      continue;
    }
    lines.push('');
    lines.push('| 依赖 | 版本 | 类别 | 许可 | SPDX | 需复核 | integrity (sha512 末 16 位) |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const p of project.packages) {
      const kind = p.direct ? (p.dev ? '直接(dev)' : '直接') : (p.dev ? '传递(dev)' : '传递');
      const spdx = p.spdx || '—';
      const review = p.licenseReviewRequired ? `**${p.licenseReviewRequired}**` : '否';
      const integ = p.integrity ? p.integrity.slice(-16) : '—';
      lines.push(`| \`${p.name}\` | ${p.version} | ${kind} | ${p.licence} | ${spdx} | ${review} | \`${integ}\` |`);
    }
  }
  lines.push('');
  lines.push('## 说明');
  lines.push('');
  lines.push('- 本清单只记录**本仓库自身**的依赖。被测项目的依赖不在此范围内。');
  lines.push('- `integrity` 取自 lockfile，即 npm 安装时校验的哈希；完整值见 `dependency-manifest.json`。');
  lines.push('- 标为「可选」的条目是各平台的原生二进制（如 `@next/swc-*`、`@img/sharp-*`），只有对应平台才会安装。');
  lines.push('- 「需复核」列给出的是**复核等级**：`strong`（AGPL/GPL/SSPL/BUSL/Elastic/Commons-Clause，强 copyleft 或源码可得）、`weak`（LGPL/MPL/EPL/CDDL，弱 copyleft）、`attribution`（CC-BY-*，署名义务）。等级只表示「须由人确认」，不表示该许可禁止本产品的用法。');
  lines.push('- SPDX 列多数为「—」：这些包在 `package.json` 与 registry 元数据中均未声明 `sbomId`，因此**无法给出 SPDX 标识**。清单如实记录该缺失，不以推测值填充。');
  lines.push('- 本清单覆盖 NFR-012 所要求的 SPDX 依赖清单与分发审计的**数据基础**；正式发行前的审计结论本身仍属未完成项（见 `docs/16-BASELINE-ADR.md` §7）。');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const manifest = await build();
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const md = renderMarkdown(manifest);

  if (TO_STDOUT) {
    process.stdout.write(json);
    return;
  }

  if (CHECK_ONLY) {
    const problems = [];
    for (const [file, expected] of [[JSON_OUT, json], [MD_OUT, md]]) {
      if (!fs.existsSync(file)) {
        problems.push(`${path.relative(REPO_ROOT, file)} is missing`);
        continue;
      }
      const actual = fs.readFileSync(file, 'utf8');
      if (actual !== expected) {
        problems.push(`${path.relative(REPO_ROOT, file)} differs from the lockfile-derived content`);
      }
    }
    const unknown = manifest.totals.licenceUnknown;
    if (unknown) problems.push(`${unknown} package(s) have an UNKNOWN licence -- run with --refresh-licences`);
    if (problems.length) {
      console.error('RESULT: MISMATCH -- the committed dependency manifest does not match the lockfiles:');
      for (const p of problems) console.error(`  ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log('RESULT: OK -- the committed dependency manifest matches the lockfiles.');
    console.log(`  packages=${manifest.totals.packages} licenceKnown=${manifest.totals.licenceKnown} reviewRequired=${manifest.totals.licenseReviewRequired}`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(JSON_OUT, json, 'utf8');
  fs.writeFileSync(MD_OUT, md, 'utf8');
  console.log(`wrote ${path.relative(REPO_ROOT, JSON_OUT)} and ${path.relative(REPO_ROOT, MD_OUT)}`);
  console.log(`  packages=${manifest.totals.packages} licenceKnown=${manifest.totals.licenceKnown} licenceUnknown=${manifest.totals.licenceUnknown} reviewRequired=${manifest.totals.licenseReviewRequired}`);
}

await main();
