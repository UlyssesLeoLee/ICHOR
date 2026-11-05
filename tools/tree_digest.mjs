#!/usr/bin/env node
/**
 * ATS-102 -- reproducible digest of an installed dependency tree.
 *
 * "The lockfile is reproducible" is only a claim until two independent
 * installs can be compared by a digest that a third party can recompute.
 * This tool computes that digest, and its recipe is stated in full below so
 * that the number in the documentation can be recomputed by hand:
 *
 *   For every regular file under the tree root:
 *     1. compute the file's sha256 of its RAW bytes, as hex
 *     2. build the line  <relative-posix-path> NUL <hex-digest>
 *   Sort the lines by the relative path (byte order, i.e. plain ASCII sort).
 *   Join the lines with LF, append a final LF, and take the sha256 of the
 *   result. That is the tree digest.
 *
 * Two properties matter and are the reason the recipe is written this way:
 *
 *   - **Path independence.** Only paths RELATIVE to the tree root take part,
 *     so the digest does not change when the repository is cloned into a
 *     different directory. (An absolute-path recipe would make the digest
 *     depend on the checkout location and therefore prove nothing.)
 *   - **Content sensitivity.** Every file's raw bytes are hashed, so a
 *     changed dependency version, a swapped tarball or a patched file all
 *     change the digest.
 *
 * Usage:
 *   node tools/tree_digest.mjs <tree-root>              # digest every file
 *   node tools/tree_digest.mjs <tree-root> --package-json-only
 *                                                        # digest only the
 *                                                        # package.json files
 *   node tools/tree_digest.mjs --check <tree-root>      # compare against the
 *                                                        # recorded digest
 *   node tools/tree_digest.mjs <tree-root> --manifest <file>
 *                                                        # write the per-file
 *                                                        # digest list
 *
 * Exit code 0 on success, 1 if the tree root does not exist or the digest
 * does not match the recorded value.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const PACKAGE_JSON_ONLY = argv.includes('--package-json-only');
const treeRoot = argv.find((a) => !a.startsWith('--'));
const manifestIndex = argv.indexOf('--manifest');
const MANIFEST_OUT = manifestIndex >= 0 ? argv[manifestIndex + 1] : null;

if (!treeRoot) {
  console.error('usage: node tools/tree_digest.mjs [--check] <tree-root> [--package-json-only]');
  process.exit(2);
}

const root = path.resolve(treeRoot);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`${treeRoot}: not a directory`);
  process.exit(1);
}

/**
 * Collect every regular file under the root, as (relative posix path, bytes).
 * Symlinks are not followed: node_modules can contain them, and resolving
 * them would make the digest depend on link targets rather than on the tree.
 */
function collect(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (PACKAGE_JSON_ONLY && path.basename(rel) !== 'package.json') continue;
      acc.push(rel);
    }
  }
  return acc;
}

/**
 * The digest of one file, read as a STREAM rather than buffered whole.
 *
 * Buffering every file at once is what the first version of this tool did,
 * and it died with "RangeError: Array buffer allocation failed" on a large
 * tree -- an installed tree here is ~17000 files and the machine was under
 * memory pressure. Hashing per file and keeping only the hex digest means
 * peak memory is one file, not one tree.
 */
function hashFile(full) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(full, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    for (;;) {
      const bytes = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytes <= 0) break;
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const files = collect(root, []);
files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const lines = files.map(
  (rel) => `${rel}\0${hashFile(path.join(root, ...rel.split('/')))}`,
);

const treeDigest = crypto
  .createHash('sha256')
  .update(lines.length ? `${lines.join('\n')}\n` : '')
  .digest('hex');

console.log(`tree root      : ${root}`);
console.log(`scope          : ${PACKAGE_JSON_ONLY ? 'package.json files only' : 'all files'}`);
console.log(`file count     : ${files.length}`);
console.log(`tree sha256    : ${treeDigest}`);

/**
 * The per-file digest list. It is what makes a mismatch diagnosable: the
 * tree digest alone would leave a reviewer comparing 17000+ files by hand.
 */
if (MANIFEST_OUT) {
  fs.writeFileSync(MANIFEST_OUT, `${lines.join('\n')}\n`, 'utf8');
  console.log(`manifest       : ${MANIFEST_OUT}`);
}

/**
 * The recorded digests live in a plain text file next to this tool, so that
 * the build gate and the documentation quote the SAME value instead of two
 * copies that can drift apart.
 */
// `new URL(import.meta.url).pathname` is PERCENT-ENCODED, so a repository
// path containing a space (or any non-ASCII character) came out as
// `.../sp%20ace/...` and the file was never found. `fileURLToPath` decodes
// the URL into a real filesystem path.
const EXPECTED_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'installed-tree-digests.txt',
);

const scope = PACKAGE_JSON_ONLY ? 'package-json' : 'all-files';
const platform = `${process.platform}-${process.arch}`;

