"""Derive the 开发WBS totals from the sheet itself.

The 总览 (sheet1) cells B8/B9/B10 hold FORMULAS with a cached value. A reader
that does not recalculate the workbook sees the cached value, so the cache has
to match the sheet. Hardcoding the numbers in an updater is wrong as soon as a
second script changes a row: whichever updater ran last would restore its own
stale cache and the 总览 would silently disagree with the 开发WBS.

Both updaters therefore DERIVE the cached values from the sheet they are
about to write. The derivation is:

    B8  = COUNTIF(开发WBS!N6:N94, "已完成")
    B9  = IFERROR(1 - SUM(开发WBS!P6:P94) / SUM(开发WBS!K6:K94), 0)
    B10 = SUM(开发WBS!P6:P94)

The row range (6..94) mirrors the formulas stored in the workbook. It is
NOT a constant: the sheet grew when ATS-601 appended the mobile rows, and
the formulas in the workbook were grown with it. `totals()` therefore
derives the last row from the SHEET (`last_data_row`), so the cached value
always agrees with the formula that produced it.
"""
import re
import struct
import zlib
from pathlib import Path

WBS = Path(__file__).resolve().parents[1] / 'docs' / 'WBS.xlsx'

FIRST_ROW = 6
LAST_ROW = 94

SHARED_STRINGS = 'xl/sharedStrings.xml'
SHEET1 = 'xl/worksheets/sheet1.xml'
SHEET2 = 'xl/worksheets/sheet2.xml'

# Every script that writes a marked note into a shared cell owns exactly one
# marker. A cell may therefore carry notes from more than one script, and the
# merge has to keep the foreign ones.
#
# The tuple order is also the CANONICAL block order: the merge re-emits the
# blocks in this order regardless of the order in which the scripts ran. Two
# updaters that touch the same cell therefore produce the same sheet whatever
# order they run in.
MARKERS = ('【ATS-101】', '【ATS-102】', '【ATS-103】', '【ATS-104】', '【ATS-106】', '【ATS-107】', '【ATS-111】', '【ATS-201】', '【ATS-202】', '【ATS-203】', '【ATS-204】',
           '【ATS-205】', '【ATS-206】', '【ATS-207】', '【ATS-208】', '【ATS-209】', '【ATS-212】', '【ATS-213】', '【ATS-214】', '【ATS-215】', '【ATS-216】',
           '【ATS-301】', '【ATS-307】', '【ATS-401】', '【ATS-402】', '【ATS-403】', '【ATS-501】', '【ATS-502】', '【ATS-506】', '【ATS-512】',
           '【ATS-601】', '【ATS-602】', '【ATS-603】', '【ATS-606】', '【ATS-410】')

# The 总览 narrative cells D6/D7 summarise the state of the whole baseline.
# They are shared by every updater, so each task contributes ONE marked
# fragment and the cell is the composition of all of them.
#
# `base` is the unmarked part that belongs to no task and is never removed.
# `stale` lists the legacy unmarked fragments that earlier deliveries wrote
# whole-cell; they are superseded by the marked fragments and must not
# linger next to them.
NARRATIVE = {
    'D6': {
        'base': 'v0.1 已有 Node Bridge/便携 UI/Next/Tauri 源码，已通过 20 项 Node UT/IT',
        'stale': (
            'Next.js 16 静态导出构建已实测通过（ATS-101）',
            'Agent 契约层已实现（ATS-401）',
            '锁文件、依赖清单与 CI 构建门禁已交付（ATS-102）。',
            'Next.js 16 静态导出构建已实测通过（ATS-101）。',
        ),
    },
    'D7': {
        # B-01 (the fatal Playwright CLI argument defect) was fixed by
        # ATS-106, and ATS-107 then executed the real browser chain, so the
        # old "the real browser ST was never executed" claim is no longer
        # true. The cell is rebuilt from the base and every task's fragment,
        # so the old sentence simply stops being part of the base.
        #
        # ATS-104 then built the Tauri shell on a real Windows machine, so
        # the "Tauri Windows 编译未通过" sentence is no longer true either
        # and stops being part of the base for the same reason.
        'base': '真实浏览器 Playwright ST 已开始实测（B-01 已由 ATS-106 修复，'
                'ATS-107 起在真实 Chromium 上执行）',
        'stale': (
            'CI workflow 未在真实 runner 上跑过（ATS-102）',
            '详见 docs/16-BASELINE-ADR.md、docs/17-BUILD-CI.md 与 docs/17-AGENT-CONTRACT.md。',
            '详见 docs/16-BASELINE-ADR.md。',
            'Tauri Windows 编译未通过（B-02：缺 MSVC C++ 构建工具、'
            '仓库缺 icons/icon.ico，且成因清单尚未穷尽）',
        ),
    },
}

