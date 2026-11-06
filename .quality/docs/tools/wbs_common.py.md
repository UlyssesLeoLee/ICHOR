# Technical Design: `tools/wbs_common.py`

Source: `tools/wbs_common.py`

Source-SHA256: `68e5c294bbfc68dc1d0706f425e9a5e3b1996cc5dbf6c706efd190e164931c42`

## Responsibility

Shared helpers of every `tools/update_wbs_*.py` updater: reading the workbook zip by hand, reading and writing single cells while keeping styles and formulas, merging marked notes from several tasks into one cell in a canonical order, composing the 总览 narrative cells D6/D7 from per-task fragments, and deriving the 总览 totals from the 开发WBS sheet.

## Dependencies

- Upstream: Python standard library `re`, `struct`, `zlib`, `pathlib`.
- Downstream: every `tools/update_wbs_ats*.py` updater (ATS-101 … ATS-512, including `update_wbs_ats207.py`); `tools/ats501-probes/show-wbs-row.py`; `tools/ats501-probes/check-wbs-updaters.sh`; `tools/test_wbs_common.py`.

## Public Contract

- `MARKERS`: ordered tuple of the markers owned by the updaters; it is the canonical block order of `merge_marked`. It lists every updater's marker in WBS-ID order, including `【ATS-207】` between `【ATS-206】` and `【ATS-208】`.
- `NARRATIVE_FRAGMENTS[marker][cell]`: each task's contribution to D6/D7. ATS-207 contributes D6 `数据目录单实例锁与崩溃恢复已实现（ATS-207：原子抢锁、持有者校验、state.json 落盘同步、损坏镜像隔离重建）` and D7 `断电只以强杀进程模拟，未做真实掉电；桌面壳不显示占用提示；详见 docs/06-DATA-DESIGN.md §5.7`.
- Unchanged functions: `xml_escape`, `xml_unescape`, `format_rate`, `cell_text`, `cell_number`, `set_cell`, `set_cell_in_row`, `merge_marked`, `compose_narrative`, `set_narrative_cell`, `set_marked_cell`, `inflate_zip_entries`, `read_parts`, `sheet_cells`, `totals`.
- Invariant: a marker missing from `MARKERS` is invisible to the merge; `tools/test_wbs_common.py` therefore requires every updater's marker to be registered.

## Change Notes

ATS-207 registers its marker (canonical position after `【ATS-206】`) and its narrative fragments. No function changes. A concurrent task that also edits `MARKERS` produces a textual merge conflict on that line; the resolution is the union in WBS-ID order.
