"""ATS-204: register the marker and the narrative fragment of this task.

`wbs_common.MARKERS` is the canonical ORDER of the marked blocks: every
updater re-emits the blocks in that order, so the result does not depend
on which updater ran last. A task that is not in the list has its block
appended at the end instead, which is the same effect but not by design.

`wbs_common.NARRATIVE_FRAGMENTS` is each task's contribution to the two
shared narrative cells of the 总览 sheet.

    python tools/ats204-probes/apply-wbs-common.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / 'tools' / 'wbs_common.py'

OLD_MARKERS = """MARKERS = ('【ATS-101】', '【ATS-102】', '【ATS-103】', '【ATS-201】', '【ATS-202】', '【ATS-205】', '【ATS-206】',
           '【ATS-207】', '【ATS-208】', '【ATS-212】', '【ATS-301】', '【ATS-401】', '【ATS-501】', '【ATS-506】', '【ATS-512】',
           '【ATS-601】')"""
NEW_MARKERS = """MARKERS = ('【ATS-101】', '【ATS-102】', '【ATS-103】', '【ATS-201】', '【ATS-202】', '【ATS-204】', '【ATS-205】',
           '【ATS-206】', '【ATS-207】', '【ATS-208】', '【ATS-212】', '【ATS-301】', '【ATS-401】', '【ATS-501】',
           '【ATS-506】', '【ATS-512】', '【ATS-601】')"""

OLD_FRAGMENT = """    '【ATS-202】': {
        'D6': '权威发现已实现（ATS-202：playwright test --list；未可信仓库回退静态索引）',
        'D7': '权威发现在可信仓库上执行仓库代码（--list 非只读），沙箱化属 ATS-415；'
              '详见 docs/23-AUTHORITATIVE-DISCOVERY.md',
    },"""
NEW_FRAGMENT = """    '【ATS-202】': {
        'D6': '权威发现已实现（ATS-202：playwright test --list；未可信仓库回退静态索引）',
        'D7': '权威发现在可信仓库上执行仓库代码（--list 非只读），沙箱化属 ATS-415；'
              '详见 docs/23-AUTHORITATIVE-DISCOVERY.md',
    },
    '【ATS-204】': {
        'D6': '身份映射器已实现（ATS-204：改名/改标题后的 UID 重识别、动态用例的锚点、'
              '歧义不误关联）',
        'D7': '跨机器的用例身份不在本任务范围（Project UID 依赖绝对路径）；'
              '详见 docs/26-IDENTITY-MAPPER.md',
    },"""


def main():
    raw = TARGET.read_bytes().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n')
    for label, old, new in [
        ('the markers', OLD_MARKERS, NEW_MARKERS),
        ('the narrative fragment', OLD_FRAGMENT, NEW_FRAGMENT),
    ]:
        if text.count(old) != 1:
            print('FAIL: %s -- the snippet is not there exactly once' % label)
            return 1
        text = text.replace(old, new)
    TARGET.write_bytes(text.replace('\n', nl).encode('utf-8'))
    print('rewrote %s' % TARGET.relative_to(ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