# Each task's own contribution to the narrative cells.
NARRATIVE_FRAGMENTS = {
    '【ATS-101】': {
        'D6': 'Next.js 16 静态导出构建已实测通过',
        'D7': '详见 docs/16-BASELINE-ADR.md',
    },
    '【ATS-102】': {
        'D6': '锁文件、依赖清单与 CI 构建门禁已交付',
        'D7': 'CI workflow 未在真实 runner 上跑过；详见 docs/17-BUILD-CI.md',
    },
    '【ATS-103】': {
        'D6': 'Next.js 16 静态导出与 127.0.0.1 Bridge 的会话/项目/运行操作已实测通过，'
              '真实 headless Chromium 驱动导出页 7/7 通过（ATS-103）',
        'D7': '静态导出未在 macOS/Linux 实测、未在真实 Tauri 壳内实测；'
              '引擎进程异常死亡时运行记录无 summary 的证据链缺陷属 ATS-108/ATS-112；'
              'Bridge 静态路由只覆盖 /，目录索引与 404 未实现；'
              '详见 docs/22-FRONTEND-EXPORT.md',
    },
    '【ATS-104】': {
        'D6': 'Tauri 2 Windows dev build 已实测通过（ATS-104：cargo tauri dev 起桌面壳，'
              'WebView2 加载页面，Bridge 应答，关窗后无孤儿进程与孤儿窗口）',
        'D7': 'msvc 链的最终链接未在本机验证（本机无 MSVC C++ 构建工具工作负载），'
              '结论建立在 gnu 链实机结果上；macOS/Linux 的桌面壳未实测；'
              'Bridge 的 node 不可用时 spawn().ok() 静默失败（属 ATS-105）；'
              '详见 docs/16-BASELINE-ADR.md §4 B-02',
    },
    '【ATS-401】': {
        'D6': 'Agent 契约层已实现',
        'D7': '详见 docs/17-AGENT-CONTRACT.md',
    },
    '【ATS-202】': {
        'D6': '权威发现已实现（ATS-202：playwright test --list；未可信仓库回退静态索引）',
        'D7': '权威发现在可信仓库上执行仓库代码（--list 非只读），沙箱化属 ATS-415；'
              '详见 docs/23-AUTHORITATIVE-DISCOVERY.md',
    },
    '【ATS-204】': {
        'D6': '身份映射器已实现（ATS-204：改名/改标题后的 UID 重识别、动态用例的锚点、'
              '歧义不误关联）',
        'D7': '跨机器的用例身份不在本任务范围（Project UID 依赖绝对路径）；'
              '详见 docs/26-IDENTITY-MAPPER.md',
    },
    '【ATS-205】': {
        'D6': 'SQLite 元数据层已实现（ATS-205：WAL、版本迁移与事务；state.json 的镜像）',
        'D7': '元数据层当前只做 state.json 的镜像，不提供查询 API；'
              '详见 docs/06-DATA-DESIGN.md §5',
    },
    '【ATS-206】': {
        'D6': '状态数据迁移 CLI 已实现（ATS-206：安全导入、备份与回滚；数量一致）',
        'D7': '迁移为离线操作须先停 Bridge；降级不在本项范围，进程级独占归 ATS-207；'
              '详见 docs/24-STATE-MIGRATION.md',
    },
    '【ATS-207】': {
        'D6': '数据目录单实例锁与崩溃恢复已实现（ATS-207：原子抢锁、持有者校验、'
              'state.json 落盘同步、损坏镜像隔离重建）',
        'D7': '断电只以强杀进程模拟，未做真实掉电；桌面壳不显示占用提示；'
              '详见 docs/06-DATA-DESIGN.md §5.7',
    },
    '【ATS-208】': {
        'D6': '执行状态机 v2 已实现（ATS-208：Run/Test/Attempt 与事件序号统一模型；重试不覆盖初次尝试，'
              '事件可按 run+sequence 复演）',
        'D7': '执行模型的真实浏览器 ST 未执行（夹具为 CLI 替身，只建模报告形状）；'
              '该缺口已由 ATS-107 补上（真实 Chromium 上跑通 Run/Test/Attempt 与事件序号模型），'
              '但 ATS-107 只覆盖两条离线用例，联网用例、可中断长用例与多次重复执行仍未实测；'
              '详见 docs/06-DATA-DESIGN.md §5.4；'
              '详见 docs/31-REAL-BROWSER-FIXTURE.md',
    },
    '【ATS-212】': {
        'D6': '项目级环境档案与 runner 环境封口已实现（ATS-212：档案按项目命名空间；'
              '只有白名单内的变量可传递；runner 不继承宿主环境）',
        'D7': '凭据形态的变量被拒绝并指向凭据存储（该存储已由 ATS-402 交付）；'
              '详见 docs/04-DETAILED-DESIGN.md §5A',
    },
    '【ATS-402】': {
        'D6': 'AI 数据安全三道闸门已实现（ATS-402：密钥入系统凭据库且磁盘只留引用；'
              '外传须先展示范围并取得知情授权，放行与拒绝都进审计）',
        'D7': '模型提供商适配层已由 ATS-403 接入（外发路径只由该层持有，仍须先取得外传授权）；'
              'macOS/Linux 凭据库后端未在真机实测；Tauri 壳内凭据存取未验证；'
              '外传审计未做外部防篡改；ST-032 仍为 PENDING（外发路径已有，但未用真实服务商验证），'
              'ST-031/033 已执行；'
              '详见 docs/23-AI-DATA-SECURITY.md',
    },
    '【ATS-403】': {
        'D6': '可替换模型 API 适配层已实现（ATS-403：两种兼容协议、可配置的提供商列表、'
              '错误回退链；密钥只在发请求时从凭据库取；'
              '外传载荷与授权绑定——输入内容发出去的就是被授权的那一份；'
              '调用方的指令原样发出但进外传审计，记摘要不记正文）',
        'D7': '未用真实模型与真实密钥端到端验证（只用注入的 fetch 与回环假端点验证）；'
              '与 ATS-401 契约层尚未接线（complete 不经过契约层）；'
              '步数预算的 executeSteps 是库函数，没有 Bridge 路由调用它；'
              '模型输出仍不写入仓库，提案落地属后续任务；'
              '详见 docs/30-MODEL-ADAPTER.md',
    },
    '【ATS-209】': {
        'D6': '证据清单与保留策略已实现（ATS-209：清单带所属运行与整组摘要、'
              '内容寻址去重、到期清理只删证据不删 Run 元数据）',
        'D7': '证据清单未签名（不得宣称 WORM 或防篡改等级），'
              '清理掉证据后清单与文件夹不再一致（校验会如实报 missing）；'
              '详见 docs/27-EVIDENCE-MANIFEST.md',
    },
    '【ATS-215】': {
        'D6': '证据工作台已实现（ATS-215：从失败用例 2 次点击内找到 Trace；'
              '附件显示归档时的 SHA-256 与文件时间；两个界面共用同一份定位实现）',
        'D7': '工作台不代为打开 trace（Trace Viewer 是引擎附带的独立程序，版本须与产生该 trace 的引擎一致）；'
              'Trace 定位依赖 report.json，报告缺失时只能走兜底推导，而兜底推导在超长标题/多项目/重试场景下不精确'
              '（此时报「定位不到」而不是猜）；'
              '跨运行并排对照目前只有模块能力与接口基础，界面未提供（P1）；'
              '详见 docs/29-EVIDENCE-WORKBENCH.md',
    },
    '【ATS-213】': {
        'D6': '凭据引用与可用状态面已实现（ATS-213：密钥仅以引用传递——档案只留引用，'
              '运行启动时解析并注入封口环境，解析不了拒绝启动；状态是三值闭集且每条引用恰有一个；'
              '状态对系统凭据库实测而不从索引推断；未配置与取不到不合并；'
              '整张清单基于同一份索引快照；界面显示状态词与原因，不回显明文）',
        'D7': 'macOS Keychain / Linux Secret Service 后端未在真机实测（Windows Credential Manager 已实测）；'
              'Tauri 壳内凭据存取未验证（src-tauri/src/lib.rs 未改动）；'
              '详见 docs/32-CREDENTIAL-STATUS.md',
    },
    '【ATS-111】': {
        'D6': '工作台可用性已实现（ATS-111：四态可辨识、核心流程可纯键盘完成）',
        'D7': 'ATS-111 只覆盖 Next 工作台，便携 UI 未同步；屏幕阅读器未实机验证；'
              '详见 docs/05-UI-UX.md §4',
    },
    '【ATS-216】': {
        'D6': '质量概览模块已实现（ATS-216：失败聚类/Flaky 基础指标，非 AI；'
              '失败/重试/取消分开计数，指标与原始结果可核对）',
        'D7': '质量概览已在真实 Chromium 里实测渲染（两个界面都打开质量概览页、指标与对账表都渲染、'
              '两界面数字一致、无 console 错误），但人工可用性（无障碍/键盘/加载态）未评测，属 ATS-111；'
              '聚类只到「错误文本归一化后的签名」，不做根因判断；'
              '详见 docs/28-QUALITY-OVERVIEW.md',
    },
    '【ATS-107】': {
        'D6': '真实浏览器 PASS/FAIL 测试仓库已交付（ATS-107：独立工程夹具，@playwright/test 精确固定'
              '且 lockfile 入库，真实 Chromium 上 1 PASS 1 FAIL，逐条结果与错误信息均与 CLI 直跑一致）',
        'D7': '真实浏览器链路已实测（ATS-107），但覆盖面仅限该夹具的两条离线用例；'
              '真实站点的联网用例、可中断长用例（ST-010）与多次重复执行（ST-012）仍未实测；'
              '详见 docs/31-REAL-BROWSER-FIXTURE.md',
    },
    '【ATS-501】': {
        'D6': '远程执行面协议已冻结（ADR-015~023，全部 DESIGNED，无实现）',
        'D7': '远程执行面无任何实现（ATS-501 只冻结协议与威胁模型）；'
              '详见 docs/19-REMOTE-RUNNER-PROTOCOL.md',
    },    '【ATS-502】': {
        'D6': '远程调度内核已实现（队列/租约/心跳/幂等键/重试，含租约 fencing 与 running 态回收）',
        'D7': '远程节点协议、签名与工作树隔离仍未实现（ATS-503/504）；'
              '详见 docs/29-REMOTE-SCHEDULING.md',
    },

    '【ATS-506】': {
        'D6': '部署式控制面 API 边界骨架已实现（ATS-506：独立进程/端点/凭据，'
              '入站拒绝本地路径与本地 Token）',
        'D7': '控制面无持久化、用户认证仅有接口（OIDC 属 ATS-507）；'
              '详见 docs/21-CONTROL-PLANE-API.md',
    },
    '【ATS-512】': {
        'D6': '插件契约层已实现（权限清单与 Runner SDK，含宿主持有的权威提案记录；插件宿主未实现）',
        'D7': '插件宿主与沙箱未实现（ATS-512 只交付契约层；同进程插件仍可自行 import，ATS-403 之前无保证）；'
              '详见 docs/21-PLUGIN-CONTRACT.md',
    },
    '【ATS-601】': {
        'D6': '移动端目标与会话契约已实现（ATS-601：三类目标、会话状态机、能力协商与拒绝规则；'
              '无真实设备）',
        'D7': '移动端目标与会话契约已实现（ATS-601：契约层本身不碰设备）；'
              '真实 Android 执行由 ATS-603 的 Android Runner 承担；'
              '详见 docs/25-MOBILE-APP-TESTING.md',
    },
    '【ATS-602】': {
        'D6': '移动端 Flow 导入映射已实现（ATS-602：跨引擎用例模型、映射规则与导入报告；'
              '不支持的步骤保留原文并标记，不静默丢弃）',
        'D7': '移动端 Flow 导入映射已实现（ATS-602：映射层不涉及任何设备）；'
              '真实 Android 执行已由 ATS-603 实测；'
              '详见 docs/25-MOBILE-APP-TESTING.md',
    },
    '【ATS-603】': {
        'D6': 'Android Runner 已在真实模拟器上实测通过（ATS-603：启动/点按/断言/截图四类步骤；'
              '失败区分会话掉线/元素找不到/断言不成立/驱动报错）',
        'D7': '移动端证据归档与跨引擎统一查询仍未实现（ATS-604）；'
              '能力矩阵与环境声明属 ATS-605；iOS 与 Maestro 边界属 ATS-606；'
              '本机无 iOS 环境、无 Android 真机连接',
    },
    '【ATS-606】': {
        'D6': 'iOS 支持范围与 Maestro 兼容性边界已冻结（ATS-606：逐类步骤的 iOS 支持范围、'
              'Maestro 命令逐条兼容性判定与不承诺清单；§8.5 的导入器行为与参数保真由'
              '逐条实跑导入器得出并由脚本生成，复核脚本把整块（三个组标题+55 行+TALLY）'
              '与生成器输出逐字比对、并独立检查分组不变量与平台表的两条规则'
              '（等待不决定分组、配对命令两边都带配对）——把一行挪到别的组必然变红；'
              '未做 iOS 实测）',
        'D7': 'iOS 真实执行属本阶段 OUT（ATS-606 只交付设计与边界冻结：'
              '§8.4 写的是以 Maestro 2.12.1 为参照的可行性，本平台没有 iOS Runner，'
              '仓库内无任何 iOS 实现）；'
              'iOS 真机路径另有四条硬前提（需 Apple team ID 签名构建 driver-iphoneos、'
              'runner 经 devicectl 装到设备、宿主侧的 CoreDevice 隧道已连上、'
              '宿主到设备的 127.0.0.1:22087 可达），'
              '且与 local-device 契约冲突（平台不接管真机安装与配对）；'
              '详见 docs/25-MOBILE-APP-TESTING.md',
    },
    '【ATS-203】': {
        'D6': '索引回归数据集已交付（ATS-203：参数化循环/模板标题/重名/describe 路径/'
              '对称与非对称项目矩阵/重复发现确定性；静态与权威两种索引都断言，'
              '并经变异测试验证有判别力；静态索引对模板标题的处置已整改为'
              '「标明不可判定」ambiguity.reason=dynamic-template-title）',
        'D7': '参数化与项目矩阵的权威发现仍依赖 ATS-202 的 playwright test --list；'
              'UID 重识别与歧义提示属 ATS-204；'
              '静态索引无法知道模板渲染出几条用例，二者在这一类用例上不一致（已如实报告）',
    },
    '【ATS-502】': {
        'D6': '远程调度内核已实现（队列/租约/心跳/幂等键/重试，含租约 fencing 与 running 态回收）',
        'D7': '远程节点协议、签名与工作树隔离仍未实现（ATS-503/504）；'
              '详见 docs/29-REMOTE-SCHEDULING.md',
    },
}


