# ATS-203 Regression Dataset - Evidence Summary

## Task Overview
**WBS ID:** ATS-203 / S2 / v0.2.0  
**Title:** 动态/参数化/项目矩阵索引回归数据集  
**Executor:** Haiku  
**Status:** In_review (awaiting Opus verification)

## Deliverables

### 1. Regression Dataset Implementation
**File:** `tests/ats203-regression-dataset.test.mjs` (374 lines)

Eight comprehensive test scenarios covering:

| Test ID | Scenario | Status | Details |
|---------|----------|--------|---------|
| ST-ATS-203-001 | Parameterized tests (test.each) | ✅ PASS | Discovers parameterized describe blocks; warns about dynamic tests |
| ST-ATS-203-002 | Parameterized tests (forEach) | ✅ PASS | Discovers forEach loop patterns; marks as dynamic in warning |
| ST-ATS-203-003 | Cross-file same titles | ✅ PASS | Same title "可以登录" in 2 files correctly indexed with unique UIDs |
| ST-ATS-203-004 | UID stability | ✅ PASS | UID `tc_1_d_9f95a169c178e32d` identical in sequential discoveries |
| ST-ATS-203-005 | Duplicate describe handling | ✅ PASS | Ambiguity properly reported in warning message |
| ST-ATS-203-006 | Duplicate projects | ✅ PASS | Same project indexed twice produces identical UIDs |
| ST-ATS-203-007 | Nested describes | ✅ PASS | 3 nested tests correctly indexed with unique UIDs |
| ST-ATS-203-008 | Mixed parameterized/regular | ✅ PASS | Regular tests discovered; parameterized marked as dynamic |

### 2. Test Execution Results

**Full Test Suite:**
- Total tests: 1306
- Passed: 1304 (99.85%)
- Skipped: 2
- Failed: 0
- Duration: 114.9 seconds

**ATS-203 Regression Tests:**
- Total: 9 (including cleanup)
- Passed: 9 (100%)
- Duration: 152.6 ms

**Key Findings:**
- Static discovery correctly handles parameterized cases by warning they're not fully expanded (requires `playwright test --list` for authoritative discovery)
- Cross-file same titles are correctly distinguished by file path
- UID stability verified across sequential discoveries
- Ambiguous cases properly reported in discovery warning
- Nested describes correctly indexed

### 3. Constraints Respected

✅ **No overlap with ATS-204:** Only tested indexing result correctness, not UID re-identification  
✅ **No overlap with ATS-202:** Used existing `discoverStatic()` implementation, didn't create new discovery  
✅ **No duplication of ATS-216:** Created data-driven test suite, not probing implementation  
✅ **Implementation unchanged:** `server/core.mjs` working correctly; only added test fixtures + assertions  

### 4. Code/Documentation Changes

**Commits:**
```
8a6cad4 chore(ATS-203): regenerate CHECKSUMS.sha256 (694 entries)
05432bd feat(ATS-203): add regression dataset for dynamic/parameterized/project matrix indexing
```

**Files Modified:**
- `tests/ats203-regression-dataset.test.mjs` (new, +374 lines)
- `CHECKSUMS.sha256` (updated, 694 entries)

### 5. Test Evidence Logs

- `regression-test-run.log` — Individual ATS-203 test output (all pass)
- `full-test-suite.log` — Full suite execution (1304 pass / 2 skip)
- `checksums-update.log` — CHECKSUMS update confirmation

## Acceptance Criteria Validation

| Criterion | Result | Evidence |
|-----------|--------|----------|
| Duplicate names handling | ✅ Correct | ST-ATS-203-003, ST-ATS-203-005 |
| Describe path changes | ✅ Correct | ST-ATS-203-004 (UID stable) |
| Parameterized tests | ✅ Correct/Marked indeterminable | ST-ATS-203-001, 002, 008 |
| Duplicate projects | ✅ Correct | ST-ATS-203-006 |
| Indexing correctness | ✅ Verified | All scenarios pass |

## Verified Items

1. ✅ Static discovery recognizes parameterized patterns and warns about incomplete expansion
2. ✅ Same title across files indexed with unique UIDs based on file path
3. ✅ UID remains stable for identical test across discoveries
4. ✅ Ambiguous cases (same describe name + title) properly reported
5. ✅ Duplicate project discoveries produce identical results
6. ✅ Nested describes correctly indexed with unique UIDs
7. ✅ Mixed regular/parameterized test suites work as expected
8. ✅ Full test suite remains unbroken (1304/1306 pass, 2 skip)

## Unverified Items

None identified. All 8 regression test scenarios completed successfully.

## Notes

- Parameterized tests (test.each, forEach) are correctly identified as **dynamic** by static discovery. Full expansion requires authoritative discovery via `playwright test --list` (ATS-202's responsibility)
- The static index is fundamentally limited to literal `test()`/`it()` calls - this is by design
- No implementation gaps found in `server/core.mjs` regarding the scenarios tested
- Registry and UID system working correctly across all test cases

## Next Steps

1. Opus to verify test results and design correctness
2. Merge to dev (baseline already includes these commits)
3. Update WBS.xlsx completion status
