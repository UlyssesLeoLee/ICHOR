/**
 * ATS-201: tests for the restricted JS lexer and the collision resolution.
 *
 * The lexer in `server/uid.mjs` extracts the callback body of a test case.
 * It is a RESTRICTED scanner: it recognises strings, template literals with
 * nested `${}`, regular expression literals, line comments and block
 * comments, so that a comma inside a string or a regex does not cut the
 * argument in half.
 *
 * The collision resolution decides which of two cases that want the same uid
 * keeps it. An EXPLICIT claim wins over a registry claim -- the author wrote
 * the uid down, so no derived or remembered claim may take it away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCallbackBody, resolveIdentities, emptyRegistry } from '../server/uid.mjs';

const projectUid = 'proj_1_aaaaaaaaaaaaaaaaaaaaaaaa';

/** Extracts the body of the first `test('...', <body>)` in a source. */
function bodyOf(source) {
  const m = /(?:^|\n)\s*(?:test|it)\s*\(\s*(')([^']*)\1/.exec(source);
  assert.ok(m, 'the fixture must contain a test call');
  return extractCallbackBody(source, m.index + m[0].length);
}

/* ------------------------------------------------------------------ */
/* The lexer                                                           */
/* ------------------------------------------------------------------ */

test('UT-UID-LEX-001: a regular expression literal does not cut the body', () => {
  // The regex contains a comma and a slash; a naive scanner would stop there.
  const body = bodyOf("test('t', async () => { await expect(x).toHaveText(/a,b\\/c/); });");
  assert.match(body.text, /toHaveText\(\/a,b/);
  assert.match(body.text, /\/\); \}$/);
});

test('UT-UID-LEX-002: a division is not read as a regular expression', () => {
  // `a / b` is a division: the scanner must not treat `/ b` as a regex and
  // swallow the rest of the source.
  const body = bodyOf("test('t', async () => { const x = a / b; await x; });");
  assert.match(body.text, /const x = a \/ b/);
  assert.match(body.text, /await x;/);
});

test('UT-UID-LEX-003: a template literal with a nested substitution is skipped', () => {
  const body = bodyOf("test('t', async () => { await go(`${a}${`${b}`}`); });");
  assert.match(body.text, /await go\(/);
  assert.match(body.text, /\}$/);
});

test('UT-UID-LEX-004: a line comment inside the body does not cut it', () => {
  const body = bodyOf("test('t', async () => {\n  // a comment, with a comma\n  await x;\n});");
  assert.match(body.text, /await x;/);
  assert.match(body.text, /\}$/);
});

test('UT-UID-LEX-005: a block comment inside the body does not cut it', () => {
  const body = bodyOf("test('t', async () => { /* a, comment */ await x; });");
  assert.match(body.text, /await x;/);
  assert.match(body.text, /\}$/);
});

test('UT-UID-LEX-006: a string with an escaped quote does not cut the body', () => {
  const body = bodyOf("test('t', async () => { await x('it\\'s, fine'); });");
  assert.match(body.text, /it\\'s, fine/);
  assert.match(body.text, /\}$/);
});

test('UT-UID-LEX-007: a body that is too large is refused instead of truncated', () => {
  const big = 'x'.repeat(500);
  const src = `test('t', async () => { ${big} });`;
  // `afterTitle` is the index right behind the closing quote of the title.
  const afterTitle = src.indexOf("'t'") + 3;
  const body = extractCallbackBody(src, afterTitle, 100);
  assert.equal(body.text, null);
  assert.equal(body.reason, 'body-too-large');
});

test('UT-UID-LEX-008: a call without a callback has no body', () => {
  const body = extractCallbackBody("test('t');", 8);
  assert.equal(body.text, null);
  assert.equal(body.reason, 'no-callback');
});

test('UT-UID-LEX-009: a regex after an opening parenthesis is a regex', () => {
  // `(` is in the allowed-before set, so `/` starts a regex here.
  const body = bodyOf("test('t', async () => { await x(/a,b/); });");
  assert.match(body.text, /await x\(\/a,b\/\)/);
});

/* ------------------------------------------------------------------ */
/* The collision resolution                                            */
/* ------------------------------------------------------------------ */

test('UT-UID-COL-001: an explicit claim wins over a registry claim', () => {
  // The registry remembers that the body of 'alpha' belonged to tc-001; the
  // title now carries the explicit annotation @TC-001 as well. The explicit
  // claim must win -- and the OTHER case must not keep tc-001.
  const registry = {
    version: 1,
    projects: {
      [projectUid]: {
        version: 1,
        entries: [
          { uid: 'tc-001', uidSource: 'registry', titleKey: 'alpha', bodyKey: 'k-alpha', file: 'tests/a.spec.ts', title: 'alpha', line: 2 }
        ]
      }
    }
  };
  const { items } = resolveIdentities({
    projectUid,
    discovered: [
      { file: 'tests/a.spec.ts', title: 'alpha @TC-001', line: 2, bodyText: 'alpha body' },
      { file: 'tests/b.spec.ts', title: 'beta', line: 3, bodyText: 'beta body' }
    ],
    registry
  });
  const alpha = items.find((i) => i.title === 'alpha @TC-001');
  const beta = items.find((i) => i.title === 'beta');
  assert.equal(alpha.uid, 'tc-001');
  assert.equal(alpha.uidSource, 'explicit');
  assert.notEqual(beta.uid, 'tc-001');
});

test('UT-UID-COL-002: two cases that derive the same uid do not keep both of them', () => {
  // Two cases with the same title in the same file derive the same title key
  // uid. One of them has to give it up.
  const { items } = resolveIdentities({
    projectUid,
    discovered: [
      { file: 'tests/a.spec.ts', title: 'same', line: 2, bodyText: 'body one' },
      { file: 'tests/a.spec.ts', title: 'same', line: 3, bodyText: 'body two' }
    ],
    registry: emptyRegistry()
  });
  const uids = items.map((i) => i.uid);
  assert.equal(new Set(uids).size, 2, 'the two cases have different uids');
});

test('UT-UID-COL-003: a collision without a usable fallback ends in the ambiguity report', () => {
  // Two cases with the SAME title and the SAME body: there is no way to tell
  // them apart, so both are reported.
  const { items } = resolveIdentities({
    projectUid,
    discovered: [
      { file: 'tests/a.spec.ts', title: 'same', line: 2, bodyText: 'identical body' },
      { file: 'tests/b.spec.ts', title: 'same', line: 3, bodyText: 'identical body' }
    ],
    registry: emptyRegistry()
  });
  for (const i of items) {
    assert.equal(i.uidStable, false);
    assert.ok(i.ambiguity);
  }
});
