# Technical Design: `tools/wbs_common.py`

Source: `tools/wbs_common.py`

Source-SHA256: `2c11affaa71e13e67dbe3e240556eeb2be9eee59a64331a98ab3e7f871e3ec64`

## Responsibility

Shared helpers of every `tools/update_wbs_*.py` updater: reading the workbook zip by hand, reading and writing single cells while keeping styles and formulas, merging marked notes from several tasks into one cell in a canonical order, composing the 总览 narrative cells D6/D7 from per-task fragments, and deriving the 总览 totals from the 开发WBS sheet.

## Dependencies

- Upstream: Python standard library `re`, `struct`, `zlib`, `pathlib`.
- Downstream: `tools/update_wbs_ats101.py`, `update_wbs_ats101_done.py`, `update_wbs_ats102.py`, `update_wbs_ats301.py`, `update_wbs_ats401.py`, `update_wbs_ats501.py`, `update_wbs_ats506.py`; `tools/ats501-probes/show-wbs-row.py`; `tools/ats501-probes/check-wbs-updaters.sh`; `tools/test_wbs_common.py`.

## Public Contract

- `MARKERS`: ordered tuple of the markers owned by the updaters; it is the canonical block order of `merge_marked`. ATS-506 adds `【ATS-506】` at the end.
- `NARRATIVE_FRAGMENTS[marker][cell]`: each task's contribution to D6/D7. ATS-506 contributes D6 `部署式控制面 API 边界骨架已实现（ATS-506：独立进程/端点/凭据，入站拒绝本地路径与本地 Token）` and D7 `控制面无持久化、用户认证仅有接口（OIDC 属 ATS-507）；详见 docs/21-CONTROL-PLANE-API.md`.
- Unchanged functions: `xml_escape`, `xml_unescape`, `format_rate`, `cell_text`, `cell_number`, `set_cell`, `set_cell_in_row`, `merge_marked`, `compose_narrative`, `set_narrative_cell`, `set_marked_cell`, `inflate_zip_entries`, `read_parts`, `sheet_cells`, `totals`.
- Invariant: a marker missing from `MARKERS` is invisible to the merge; `tools/test_wbs_common.py` therefore requires every updater's marker to be registered.

## Change Notes

ATS-506 registers its marker and narrative fragments; no function changes. The ATS-501 D6/D7 fragments stay true because the remote execution plane (queue, nodes) still has no implementation. A concurrent task that also appends a marker produces a textual merge conflict on the `MARKERS` line; the resolution is the union in WBS-ID order.
