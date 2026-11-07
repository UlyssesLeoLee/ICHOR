/**
 * ATS-212: the whitelist constrains the RUN, not only the write.
 *
 * A variable removed from the whitelist must not reach the child process:
 * the whitelist is checked when the profile is written AND when the runner
 * environment is built, so tightening it afterwards takes effect for the
 * runs that come later. The boundary the whitelist exists to draw is
 * therefore drawn on both sides.
 *
 * This probe measures the fix at the level of the runner environment, with a
 * real child process -- it does not assert on a return value.
 *
 * usage: node tools/ats212-probes/probe-whitelist-filters-run.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  filterProfileVariables,
  buildRunnerEnv,
} from '../../server/env/profiles.mjs';

const profile = {
  variables: {
    BASE_URL: 'http://staging.example.test',
    TENANT: 'acme',
  },
};

// The whitelist was tightened to TENANT after the profile was written.
const whitelist = ['TENANT'];

const filtered = filterProfileVariables(profile, whitelist);
console.log(`profile carries : ${JSON.stringify(Object.keys(profile.variables))}`);
console.log(`whitelist now   : ${JSON.stringify(whitelist)}`);
console.log(`filtered        : ${JSON.stringify(Object.keys(filtered.variables))}`);
console.log(`refused         : ${JSON.stringify(filtered.refused)}`);

const env = buildRunnerEnv({ variables: filtered.variables });
const r = spawnSync(
  process.execPath,
  ['-e', 'console.log(JSON.stringify({BASE_URL:process.env.BASE_URL??null,TENANT:process.env.TENANT??null}))'],
  { env, encoding: 'utf8' }
);
const seen = JSON.parse(r.stdout.trim());
console.log(`child sees      : ${JSON.stringify(seen)}`);

const ok = seen.BASE_URL === null
  && seen.TENANT === 'acme'
  && filtered.refused.length === 1
  && filtered.refused[0].name === 'BASE_URL';
console.log(`RESULT: ${ok ? 'OK -- the removed name does not reach the runner' : 'FAIL -- the removed name still reaches the runner'}`);

process.exit(ok ? 0 : 1);
