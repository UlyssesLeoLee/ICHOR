---
name: sdk-mjs-test-design-r3
description: Test cases for ATS-512 R3 plugin contract object aliasing fixes
source: tests/plugins.test.mjs
---

## Test Categories

### 1. Evidence Field Tampering (Discriminating - Shallow/ByRef Hosts)

**Purpose**: Prove that SDK-level deep-cloning fix prevents tampering even when host uses shallow copy or by-reference storage.

#### UT-PLG-061-A: Shallow host, tamper only sha256
- **Setup**: Host using `{ ...proposal }` shallow copy
- **Input**: Valid proposal with evidenceRefs: [{ref: 'trace.zip', sha256: 'aaaa...'}]
- **Tamper**: Plugin obtains returned proposal, clones it, edits `proposal.evidenceRefs[0].sha256 = 'ffff...'` (ONLY this field, not producedBy or top-level fields)
- **Action**: Submit tampered copy to `reviewPluginProposal()`
- **Expected**: PLUGIN_PROPOSAL_INVALID (evidence sha256 mismatch vs host record)
- **Line Coverage**: sdk.mjs:673-677 (sha256 !== check)

#### UT-PLG-061-B: Shallow host, tamper only ref
- **Setup**: Host using `{ ...proposal }` shallow copy
- **Input**: Valid proposal with evidenceRefs: [{ref: 'trace.zip', sha256: 'aaaa...'}]
- **Tamper**: Plugin obtains returned proposal, clones it, edits `proposal.evidenceRefs[0].ref = 'someone-elses-trace.zip'` (ONLY this field)
- **Action**: Submit tampered copy to `reviewPluginProposal()`
- **Expected**: PLUGIN_PROPOSAL_INVALID (evidence ref mismatch vs host record)
- **Line Coverage**: sdk.mjs:673-677 (ref !== check)

#### UT-PLG-061-C: ByRef host, tamper only sha256
- **Setup**: Host using `proposals.set(id, p)` by-reference storage
- **Input**: Valid proposal with evidenceRefs
- **Tamper**: Same as UT-PLG-061-A but with byRef host
- **Expected**: PLUGIN_PROPOSAL_INVALID
- **Note**: Proves byRef host doesn't enable tampering under SDK fix

#### UT-PLG-061-D: ByRef host, tamper only ref
- **Setup**: Host using by-reference storage
- **Tamper**: Same as UT-PLG-061-B but with byRef host
- **Expected**: PLUGIN_PROPOSAL_INVALID

### 2. Evidence Entry Manipulation

**Purpose**: Cover the evidence array length check (sdk.mjs:664-668).

#### UT-PLG-061-E: Add evidence entry
- **Input**: Proposal with evidenceRefs: [{...}] (length 1)
- **Tamper**: Plugin clones returned proposal, adds `evidenceRefs.push({ref: 'fake', sha256: 'ffff...'})`
- **Action**: `reviewPluginProposal()`
- **Expected**: PLUGIN_PROPOSAL_INVALID (length mismatch)
- **Line Coverage**: sdk.mjs:663-667 (length check)

#### UT-PLG-061-F: Remove evidence entry
- **Input**: Proposal with evidenceRefs: [{...}, {...}] (length 2)
- **Tamper**: Plugin clones returned proposal, sets `evidenceRefs = []`
- **Action**: `reviewPluginProposal()`
- **Expected**: PLUGIN_PROPOSAL_INVALID (length mismatch)

### 3. Evidence Entry Type Violation

**Purpose**: Cover the `isPlainObject` check at sdk.mjs:672.

#### UT-PLG-061-G: Replace entry with non-object
- **Input**: Proposal with evidenceRefs: [{ref, sha256}]
- **Tamper**: Plugin clones, sets `evidenceRefs[0] = 'not-an-object'`
- **Action**: `reviewPluginProposal()`
- **Expected**: PLUGIN_PROPOSAL_INVALID
- **Line Coverage**: sdk.mjs:672 (isPlainObject checks)

### 4. Post-Approval Mutation Independence

**Purpose**: Verify that result object is independent from plugin's copy (R2-5 scenario).

#### UT-NEW-POST-APPROVAL-MUTATION
- **Setup**: Deep-copy host (control)
- **Input**: Valid proposal with evidenceRefs: [{ref: 'trace.zip', sha256: 'aaaa...'}]
- **Action 1**: `const approved = reviewPluginProposal(proposal, {reviewer: 'alice', decision: 'approved', host})`
- **Action 2**: Plugin mutates its local copy: `proposal.evidenceRefs[0].sha256 = 'ffff...'`
- **Assertion 1**: `approved.evidenceRefs[0].sha256 === 'aaaa...'` (unchanged)
- **Assertion 2**: `approved !== proposal` (different objects)
- **Assertion 3**: `approved.evidenceRefs !== proposal.evidenceRefs` (arrays not shared)
- **Note**: Proves result built from host record, not caller's object

### 5. Object Identity and Immutability

**Purpose**: Verify SDK design constraints are enforced (R2-3 scenario).

#### UT-NEW-OBJECT-IDENTITY-AND-FREEZE
- **Setup**: Create SDK and track submitted vs returned objects
- **Action**: Call `reportOutcome()` and capture both submitted (via mocked host) and returned objects
- **Assertion 1**: `submitted !== returned` (distinct objects)
- **Assertion 2**: `Object.isFrozen(submitted) === true` (host copy frozen)
- **Assertion 3**: `Object.isFrozen(submitted.evidenceRefs[0]) === true` (nested frozen)
- **Assertion 4**: `Object.isFrozen(returned) === false` (plugin copy unfrozen)
- **Note**: Validates "plugin does not handle the host's authoritative record" (sdk.mjs:13-14)

## Test Environment Setup

### Host Variants

```javascript
// Default (deep-copy with freeze)
makeHost()

// Shallow copy (for discriminating tests)
makeHostShallow() => { proposals.set(id, { ...proposal }) }

// By-reference (for discriminating tests)
makeHostByRef() => { proposals.set(id, proposal) }
```

## Coverage Requirements

Target: > 90% for sdk.mjs

**Must-hit lines:**
- 599: submitProposal call
- 627: return proposal
- 664-668: evidence entry length check (evidenceRefs.length mismatch)
- 673-677: evidence entry detail check (ref/sha256 mismatch or non-object)
- 741-747: review result construction from record

**New lines:**
- deepFreeze helper (full coverage via Object.isFrozen assertions)

## Regression Tests

Existing tests (e.g., UT-PLG-062, UT-PLG-063) must continue passing:
- Host rejection during submitProposal
- Review without host record
- Reviewer/producer identification checks
- Normal approval flow with unmodified proposal
