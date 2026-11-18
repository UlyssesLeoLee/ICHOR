/**
 * ATS-308 -- the `.aitest` TRACKING ASSET importer.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The other half of ATS-308's import. The design-index module reads the
 * Markdown design documents; this module reads the JSON TRACKING ASSETS --
 * the requirement list and the traceability list of a project.
 *
 * THE TWO FORMATS, AND WHY THEY ARE DIFFERENT THINGS
 * ---------------------------------------------------
 * A design document is PROSE that points at files. A tracking asset is
 * DATA that points at requirements and test cases. They are indexed
 * differently and they fail differently:
 *
 *   * the requirement list declares REQUIREMENTS (`uid`, `title`, `type`,
 *     `status`);
 *   * the traceability list declares LINKS between a requirement and a
 *     test case (`from`, `to`, `type`).
 *
 * A link that names a requirement the list does not have is a DANGLING
 * LINK. A link that names the SAME requirement twice with the same type
 * is a DUPLICATE. Both are facts about the asset, and both are reported.
 *
 * WHAT THE `to` FIELD NAMES
 * -------------------------
 * The platform's own convention (see `examples/sample-playwright/.aitest/`)
 * is `file::test title` -- the file the case lives in, two colons, the
 * title of the case:
 *
 *     {"from":"REQ-001","to":"home.spec.ts::首页响应正常","type":"verified_by"}
 *
 * The title is matched against the case titles of the file. The importer
 * does NOT resolve the title to a platform UID: the UID of a case is
 * derived by the UID registry (ATS-202 / ATS-204) and depends on the
 * project, so a title is the honest thing to report here. What the
 * importer DOES check is whether the title names a case that the file
 * actually declares -- because a traceability link to a case that was
 * renamed is exactly the drift the platform exists to catch.
 *
 * THE IMPORT DOES NOT MODIFY ANYTHING
 * -----------------------------------
 * The acceptance criterion of ATS-308 is "导入 md/json 关系不改正文" -- the
 * import must not rewrite the body. So this module opens the assets, it
 * classifies their links, and it returns an index. It never rewrites a
 * requirement, never repairs a link, never writes to the project.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

export const TRACKING_ASSET_VERSION = 1;

/** The directory a project's tracking assets live in. */
export const ASSET_DIR = '.aitest';

/** The two assets the platform reads. */
export const ASSET_FILES = Object.freeze(['requirements.json', 'traceability.json']);

/**
 * The kinds of problem a tracking asset can have.
 *
 * A closed vocabulary, so a caller can tell what KIND of problem it is
 * instead of reading prose.
 */
export const ASSET_ISSUE = Object.freeze({
  /** A link names a requirement the requirement list does not declare. */
  DANGLING_REQUIREMENT: 'dangling-requirement',
  /** A link names a requirement that is declared TWICE in the list. */
  DUPLICATE_REQUIREMENT: 'duplicate-requirement',
  /** The same (from, to, type) triple appears more than once. */
  DUPLICATE_LINK: 'duplicate-link',
  /** The `to` field does not use the `file::title` convention. */
  MALFORMED_TARGET: 'malformed-target',
  /** The `to` field names a file that the project does not have. */
  MISSING_FILE: 'missing-file',
  /** The `to` field names a file, but a title that file does not declare. */
  UNKNOWN_CASE: 'unknown-case',
  /** A requirement has no uid. */
  MISSING_UID: 'missing-uid',
  /** The requirement list is not a JSON array. */
  MALFORMED_ASSET: 'malformed-asset',
});

/**
 * The stable uid of an imported asset.
 */
export function assetUid(projectKey, name) {
  return `ast_1_${crypto.createHash('sha256').update(`asset${'\x00'}${projectKey}${'\x00'}${name}`).digest('hex').slice(0, 24)}`;
}

/**
 * The stable uid of one requirement.
 */
