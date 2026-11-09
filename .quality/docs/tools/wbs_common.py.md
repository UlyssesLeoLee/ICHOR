# Technical Design: `tools/wbs_common.py`

Source: `tools/wbs_common.py`

Source-SHA256: `a46fffac9a7e4cba30829e54cef306da25162adc22fb6998087f9ce50a06f674`

## Responsibility

Shared helpers of every `tools/update_wbs_*.py` updater: reading the workbook zip by hand, reading and writing single cells while keeping styles and formulas, merging marked notes from several tasks into one cell in a canonical order, composing the 总览 narrative cells D6/D7 from per-task fragments, and deriving the 总览 totals from the 开发WBS sheet.

## Dependencies

- Upstream: Python standard library `re`, `struct`, `zlib`, `pathlib`.
- Downstream: every `tools/update_wbs_ats*.py` updater (ATS-101 … ATS-512, including `update_wbs_ats207.py`); `tools/ats501-probes/show-wbs-row.py`; `tools/ats501-probes/check-wbs-updaters.sh`; `tools/test_wbs_common.py`.

- Upstream: Python standard library `re`, `struct`, `zlib`, `pathlib`.
- Downstream: `tools/update_wbs_ats101.py`, `update_wbs_ats101_done.py`, `update_wbs_ats102.py`, `update_wbs_ats301.py`, `update_wbs_ats401.py`, `update_wbs_ats501.py`, `update_wbs_ats506.py`; `tools/ats501-probes/show-wbs-row.py`; `tools/ats501-probes/check-wbs-updaters.sh`; `tools/test_wbs_common.py`.

## Public Contract

- `MARKERS`: ordered tuple of the markers owned by the updaters; it is the canonical block order of `merge_marked`. It lists every updater's marker in WBS-ID order, including `【ATS-207】` between `【ATS-206】` and `【ATS-208】`, and `【ATS-601】` (the mobile execution plane updater) after `【ATS-512】`.
- `NARRATIVE_FRAGMENTS[marker][cell]`: each task's contribution to D6/D7. ATS-207 contributes D6 `数据目录单实例锁与崩溃恢复已实现（ATS-207：原子抢锁、持有者校验、state.json 落盘同步、损坏镜像隔离重建）` and D7 `断电只以强杀进程模拟，未做真实掉电；桌面壳不显示占用提示；详见 docs/06-DATA-DESIGN.md §5.7`.
- Unchanged functions: `xml_escape`, `xml_unescape`, `format_rate`, `cell_text`, `cell_number`, `set_cell`, `set_cell_in_row`, `merge_marked`, `compose_narrative`, `set_narrative_cell`, `set_marked_cell`, `inflate_zip_entries`, `read_parts`, `sheet_cells`, `totals`.
- Invariant: a marker missing from `MARKERS` is invisible to the merge; `tools/test_wbs_common.py` therefore requires every updater's marker to be registered.

- `MARKERS`: ordered tuple of the markers owned by the updaters; it is the canonical block order of `merge_marked`. ATS-506 adds `【ATS-506】` at the end.
- `NARRATIVE_FRAGMENTS[marker][cell]`: each task's contribution to D6/D7. ATS-506 contributes D6 `部署式控制面 API 边界骨架已实现（ATS-506：独立进程/端点/凭据，入站拒绝本地路径与本地 Token）` and D7 `控制面无持久化、用户认证仅有接口（OIDC 属 ATS-507）；详见 docs/21-CONTROL-PLANE-API.md`.
- Unchanged functions: `xml_escape`, `xml_unescape`, `format_rate`, `cell_text`, `cell_number`, `set_cell`, `set_cell_in_row`, `merge_marked`, `compose_narrative`, `set_narrative_cell`, `set_marked_cell`, `inflate_zip_entries`, `read_parts`, `sheet_cells`, `totals`.
- Invariant: a marker missing from `MARKERS` is invisible to the merge; `tools/test_wbs_common.py` therefore requires every updater's marker to be registered.

## Change Notes

ATS-207 registers its marker (canonical position after `【ATS-206】`) and its narrative fragments, and registers `【ATS-601】`, which `tools/update_wbs_ats601.py` declares; without it `tools/test_wbs_common.py` fails. No function changes. A concurrent task that also edits `MARKERS` produces a textual merge conflict on that line; the resolution is the union in WBS-ID order.

ATS-506 registers its marker and narrative fragments; no function changes. The ATS-501 D6/D7 fragments stay true because the remote execution plane (queue, nodes) still has no implementation. A concurrent task that also appends a marker produces a textual merge conflict on the `MARKERS` line; the resolution is the union in WBS-ID order.

ATS-106 registers `【ATS-106】` (the marker of `tools/update_wbs_ats106.py`); no function changes.