def _text(value):
    """Return `value` as text, decoding bytes when necessary."""
    if isinstance(value, bytes):
        return value.decode('utf-8')
    return value


def xml_escape(value):
    """Escape a string so it can be the text of an XML element.

    The sheet XML is written by hand, so any value that goes into a
    `<x:v>` element has to be escaped. Without this a note containing
    `<24hex>` or `a & b` is written verbatim: the `<` starts what the
    parser reads as a tag and the workbook is damaged (Excel refuses to
    open it).
    """
    return (str(value)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;'))


def xml_unescape(value):
    """Reverse `xml_escape`.

    The merge helpers work on plain text (a note is compared against plain
    strings such as '已完成'), so the stored value has to be decoded before
    it is merged and re-encoded on the way out. Decoding on read and
    encoding on write is what keeps the round trip stable: running an
    updater twice must not change the file.
    """
    text = _text(value) or ''
    return (text
            .replace('&lt;', '<')
            .replace('&gt;', '>')
            .replace('&quot;', '"')
            .replace('&apos;', "'")
            .replace('&amp;', '&'))


def format_rate(rate):
    """Render a completion rate the way the workbook's cached values do.

    The baseline 总览 cell holds 15 decimal places (``%.15f``), so the cached
    value keeps the same width whether it was written by hand or derived.
    """
    return '%.15f' % rate


def cell_text(xml, rid, col):
    """Return the text of one cell of one row, or '' when it has no value."""
    m = re.search(r'<x:c r="%s%d"[^>]*>(.*?)</x:c>' % (col, rid), xml, re.S)
    if m is None:
        return ''
    v = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    return xml_unescape(v.group(1)) if v else ''


def cell_number(xml, rid, col):
    """Return the numeric value of one cell, or 0.0 when it is not a number."""
    raw = cell_text(xml, rid, col)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def set_cell(xml, col, value, *, numeric=False):
    """Set the <x:v> of one cell in one row, keeping its style and any formula."""
    pat = re.compile(r'(<x:c r="%s\d+"[^>]*>)(.*?)(</x:c>)' % col, re.S)
    m = pat.search(xml)
    if m is None:
        raise SystemExit(f'cell {col} not found')
    open_tag, body, close = m.groups()
    f = re.search(r'<x:f>(.*?)</x:f>', body, re.S)
    open_tag = re.sub(r'\st="[^"]*"', '', open_tag)
    open_tag = open_tag[:-1] + (' t="n">' if numeric else ' t="str">')
    new_body = (f.group(0) if f else '') + '<x:v>%s</x:v>' % xml_escape(value)
    return xml[:m.start()] + open_tag + new_body + close + xml[m.end():]


def set_cell_in_row(xml, rid, col, value, *, numeric=False):
    """Set one cell of one specific row without touching other rows."""
    m = re.search(r'<x:row[^>]*r="%d"[^>]*>.*?</x:row>' % rid, xml, re.S)
    if m is None:
        raise SystemExit(f'row {rid} not found')
    row = set_cell(m.group(0), col, value, numeric=numeric)
    return xml[:m.start()] + row + xml[m.end():]


def merge_marked(current, marker, new_text, stale_prefixes=(), stale_fragments=(),
                 drop_unmarked=False, plain=False):
    """Replace this script's text in `current` with `new_text`.

    A cell may hold an unmarked prefix plus one block per marker. The blocks
    are delimited by the markers themselves, not by the '；' separator, so a
    block that contains '；' internally survives the merge intact.

    `stale_prefixes` / `stale_fragments` name superseded notes that must not
    linger in the cell. They are removed from the UNMARKED prefix only -- a
    marked block belongs to another script and is never edited here.

    `drop_unmarked` discards the unmarked prefix entirely. It is used for a
    cell this script owns outright, where the pre-marker text is an earlier
    version of the same note.

    `plain` writes this script's text WITHOUT a marker -- it replaces the
    unmarked prefix. It is used for a cell that is owned outright by one
    script, so that the cell keeps the exact bytes the committed baseline
    has. A foreign marked block in the same cell survives untouched.

    The blocks are re-emitted in CANONICAL order (the MARKERS tuple order),
    not in the order they happened to appear in the cell. That is what makes
    two updaters order-independent: whichever script runs last, the cell
    ends up with the same sequence of blocks.
    """
    current = _text(current) or ''
    positions = []
    for m in MARKERS:
        for mm in re.finditer(re.escape(m), current):
            positions.append((mm.start(), m))
    positions.sort()

    blocks = []            # (owner marker or None, text)
    if not positions:
        blocks.append((None, current))
    else:
        if positions[0][0] > 0:
            blocks.append((None, current[:positions[0][0]]))
        for i, (pos, owner) in enumerate(positions):
            end = positions[i + 1][0] if i + 1 < len(positions) else len(current)
            blocks.append((owner, current[pos:end]))

    out_blocks = []
    own_written = False
    # The caller may hand us text that already starts with its own marker.
    # `merge_marked` writes `marker + new_text`, so leaving the marker in
    # would produce a doubled prefix (e.g. 【ATS-401】【ATS-401】...) and the
    # cell would no longer be idempotent. Strip the caller's own leading
    # markers once here so both spellings are accepted and the result is the
    # same block either way.
    own_text = new_text
    while own_text.startswith(marker):
        own_text = own_text[len(marker):]
    for owner, text in blocks:
        if owner == marker:
            if own_written:
                continue              # a duplicate of this script's block
            out_blocks.append((marker, marker + own_text))
            own_written = True
            continue
        if owner is None:
            if plain:
                # This script owns the unmarked text of this cell.
                if own_written:
                    continue
                out_blocks.append((None, new_text))
                own_written = True
                continue
            if drop_unmarked:
                continue
            # The unmarked prefix may hold superseded notes from an earlier
            # delivery. Drop them segment by segment.
            segs = [s for s in text.split('；')
                    if not any(s.startswith(p) for p in stale_prefixes)
                    and s not in stale_fragments]
            text = '；'.join(segs)
        if text.strip():
            out_blocks.append((owner, text))

    if not own_written:
        if plain:
            out_blocks.insert(0, (None, new_text))
        else:
            out_blocks.append((marker, marker + own_text))

    # Re-emit in canonical order: unmarked prefix first, then one block per
    # marker in the MARKERS order. A block whose marker is unknown (a future
    # task) keeps its relative position at the end rather than being lost.
    prefix = ''.join(t for owner, t in out_blocks if owner is None)
    by_marker = {}
    unknown = []
    for owner, t in out_blocks:
        if owner is None:
            continue
        if owner in MARKERS:
            by_marker[owner] = t
        else:
            unknown.append(t)
    ordered = [prefix] if prefix.strip() else []
    ordered.extend(by_marker[m] for m in MARKERS if m in by_marker)
    ordered.extend(unknown)

    out = ''
    for text in ordered:
        text = text.strip().rstrip('；').strip()
        if not text:
            continue
        if out:
            # Two blocks are joined by '；', but a block that already ends in
            # a full stop must not get a second one after the separator.
            out = out.rstrip('；')
            out += '' if out.endswith('。') else '；'
        out += text
    return out


def compose_narrative(cell, cell_name):
    """Build the 总览 narrative cell from every task's marked fragment.

    The cell is owned by NO single task: each task contributes one marked
    fragment, and the cell is the composition of the unmarked base plus all
    the fragments. Any updater can therefore rewrite the cell without
    erasing another task's contribution, and the result does not depend on
    the order in which the updaters ran.

    `cell_name` is the cell's name ('D6' / 'D7'), not its column letter.
    """
    spec = NARRATIVE[cell_name]
    current = _text(cell) or ''
    # Strip the legacy unmarked fragments: they are the whole-cell
    # predecessors of the marked fragments below.
    prefix = spec['base']
    for stale in spec['stale']:
        prefix = prefix.replace(stale, '')
    prefix = prefix.strip().rstrip('；').strip()

    parts = [prefix] if prefix else []
    for marker in MARKERS:
        fragment = NARRATIVE_FRAGMENTS.get(marker, {}).get(cell_name)
        if not fragment:
            continue
        # A fragment that is already in the cell (from an earlier run) must
        # not be added twice.
        if marker in current and fragment in current:
            parts.append(fragment)
            continue
        parts.append(fragment)
    out = '；'.join(p for p in parts if p)
    if out and not out.endswith('。'):
        out += '。'
    return out


def set_narrative_cell(xml, rid, cell_name):
    """Rewrite one 总览 narrative cell as the composition of all fragments.

    `cell_name` is the cell's name ('D6' / 'D7'); the row is `rid` (6 / 7).
    """
    column = cell_name[0]
    m = re.search(r'<x:c r="%s%d"[^>]*>(.*?)</x:c>' % (column, rid), xml, re.S)
    if m is None:
        raise SystemExit(f'{cell_name} not found')
    cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    merged = compose_narrative(xml_unescape(cur.group(1)) if cur else '', cell_name)
    new_cell = '<x:c r="%s%d" t="str"><x:v>%s</x:v></x:c>' % (column, rid, xml_escape(merged))
    return xml[:m.start()] + new_cell + xml[m.end():]


def set_marked_cell(xml, rid, col, marker, new_text,
                    stale_prefixes=(), stale_fragments=(), drop_unmarked=False,
                    plain=False):
    """Write a marked block into one cell of one row, keeping foreign blocks."""
    m = re.search(r'<x:c r="%s%d"[^>]*>(.*?)</x:c>' % (col, rid), xml, re.S)
    if m is None:
        raise SystemExit(f'{col}{rid} not found')
    cur = re.search(r'<x:v>(.*?)</x:v>', m.group(1), re.S)
    merged = merge_marked(xml_unescape(cur.group(1)) if cur else '', marker, new_text,
                          stale_prefixes, stale_fragments, drop_unmarked, plain)
    new_cell = '<x:c r="%s%d" t="str"><x:v>%s</x:v></x:c>' % (col, rid, xml_escape(merged))
    return xml[:m.start()] + new_cell + xml[m.end():]


def inflate_zip_entries(buf):
    """Return the zip members of `buf` as text.

    The workbook is written with the `x:` namespace prefix, which is why the
    member names and the XML tags below carry it. A member that is stored
    rather than deflated is read as-is.

    The archive is parsed by hand because the workbook has to be rewritten
    member by member without disturbing the ones that are not touched.
    """
    parts = {}
    eocd = -1
    for i in range(len(buf) - 22, -1, -1):
        if buf[i:i + 4] == b'PK\x05\x06':
            eocd = i
            break
    if eocd < 0:
        raise SystemExit('not a zip container')
    count = struct.unpack_from('<H', buf, eocd + 10)[0]
    off = struct.unpack_from('<I', buf, eocd + 16)[0]
    for _ in range(count):
        if buf[off:off + 4] != b'PK\x01\x02':
            break
        method = struct.unpack_from('<H', buf, off + 10)[0]
        comp_size = struct.unpack_from('<I', buf, off + 20)[0]
        name_len = struct.unpack_from('<H', buf, off + 28)[0]
        extra_len = struct.unpack_from('<H', buf, off + 30)[0]
        comment_len = struct.unpack_from('<H', buf, off + 32)[0]
        local_off = struct.unpack_from('<I', buf, off + 42)[0]
        name = buf[off + 46:off + 46 + name_len].decode('utf-8')
        # The local header repeats the name and the extra field, and both are
        # 16-bit -- reading the extra length as 32-bit lands past the entry.
        l_name_len = struct.unpack_from('<H', buf, local_off + 26)[0]
        l_extra_len = struct.unpack_from('<H', buf, local_off + 28)[0]
        data_start = local_off + 30 + l_name_len + l_extra_len
        raw = buf[data_start:data_start + comp_size]
        if method == 0:
            text = raw.decode('utf-8')
        else:
            text = zlib.decompress(raw, -zlib.MAX_WBITS).decode('utf-8')
        parts[name] = text
        off += 46 + name_len + extra_len + comment_len
    return parts


def read_parts(path=None):
    """Return {member name: text} for the workbook at `path` (default WBS)."""
    target = Path(path) if path else WBS
    with open(target, 'rb') as fh:
        return {k: _text(v) for k, v in inflate_zip_entries(fh.read()).items()}


def sheet_cells(parts, sheet_name):
    """Map row number -> {column letter: cell text} for one worksheet.

    The stored text is XML-escaped (see `xml_escape`), so it is decoded
    here: a reader sees the same plain text that a writer put in.
    """
    ss_xml = _text(parts.get(SHARED_STRINGS, ''))
    shared = [xml_unescape(re.sub(r'<[^>]+>', '', s))
              for s in re.findall(r'<x:si>(.*?)</x:si>', ss_xml, re.S)]
    xml = _text(parts[sheet_name])
    rows = {}
    for rm in re.finditer(r'<x:row[^>]*r="(\d+)"[^>]*>(.*?)</x:row>', xml, re.S):
        rid = int(rm.group(1))
        cells = {}
        for cm in re.finditer(r'<x:c r="([A-Z]+)\d+"([^>]*)>(.*?)</x:c>', rm.group(2), re.S):
            col, attrs, body = cm.group(1), cm.group(2), cm.group(3)
            vm = re.search(r'<x:v>(.*?)</x:v>', body, re.S)
            val = xml_unescape(vm.group(1)) if vm else ''
            if 't="s"' in attrs and val != '':
                val = shared[int(val)]
            cells[col] = val
        rows[rid] = cells
    return rows


def last_data_row(rows):
    """The last row of the 开发WBS sheet that carries a task.

    The sheet GREW: ATS-601 appended the mobile rows, so the range that the
    总览 formulas cover (6..N) is not a constant any more -- it is written
    into the workbook by whoever grew the sheet, and the derivations have to
    follow it. A derivation that kept the old constant would silently drop
    the appended rows from the totals, and the cached 总览 value would
    disagree with the formula that produced it.
    """
    last = FIRST_ROW - 1
    for rid, cells in rows.items():
        if rid < FIRST_ROW:
            continue
        if (cells.get('A') or '').startswith('ATS-'):
            last = max(last, rid)
    return last


def totals(parts=None):
    """Return the 总览 figures derived from the 开发WBS sheet.

    Returns a dict with `completed` (count of 已完成), `sum_estimate`
    (SUM of K), `sum_remaining` (SUM of P) and `completion_rate`
    (1 - SUM(P)/SUM(K), 0 when there is nothing to divide).

    THE ROW RANGE FOLLOWS THE SHEET, not a hardcoded constant: the sheet
    grew when ATS-601 appended the mobile rows, and the 总览 formulas in
    the workbook were grown with it. A derivation over the old constant
    would leave the cached 总览 value disagreeing with its own formula.
    """
    if parts is None:
        parts = read_parts()
    rows = sheet_cells(parts, SHEET2)
    completed = 0
    sum_estimate = 0.0
    sum_remaining = 0.0
    for rid in range(FIRST_ROW, last_data_row(rows) + 1):
        cells = rows.get(rid)
        if not cells:
            continue
        if not (cells.get('A') or '').startswith('ATS-'):
            continue
        if cells.get('N') == '已完成':
            completed += 1
        try:
            sum_estimate += float(cells.get('K') or 0)
        except ValueError:
            pass
        try:
            sum_remaining += float(cells.get('P') or 0)
        except ValueError:
            pass
    rate = 0.0 if sum_estimate == 0 else 1 - sum_remaining / sum_estimate
    return {
        'completed': completed,
        'sum_estimate': sum_estimate,
        'sum_remaining': sum_remaining,
        'completion_rate': rate,
    }