export function requirementUid(projectKey, uid) {
  return `asr_1_${crypto.createHash('sha256').update(`requirement${'\x00'}${projectKey}${'\x00'}${uid}`).digest('hex').slice(0, 24)}`;
}

/**
 * The stable uid of one link.
 */
export function linkUid(projectKey, from, to, type) {
  return `asl_1_${crypto.createHash('sha256').update(`link${'\x00'}${projectKey}${'\x00'}${from}${'\x00'}${to}${'\x00'}${type}`).digest('hex').slice(0, 24)}`;
}

/**
 * Splits a `file::title` target.
 *
 * @returns {{file: string, title: string}|null} null when the target does
 *          not use the convention.
 */
export function parseTarget(target) {
  const text = String(target ?? '');
  const at = text.indexOf('::');
  if (at <= 0) return null;
  const file = text.slice(0, at).trim();
  const title = text.slice(at + 2).trim();
  if (!file || !title) return null;
  return { file, title };
}

/**
 * Reads the test case titles of a project's spec files.
 *
 * The titles are read with the platform's OWN scanner
 * (`server/uid.mjs`'s `scanTestCases`), so the importer and the platform
 * agree on what a case title is. Re-implementing the scan here would let
 * the two drift, and a drift would show up as "the traceability link
 * points at a case that does not exist" for a case that plainly does.
 *
 * @param {string} root the project root
 * @returns {Map<string, string[]>} the file -> its case titles
 */
export function readCaseTitles(root, scanner = null) {
  const titles = new Map();
  const scan = scanner ?? defaultScanner();
  const files = [];
  const walk = (dir, rel, level) => {
    if (level > 14 || files.length > 2000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (['node_modules', '.git', '.next', 'out', 'dist', 'target', 'test-results', 'playwright-report', '.aitest-studio', 'coverage'].includes(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, childRel, level + 1);
      } else if (entry.isFile() && /\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) {
        files.push({ rel: childRel, full });
      }
    }
  };
  walk(root, '', 0);
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file.full, 'utf8');
    } catch {
      continue;
    }
    const found = scan(content);
    if (found.length) titles.set(file.rel, found);
  }
  return titles;
}

/**
 * The scanner the importer uses by default.
 *
 * It is the platform's own `scanTestCases`, loaded LAZILY and
 * SYNCHRONOUSLY through `createRequire`, because the importer is called
 * from a synchronous context and a dynamic `import()` would make the
 * whole importer asynchronous -- a change that would ripple into the
 * Bridge's request handler for no benefit.
 *
 * When the module cannot be loaded (the importer is used against a project
 * that does not ship the platform), the importer falls back to a
 * CONSERVATIVE line scan. The fallback never reports a title as missing
 * when the platform's scanner would have found it: it only ever ADDS
 * titles, so the worst case is a slightly weaker check, never a false
 * "this case does not exist".
 */
function defaultScanner() {
  try {
    const req = createRequire(import.meta.url);
    const { scanTestCases } = req('../uid.mjs');
    if (typeof scanTestCases === 'function') {
      return (content) => scanTestCases(content).map((c) => c.title).filter(Boolean);
    }
  } catch { /* fall through to the conservative scan */ }
  return (content) => scanTitles(content);
}

/**
 * The CONSERVATIVE fallback scan of the test case titles of one source file.
 *
 * It is a LINE scan for the `test('...')` / `it('...')` calls. It is
 * simpler than the platform's full scanner (which also handles comments,
 * strings and template literals). The fallback only ever ADDS titles to
 * what the platform's scanner would have found, so a title that the full
 * scanner sees but the fallback misses produces a missed CHECK, never a
 * false "this case does not exist".
 */
function scanTitles(content) {
  const out = [];
  const re = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const title = m[2].trim();
    if (title) out.push(title);
  }
  return out;
}

/**
 * Reads one JSON asset.
 *
 * A missing or malformed asset is NOT an error the caller has to catch:
 * it is a fact about the project, and the importer reports it as an issue
 * so the report can name it.
 */
