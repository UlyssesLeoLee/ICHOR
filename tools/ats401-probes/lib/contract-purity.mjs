/**
 * ATS-401 -- contract purity detector (mechanism #1).
 *
 * The Agent contract layer must not contain any I/O capability. This module
 * is the machine check that guards that property. It is deliberately written
 * as a **pure function over source text** so that the negative control can
 * feed it a deliberately broken copy of the same source and prove the
 * detector is not vacuously true.
 *
 * SCOPE OF THE GUARANTEE -- read this before quoting the result:
 *
 *   This is a **static check on the contract layer's own source**. It proves
 *   the source contains no I/O call. It does NOT prove the code is physically
 *   incapable of I/O: Node exposes `fetch`, `process`, `globalThis`,
 *   `process.getBuiltinModule`, dynamic `import()` and `require` to every
 *   module without any import statement, so a source that avoided those
 *   spellings could still perform I/O. Real isolation (module sandboxing,
 *   read-only mounts, a child-process sandbox) is a platform-side concern
 *   and is out of scope for ATS-401.
 *
 * What the detector covers:
 *   - static imports of I/O-capable builtins (single- and double-quoted);
 *   - dynamic `import('...')` of I/O-capable builtins;
 *   - `require('...')` of I/O-capable builtins;
 *   - `process.getBuiltinModule('...')` of I/O-capable builtins;
 *   - the globals `fetch`, `WebSocket`, `XMLHttpRequest`;
 *   - the global objects `process`, `globalThis`, `global`.
 *
 * A match is reported as a finding; the caller decides how to react.
 */

/**
 * Builtins that can touch the filesystem, the network or the process table.
 * `node:crypto` and `node:path` are deliberately absent -- they are the only
 * two modules the contract layer is allowed to import.
 */
export const FORBIDDEN_MODULES = Object.freeze([
  'node:fs', 'node:fs/promises', 'fs', 'node:fs/promises',
  'node:child_process', 'child_process',
  'node:net', 'node:http', 'node:https', 'node:dgram', 'node:tls',
  'node:worker_threads', 'node:vm', 'node:module',
  'node:os', 'node:process',
]);

/** The only modules the contract layer may import. */
export const ALLOWED_MODULES = Object.freeze(['node:crypto', 'node:path']);

/** Global functions/objects that provide I/O without any import. */
export const FORBIDDEN_GLOBALS = Object.freeze([
  'fetch', 'WebSocket', 'XMLHttpRequest', 'process', 'globalThis', 'global',
  // 动态代码求值：与 I/O 一样可以绕过静态 import 限制（eval("require('node:fs')")）。
  'eval', 'Function',
]);

/**
 * Scan the source once and return two views of it:
 *
 *   codeWithStrings -- comments removed, string/template literals kept intact.
 *                      Used to extract module specifiers, which live inside
 *                      string literals and would be lost if the literals were
 *                      blanked out.
 *   codeOnly        -- comments AND string/template literals removed.
 *                      Used to look for forbidden globals, which must not be
 *                      reported just because the word appears inside a message
 *                      string or a comment.
 *
 * The scanner is a conservative approximation, not a parser: it is good
 * enough to keep the detector from crying wolf over the contract layer's own
 * Chinese comments and error messages, which is where a naive regex scanner
 * would produce false positives.
 */
function scanSource(source) {
  let codeWithStrings = '';
  let codeOnly = '';
  let i = 0;
  const n = source.length;
  let mode = 'code'; // code | line-comment | block-comment | single | double | template
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line-comment'; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block-comment'; i += 2; continue; }
      if (c === "'") { mode = 'single'; codeWithStrings += c; codeOnly += ' '; i += 1; continue; }
      if (c === '"') { mode = 'double'; codeWithStrings += c; codeOnly += ' '; i += 1; continue; }
      if (c === '`') { mode = 'template'; codeWithStrings += c; codeOnly += ' '; i += 1; continue; }
      codeWithStrings += c;
      codeOnly += c;
      i += 1;
      continue;
    }
    if (mode === 'line-comment') {
      if (c === '\n') { mode = 'code'; codeWithStrings += '\n'; codeOnly += '\n'; }
      i += 1;
      continue;
    }
    if (mode === 'block-comment') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      if (c === '\n') { codeWithStrings += '\n'; codeOnly += '\n'; }
      i += 1;
      continue;
    }
    // string / template literal: kept in codeWithStrings, blanked in codeOnly
    if (c === '\\') {
      codeWithStrings += source.slice(i, i + 2);
      codeOnly += '  ';
      i += 2;
      continue;
    }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code';
      codeWithStrings += c;
      codeOnly += ' ';
      i += 1;
      continue;
    }
    if (c === '\n') { codeWithStrings += '\n'; codeOnly += '\n'; }
    else codeWithStrings += c;
    i += 1;
  }
  return { codeWithStrings, codeOnly };
}

