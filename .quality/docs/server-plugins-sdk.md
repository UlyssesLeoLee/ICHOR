---
name: sdk-mjs-fix-ats512-r3
description: ATS-512 Round 3 - Plugin contract object aliasing fix
source: server/plugins/sdk.mjs
---

## Problem Statement

The plugin SDK currently hands the same object instance to both the host and the plugin, without freezing. Combined with shallow-copy storage by hosts, this creates object aliasing that allows plugins to tamper with the host's authoritative proposal record.

## Root Cause Analysis

1. **Identity leak (sdk.mjs:599, 627)**: The proposal object submitted to `host.submitProposal()` and returned to the plugin are the identical object (`submitted === returned`).
2. **Shallow storage (host implementations)**: Test hosts and example hosts use `{ ...proposal }` to store, creating a shallow copy. The `evidenceRefs` array and its entries remain shared with the plugin's copy.
3. **Result built from caller object (sdk.mjs:741-747)**: `reviewPluginProposal` builds its result by spreading `...proposal` (the caller's object), not the host's record. This means the result shares nested arrays with the plugin copy even after host deep-clones on store.

## Solution Design

### 1. Separate Object Instances (`reportOutcome`)

- Submit to host: `await host.submitProposal(deepFreeze(structuredClone(proposal)))`
- Return to plugin: `return structuredClone(proposal)` (unfrozen, independent)
- Ensures `submitted !== returned` and no nested array/object aliasing

### 2. Deep Freeze Host Record

- Use `structuredClone(proposal)` to create independent deep copy
- Apply `Object.freeze()` recursively to make host record immutable
- Plugin's copy can be mutated freely without affecting host record

### 3. Build Review Result from Host Record

- In `reviewPluginProposal` at line 741-747: build result from `structuredClone(record)` not `...proposal`
- Ensures review result is independent of plugin's copy
- Plugin post-approval mutations cannot reach the stored `approved` object

### 4. Deep-Copy Host Implementations

Change three shallow-copy hosts to use `structuredClone`:
- `tests/plugins.test.mjs:82`
- `tools/ats512-probes/probe-plugin-boundary.mjs:98`
- `tools/ats512-probes/check-review-counterexamples.mjs:42`

This serves the dual purpose of:
- Demonstrating SDK-level fix works regardless of host implementation
- Allowing discriminating tests with shallow/byRef hosts to prove SDK fix effectiveness

### 5. Test Coverage

Three types of tests needed:

**A. Evidence field tampering (only nested, no top-level changes)**
- Change only `evidenceRefs[].sha256` → line 673-677 (`a.sha256 !== b.sha256`)
- Change only `evidenceRefs[].ref` → line 673-677 (`a.ref !== b.ref`)
- Change only nested object type → line 672 (`!isPlainObject(a)`)
- Add/remove evidence entries → line 664-668 (length mismatch)

**B. Host implementation variants**
- Run nested-only tampering tests against shallow-copy host
- Run nested-only tampering tests against by-ref host
- Prove SDK-level fix prevents tampering regardless of host storage strategy

**C. Post-approval mutation**
- Approve a proposal
- Mutate plugin's local copy
- Verify `approved` object is unaffected (separate deep clone)

**D. Object identity and immutability**
- Verify submitted !== returned
- Verify host record is deeply frozen

## Coverage Requirements

- Strictly > 90% for `sdk.mjs` (currently 90.37%)
- Lines 664-668 (length mismatch check) must be executed
- Lines 673-677 (ref/sha256 mismatch check) must be executed
- New `deepFreeze` helper fully covered by tests

## References

- Opus R2 REJECT findings: issue comment 01a1b3f5-1f7c-738f-bb0f-3264a6601dcb
- Test probe: r2.mjs (scenarios R2-1 through R2-5)
- Coordinator task: Issue 01a1be5d-2342-79ed-97ad-d700aaf13744

## Implementation Phases

1. Add helper `deepFreeze()` function
2. Modify `reportOutcome()` submit and return logic
3. Modify `reviewPluginProposal()` result construction
4. Add discriminating tests (shallow/byRef hosts with nested-only tampering)
5. Add post-approval mutation test
6. Add identity/immutability assertions
7. Update host implementations to use `structuredClone`
8. Verify coverage and r2 probe results