/**
 * The npm version on the PATH, i.e. the npm that `npm ci` runs with.
 *
 * The recorded digest depends on this version: npm 10.9.9 and npm 12.2.0
 * install different sets of optional packages from the same lockfile. The
 * digest check therefore compares the recorded value against the entry for
 * THIS npm version, and says so when the recorded value came from a
 * different one.
 *
 * The version is read by running the npm on the PATH, not by reading the npm
 * next to `process.execPath`: the tree was installed by the npm on the PATH,
 * and that is the npm this check must report.
 *
 * On Windows `npm` is a `.cmd` shim, so it cannot be launched directly: the
 * OS only starts it through cmd.exe. The command is therefore run as
 * `cmd /c npm --version` WITHOUT `shell: true`, because a shell that
 * concatenates its arguments unescaped is deprecated in Node (DEP0190) and
 * would re-split the version string. `cmd /c` takes the whole remainder as
 * one command line, so nothing is re-split.
 */
function npmVersion() {
  const cmd = process.platform === 'win32'
    ? { file: 'cmd', args: ['/c', 'npm --version'] }
    : { file: 'npm', args: ['--version'] };
  const res = spawnSync(cmd.file, cmd.args, { encoding: 'utf8', shell: false });
  return (res.stdout || '').trim() || 'unknown';
}

if (!CHECK) {
  // Nothing to compare against: the digest was just measured and printed.
} else if (!fs.existsSync(EXPECTED_FILE)) {
  console.error(`recorded digests file not found: ${EXPECTED_FILE}`);
  process.exit(1);
} else {
  const recorded = fs
    .readFileSync(EXPECTED_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    // The file is column-aligned for readability, so the fields are split on
    // runs of whitespace rather than on a single space.
    .map((l) => l.split(/\s+/));

  /**
   * The digest is platform-dependent: the lockfile declares platform-specific
   * optional packages and npm installs only the ones matching this host. So the
   * recorded value is looked up per (scope, platform). A platform with no
   * recorded value is a skip, not a failure -- there is nothing to compare
   * against, and inventing one here would be wrong.
   */
  const forPlatform = recorded.filter((f) => f[0] === scope && f[1] === platform);
  const actualNpm = npmVersion();

  if (!forPlatform.length) {
    console.log(
      `digest: no recorded value for scope "${scope}" on platform "${platform}" -- skipped.`,
    );
    console.log(
      `Record one with: node tools/tree_digest.mjs <tree-root>${PACKAGE_JSON_ONLY ? ' --package-json-only' : ''}`,
    );
  } else {
    // The third column is the npm version that produced the recorded value.
    // Entries for the SAME platform but a DIFFERENT npm version are kept
    // separate, because the digest is a property of (tree, npm version).
    const entries = forPlatform.map((f) => ({
      npm: /^\d+\.\d+\.\d+/.test(f[2] || '') ? f[2] : null,
      digest: /^\d+\.\d+\.\d+/.test(f[2] || '') ? f[3] : f[2],
    }));
    const forThisNpm = entries.find((e) => e.npm === actualNpm);
    const entry = forThisNpm || entries[0];

    if (entry.digest === treeDigest) {
      console.log(`digest ok: ${scope} ${platform} = ${treeDigest}`);
    } else {
      // Every recorded value for this platform is listed, so the reader can
      // see whether a recorded digest for THIS npm version exists at all.
      const recordedLines = entries
        .map((e) => `  npm ${e.npm || '(unknown)'} -> ${e.digest}`)
        .join('\n');
      console.error(
        `installed tree digest mismatch for scope "${scope}" on platform "${platform}":\n` +
          `  expected ${entry.digest}\n` +
          `  actual   ${treeDigest}\n` +
          `  files    ${files.length}\n` +
          `  npm      ${actualNpm} (the npm on PATH)\n` +
          `\nrecorded values for this platform:\n${recordedLines}\n` +
          (forThisNpm
            ? ''
            : `\nThere is no recorded value for npm ${actualNpm}. The recorded digest was\n` +
              `produced by npm ${entry.npm}, and the npm on PATH is npm ${actualNpm}.\n` +
              `The two install different sets of optional packages from the same\n` +
              `lockfile, so the trees differ and the digests cannot match.\n` +
              `Use npm ${entry.npm} to reproduce the recorded tree.\n`) +
          'The installed tree does not match the tree the recorded digest describes.\n' +
          'Two things change that tree:\n' +
          '  - the npm version: npm 10.9.9 and npm 12.2.0 install different sets of\n' +
          '    optional packages from the same lockfile;\n' +
          '  - the lockfiles themselves: a dependency change moves the digest.\n' +
          'The build gate pins the npm version in its `checknode` step, so if that\n' +
          'step passed, compare the lockfiles against the recorded value.\n' +
          'To locate the differing files, write a manifest for each tree and diff them:\n' +
          '  node tools/tree_digest.mjs <tree> --manifest <file>',
      );
      process.exit(1);
    }
  }
}