/**
 * Every module specifier the source imports, by any of the four spellings:
 * `import x from 'm'`, `import 'm'`, `import('m')`, `require('m')`,
 * `process.getBuiltinModule('m')`.
 */
export function importedModulesOf(source) {
  const { codeWithStrings } = scanSource(source);
  const found = new Set();
  const patterns = [
    // import ... from 'm'  /  import 'm'
    /\bimport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    // dynamic import('m')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // require('m')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // process.getBuiltinModule('m')
    /\bgetBuiltinModule\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of codeWithStrings.matchAll(pattern)) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Every forbidden global the source references.
 *
 * The check is a word-boundary match against the *code* text (comments and
 * string literals removed), so `process.env` in a comment does not count and
 * the word "process" inside an identifier such as `processState` does not
 * either.
 */
export function forbiddenGlobalsOf(source) {
  const { codeOnly } = scanSource(source);
  const found = new Set();
  for (const name of FORBIDDEN_GLOBALS) {
    const pattern = new RegExp(`(?<![\\w$.])${name}\\b`, 'g');
    if (pattern.test(codeOnly)) found.add(name);
  }
  return [...found].sort();
}

/**
 * Analyse one source text and report every finding.
 *
 * Returns:
 *   {
 *     imports: string[],        // every module specifier found
 *     allowedImports: string[], // the subset the contract layer may use
 *     forbiddenModules: string[], // imports of I/O-capable builtins
 *     forbiddenGlobals: string[], // I/O-capable globals referenced
 *     pure: boolean             // true when both lists are empty
 *   }
 */
export function analyzeContractPurity(source) {
  const imports = importedModulesOf(source);
  const forbiddenModules = imports.filter((m) => FORBIDDEN_MODULES.includes(m));
  const allowedImports = imports.filter((m) => ALLOWED_MODULES.includes(m));
  const forbiddenGlobals = forbiddenGlobalsOf(source);
  return {
    imports,
    allowedImports,
    forbiddenModules,
    forbiddenGlobals,
    pure: forbiddenModules.length === 0 && forbiddenGlobals.length === 0,
  };
}

/**
 * The broken copies the negative control runs against the same detector.
 * Every entry must be detected -- otherwise the detector is vacuous.
 */
export function negativeControls(source) {
  return {
    'a static import of node:fs': source.replace(
      "import crypto from 'node:crypto';",
      "import crypto from 'node:crypto';\nimport fs from 'node:fs';",
    ),
    'a static import of node:child_process': source.replace(
      "import crypto from 'node:crypto';",
      "import crypto from 'node:crypto';\nimport { spawn } from 'node:child_process';",
    ),
    'a static import of node:https': source.replace(
      "import crypto from 'node:crypto';",
      "import crypto from 'node:crypto';\nimport https from 'node:https';",
    ),
    'a double-quoted import of node:fs': source.replace(
      "import path from 'node:path';",
      "import path from 'node:path';\nimport fs from \"node:fs\";",
    ),
    'process.getBuiltinModule("node:fs")': `${source}\nexport const w = (p, t) => process.getBuiltinModule('node:fs').writeFileSync(p, t);\n`,
    'a bare global fetch() call': `${source}\nexport const f = (u) => fetch(u, { method: 'POST' });\n`,
    'a dynamic import of node:child_process': `${source}\nexport const s = async () => (await import('node:child_process')).execSync('git commit -am x');\n`,
    'a require() of node:fs': `${source}\nexport const r = (p) => require('node:fs').readFileSync(p);\n`,
    'a reference to the process global': `${source}\nexport const e = process.env;\n`,
    'a reference to the globalThis global': `${source}\nexport const g = globalThis;\n`,
    'a WebSocket call': `${source}\nexport const w = (u) => new WebSocket(u);\n`,
  };
}
