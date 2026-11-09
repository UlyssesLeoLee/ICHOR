// Usage: node r2-reader.mjs <tree> -- reader edge cases on the round-2 changed lines.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const tree = path.resolve(process.argv[2]);
const { parseFlow, FLOW_SYNTAX } = await import(pathToFileURL(path.join(tree, 'server/discovery/mobile-flow.mjs')).href);
const { importFlow } = await import(pathToFileURL(path.join(tree, 'server/discovery/mobile-import.mjs')).href);
let held = 0;
function check(id, text, syntax, stepLines) {
  const imported = importFlow(parseFlow(text, { syntax }), { file: 'flows/p.flow', projectUid: 'proj_1_0123456789abcdef01234567' });
  const seen = new Set();
  for (const c of imported.cases) for (const s of c.steps) seen.add(s.line);
  for (const k of ['unsupported', 'warnings', 'errors']) for (const x of imported[k]) seen.add(x.line);
  const missing = stepLines.filter((l) => !seen.has(l));
  if (missing.length) held += 1;
  console.log(`${id} ${missing.length ? 'HOLDS' : 'OK'} :: unaccounted=${JSON.stringify(missing)} env=${JSON.stringify(imported.cases[0]?.env)} steps=${JSON.stringify(imported.cases.flatMap((c) => c.steps.map((s) => [s.line, s.kind])))}`);
}
check('R1 deeper non-key line in env', 'app: x\nscenario: a\n  env:\n    USER: bob\n    tap "x"\n  tap "y"\n', FLOW_SYNTAX.LINEAR, [5, 6]);
check('R2 colon step after env', 'app: x\nscenario: a\n  env:\n    USER: bob\n  tap Settings: General\n', FLOW_SYNTAX.LINEAR, [5]);
check('R3 inline steps list', 'app: x\nscenario: a\n  steps: launch, tap "a, b", screenshot s\n', FLOW_SYNTAX.LINEAR, [3]);
check('R4 tags then env then steps', 'app: x\nscenario: a\n  tags: t\n  env:\n    A: 1\n  launch\n  assert visible "z"\n', FLOW_SYNTAX.LINEAR, [6, 7]);
check('R5 yaml null steps + commands', '---\n- name: a\n  steps:\n  commands:\n    - tapOn: "x"\n', FLOW_SYNTAX.MAESTRO, [5]);
console.log(held ? `RESULT: ${held} hold` : 'RESULT: OK');
process.exitCode = held ? 1 : 0;
