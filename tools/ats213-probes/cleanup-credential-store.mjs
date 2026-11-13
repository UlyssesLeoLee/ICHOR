// Deletes every credential entry this product left in the Windows
// Credential Manager. Used by the probes and by the cleanup of a failed run.
import { spawnSync } from 'node:child_process';

const list = spawnSync('cmdkey', ['/list'], { encoding: 'utf8' });
const targets = new Set();
for (const line of String(list.stdout || '').split(/\r?\n/)) {
  const m = /target=(ATS:ai-test-studio:[^\s]+)/.exec(line);
  if (m) targets.add(m[1]);
}
for (const target of targets) {
  spawnSync('cmdkey', [`/delete:${target}`], { encoding: 'utf8' });
}
const after = spawnSync('cmdkey', ['/list'], { encoding: 'utf8' });
const left = String(after.stdout || '').split(/\r?\n/).filter((l) => l.includes('ATS:ai-test-studio')).length;
console.log(`deleted ${targets.size} entries; ${left} left`);
