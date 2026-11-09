// ATS-106 negative controls: each guard is removed on a TEMPORARY COPY of the
// sources and the test that covers it must then FAIL. A guard whose removal
// no test notices is a vacuous guard. The repository itself is never edited.
//
// Usage: node tools/ats106-probes/mutation-tests.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..', '..');
const MUTANTS = [
  { id: 'M1', file: 'server/adapters/playwright-cli.mjs', from: "if (filter.startsWith('-')) throw bad(", to: "if (false) throw bad(", test: 'tests/preflight.test.mjs', guard: 'filter: leading "-" (option injection)' },
  { id: 'M2', file: 'server/adapters/playwright-cli.mjs', from: "else if (a.startsWith('-')) throw bad(", to: "else if (false) throw bad(", test: 'tests/preflight.test.mjs', guard: 'argv self-check: foreign option' },
  { id: 'M3', file: 'server/adapters/playwright-preflight.mjs', from: '|| compareVersions(parsed, parseVersion(SUPPORTED_PLAYWRIGHT_RANGE.maxExclusive)) >= 0', to: '|| false', test: 'tests/preflight.test.mjs', guard: 'preflight: upper version bound' },
  { id: 'M4', file: 'server/adapters/playwright-preflight.mjs', from: 'if (!found) { missing.push(', to: 'if (false) { missing.push(', test: 'tests/preflight.test.mjs', guard: 'preflight: dependency resolution' },
  { id: 'M5', file: 'server/index.mjs', from: "if(rejected.length)return err(res,400,'RUN_PARAMETER_NOT_ALLOWED',{rejected});", to: '', test: 'tests/preflight-it.test.mjs', guard: 'route: request field whitelist' },
  { id: 'M6', file: 'server/index.mjs', from: 'if(!preflight.ok){', to: 'if(false){', test: 'tests/preflight-it.test.mjs', guard: 'startRun: preflight gate before spawn' },
  { id: 'M7', file: 'server/index.mjs', from: 'if(file){readSource(project,file);assertSafeTestFilter(file);}', to: 'if(file){readSource(project,file);}', test: 'tests/preflight-it.test.mjs', guard: 'route: filter check (400 instead of a run)' },
  { id: 'M8', file: 'server/adapters/playwright-preflight.mjs', from: "fail('cli', PREFLIGHT_CODE.NOT_INSTALLED, { candidates: [...PLAYWRIGHT_CLI_CANDIDATES] });", to: "pass('cli');", test: 'tests/preflight-it.test.mjs', guard: 'preflight: a missing local CLI blocks (IT-PF-008)' },
  { id: 'M9', file: 'server/adapters/playwright-preflight.mjs', from: 'const required = [Number(floor[1]), Number(floor[2] || 0), Number(floor[3] || 0)];', to: 'const required = [Number(floor[1]), 0, 0];', test: 'tests/preflight.test.mjs', guard: 'preflight: the whole >=N[.M[.P]] floor is compared (UT-PF-007b)' },
];

function copyTree(dest) {
  for (const rel of ['server', 'tests/helpers', 'package.json', 'tests/preflight.test.mjs', 'tests/preflight-it.test.mjs']) {
    fs.cpSync(path.join(root, rel), path.join(dest, rel), { recursive: true });
  }
}

let caught = 0;
for (const m of MUTANTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ats106-${m.id}-`));
  try {
    copyTree(dir);
    const target = path.join(dir, m.file);
    const text = fs.readFileSync(target, 'utf8');
    if (!text.includes(m.from)) {
      console.log(`${m.id} INVALID  the mutation anchor was not found in ${m.file}`);
      continue;
    }
    fs.writeFileSync(target, text.replace(m.from, m.to));
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', m.test], { cwd: dir, encoding: 'utf8', timeout: 240000 });
    const failed = (r.stdout.match(/^✖ (.+?) \(/gm) || []).map((l) => l.replace(/^✖ /, '').replace(/ \($/, ''));
    const verdict = r.status !== 0 ? 'CAUGHT' : 'SURVIVED';
    if (r.status !== 0) caught += 1;
    console.log(`${m.id} ${verdict.padEnd(8)} ${m.guard} -> ${m.test} exit=${r.status} failing: ${failed.slice(0, 3).join(' | ') || '-'}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a bridge may still hold a file */ }
  }
}
console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
process.exit(caught === MUTANTS.length ? 0 : 1);
