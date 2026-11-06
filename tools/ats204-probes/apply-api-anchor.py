"""ATS-204: expose the ANCHOR on the API surface and report the shift.

The catalogue of a project is what a reader sees, so the anchor of a case
belongs on it: the anchor is what the case is remembered BY when it has
no body of its own, and a reader who wants to know "how was this case
recognised" needs to see it.

The warning gains the shift: a template that gained or lost a render
means the ordinals may have moved, and the cases that could not be
recognised by their anchor say so.

    python tools/ats204-probes/apply-api-anchor.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'server' / 'core.mjs'

OLD_TEST = """  const tests = resolved.items.map(t => ({
    id: t.uid, uid: t.uid, uidSource: t.uidSource, uidStable: t.uidStable,
    uidBasis: t.basis,
    file: t.file, title: t.title, line: t.line,
    describePath: t.scope,
    specIds: t.specIds,
    source: 'authoritative', level: 'ST',
    ...(t.ambiguity ? { ambiguity: t.ambiguity } : {})
  }));"""
NEW_TEST = """  const tests = resolved.items.map(t => ({
    id: t.uid, uid: t.uid, uidSource: t.uidSource, uidStable: t.uidStable,
    uidBasis: t.basis,
    file: t.file, title: t.title, line: t.line,
    describePath: t.scope,
    specIds: t.specIds,
    // ATS-204: the anchor of the case. It is what a case that has no body
    // of its own is remembered BY: the position it was reported at plus
    // its ordinal there.
    anchor: t.anchor ?? null,
    source: 'authoritative', level: 'ST',
    ...(t.ambiguity ? { ambiguity: t.ambiguity } : {})
  }));"""

OLD_WARNING = """  const duplicatedExplicit = tests.filter(t => t.ambiguity?.reason === 'duplicate-explicit-uid').length;
  const outside = (listed.skipped && listed.skipped.length) || 0;

  let warning = `权威索引来自 playwright test --list（CLI ${listed.version || '?'}）：动态与参数化用例已包含在内。`;
  if (ambiguous) warning += ` ${ambiguous} 个用例的 UID 为临时值（标题与 describe 路径都无法唯一判定），需要用 @TC-xxx 显式标注或人工复核。`;
  if (duplicatedExplicit) warning += ` ${duplicatedExplicit} 个用例标注了同一个 @TC-xxx，这些用例都没有绑定到该 UID，需要人工消歧。`;"""
NEW_WARNING = """  const duplicatedExplicit = tests.filter(t => t.ambiguity?.reason === 'duplicate-explicit-uid').length;
  const outside = (listed.skipped && listed.skipped.length) || 0;
  // ATS-204: the cases whose anchor could not decide them -- a template
  // that gained or lost a render, so the ordinals may have moved.
  const shifted = tests.filter(t => t.ambiguity?.reason === 'render-shift-possible').length;

  let warning = `权威索引来自 playwright test --list（CLI ${listed.version || '?'}）：动态与参数化用例已包含在内。`;
  if (ambiguous) warning += ` ${ambiguous} 个用例的 UID 为临时值（标题与 describe 路径都无法唯一判定），需要用 @TC-xxx 显式标注或人工复核。`;
  if (duplicatedExplicit) warning += ` ${duplicatedExplicit} 个用例标注了同一个 @TC-xxx，这些用例都没有绑定到该 UID，需要人工消歧。`;
  if (shifted) warning += ` ${shifted} 个用例的模板渲染数发生了变化（${[...new Set(tests.filter(t => t.ambiguity?.reason === 'render-shift-possible').map(t => t.ambiguity.previousCount + '→' + t.ambiguity.currentCount))].join('、')}），锚点次序可能已经位移，这些用例的 UID 由本次发现派生，需要人工复核。`;"""


def main():
    raw = CORE.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')
    for label, old, new in [
        ('the test record', OLD_TEST, NEW_TEST),
        ('the warning', OLD_WARNING, NEW_WARNING),
    ]:
        if text.count(old) != 1:
            print('FAIL: %s -- the snippet is not there exactly once' % label)
            return 1
        text = text.replace(old, new)
    CORE.write_bytes(text.replace('\n', nl).encode('utf-8'))
    print('rewrote %s' % CORE.relative_to(ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