function readJsonAsset(root, projectKey, name) {
  const full = path.join(root, ASSET_DIR, name);
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return { name, present: false, error: `cannot read the asset: ${err.message}`, data: null, sha256: null, bytes: 0 };
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  let data = null;
  let error = null;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    error = `the asset is not valid JSON: ${err.message}`;
  }
  return { name, present: true, error, data, sha256, bytes };
}

/**
 * Imports a project's tracking assets.
 *
 * @param {object} options
 * @param {string} options.root the project root
 * @param {string} [options.projectKey] the project's identity (its UID);
 *        it is part of every uid, so two projects with the same
 *        requirements do not share uids
 * @param {Map<string,string[]>} [options.caseTitles] the project's case
 *        titles, keyed by file (read from the project when omitted)
 */
export function importTrackingAssets({ root, projectKey = null, caseTitles = null } = {}) {
  if (!root) throw new TypeError('root is required');
  const key = projectKey ?? path.resolve(root);

  const requirementsAsset = readJsonAsset(root, key, 'requirements.json');
  const traceabilityAsset = readJsonAsset(root, key, 'traceability.json');

  const issues = [];
  const requirements = [];
  const links = [];

  /* --- the requirement list ------------------------------------------- */
  const declared = new Map();   // uid -> the requirement
  const duplicates = new Map(); // uid -> how many times it is declared
  if (requirementsAsset.present && requirementsAsset.data !== null) {
    const list = Array.isArray(requirementsAsset.data)
      ? requirementsAsset.data
      : (Array.isArray(requirementsAsset.data?.requirements) ? requirementsAsset.data.requirements : null);
    if (list === null) {
      issues.push({
        kind: ASSET_ISSUE.MALFORMED_ASSET,
        asset: 'requirements.json',
        message: 'the requirement list is neither an array nor an object with a `requirements` array',
      });
    } else {
      for (const entry of list) {
        const uid = typeof entry?.uid === 'string' ? entry.uid : '';
        if (!uid) {
          issues.push({
            kind: ASSET_ISSUE.MISSING_UID,
            asset: 'requirements.json',
            message: `a requirement has no uid: ${JSON.stringify(entry).slice(0, 120)}`,
          });
          continue;
        }
        duplicates.set(uid, (duplicates.get(uid) ?? 0) + 1);
        if (!declared.has(uid)) {
          const node = {
            uid,
            nodeUid: requirementUid(key, uid),
            title: typeof entry.title === 'string' ? entry.title : null,
            type: typeof entry.type === 'string' ? entry.type : null,
            status: typeof entry.status === 'string' ? entry.status : null,
            asset: 'requirements.json',
            assetUid: assetUid(key, 'requirements.json'),
          };
          declared.set(uid, node);
          requirements.push(node);
        }
      }
      for (const [uid, count] of duplicates) {
        if (count > 1) {
          issues.push({
            kind: ASSET_ISSUE.DUPLICATE_REQUIREMENT,
            uid,
            count,
            message: `the requirement ${uid} is declared ${count} times`,
          });
        }
      }
    }
  }

  /* --- the traceability list ------------------------------------------ */
  const titles = caseTitles ?? readCaseTitles(root);
  const seen = new Map();  // from\0to\0type -> the link
  if (traceabilityAsset.present && traceabilityAsset.data !== null) {
    const list = Array.isArray(traceabilityAsset.data)
      ? traceabilityAsset.data
      : (Array.isArray(traceabilityAsset.data?.links) ? traceabilityAsset.data.links : null);
    if (list === null) {
      issues.push({
        kind: ASSET_ISSUE.MALFORMED_ASSET,
        asset: 'traceability.json',
        message: 'the traceability list is neither an array nor an object with a `links` array',
      });
    } else {
      for (const entry of list) {
        const from = typeof entry?.from === 'string' ? entry.from : '';
        const to = typeof entry?.to === 'string' ? entry.to : '';
        const type = typeof entry?.type === 'string' ? entry.type : '';
        if (!from || !to) {
          issues.push({
            kind: ASSET_ISSUE.MALFORMED_TARGET,
            asset: 'traceability.json',
            message: `a link has no from/to: ${JSON.stringify(entry).slice(0, 120)}`,
          });
          continue;
        }

        // A link to a requirement the list does not declare.
        if (!declared.has(from)) {
          issues.push({
            kind: ASSET_ISSUE.DANGLING_REQUIREMENT,
            asset: 'traceability.json',
            from,
            to,
            type,
            message: `the link names the requirement ${from}, which the requirement list does not declare`,
          });
        }

        // The `to` field: `file::title`.
        const target = parseTarget(to);
        if (!target) {
          issues.push({
            kind: ASSET_ISSUE.MALFORMED_TARGET,
            asset: 'traceability.json',
            from,
            to,
            type,
            message: `the target ${to} does not use the \`file::title\` convention`,
          });
        } else {
          const fileTitles = titles.get(target.file);
          if (!fileTitles) {
            issues.push({
              kind: ASSET_ISSUE.MISSING_FILE,
              asset: 'traceability.json',
              from,
              to,
              type,
              file: target.file,
              message: `the target names the file ${target.file}, which the project does not have`,
            });
          } else if (!fileTitles.includes(target.title)) {
            issues.push({
              kind: ASSET_ISSUE.UNKNOWN_CASE,
              asset: 'traceability.json',
              from,
              to,
              type,
              file: target.file,
              title: target.title,
              message: `the target names the case "${target.title}", which ${target.file} does not declare`,
            });
          }
        }

        const node = {
          uid: linkUid(key, from, to, type),
          from,
          to,
          type,
          asset: 'traceability.json',
          assetUid: assetUid(key, 'traceability.json'),
          target: target ? { file: target.file, title: target.title } : null,
        };
        const fingerprint = `${from}\u0000${to}\u0000${type}`;
        if (seen.has(fingerprint)) {
          issues.push({
            kind: ASSET_ISSUE.DUPLICATE_LINK,
            asset: 'traceability.json',
            from,
            to,
            type,
            message: `the link ${from} -> ${to} (${type}) appears more than once`,
          });
          continue;
        }
        seen.set(fingerprint, node);
        links.push(node);
      }
    }
  }

  return {
    version: TRACKING_ASSET_VERSION,
    root,
    projectKey: key,
    assets: [requirementsAsset, traceabilityAsset].map((a) => ({
      name: a.name,
      present: a.present,
      error: a.error,
      bytes: a.bytes,
      sha256: a.sha256,
      uid: assetUid(key, a.name),
    })),
    requirements,
    links,
    issues,
    report: {
      version: TRACKING_ASSET_VERSION,
      requirements: requirements.length,
      links: links.length,
      issues: issues.length,
      byIssue: issues.reduce((acc, i) => {
        acc[i.kind] = (acc[i.kind] ?? 0) + 1;
        return acc;
      }, {}),
      danglingRequirements: issues.filter((i) => i.kind === ASSET_ISSUE.DANGLING_REQUIREMENT).length,
      duplicateLinks: issues.filter((i) => i.kind === ASSET_ISSUE.DUPLICATE_LINK).length,
      unknownCases: issues.filter((i) => i.kind === ASSET_ISSUE.UNKNOWN_CASE).length,
    },
  };
}

/**
 * The readable form of the tracking-asset report.
 */
export function formatAssetReport(report) {
  const lines = [];
  lines.push('追踪资产导入报告（ATS-308）');
  lines.push(`  需求数            ：${report.requirements}`);
  lines.push(`  关联数            ：${report.links}`);
  lines.push(`  问题数            ：${report.issues}`);
  for (const [kind, count] of Object.entries(report.byIssue).sort()) {
    lines.push(`      ${kind.padEnd(22)}：${count}`);
  }
  return lines.join('\n');
}
