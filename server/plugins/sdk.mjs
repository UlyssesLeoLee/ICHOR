/**
 * ATS-512 ｜ 插件 Runner SDK v1（Plugin Runner SDK）
 *
 * 这是**插件侧**调用的对象。它的每一个方法都做三件事：
 *
 *   1. **授权判定**：操作 → 权限 → 是否在生效权限集合内。不在 → 抛
 *      `PLUGIN_PERMISSION_DENIED` / `PLUGIN_OPERATION_UNSUPPORTED`，
 *      **并且照样记一条审计事件**（被拒的调用也是可审计的事实）。
 *   2. **作用域判定**：路径必须落在插件声明的作用域内，越界 → `PLUGIN_SCOPE_INVALID`。
 *   3. **留痕**：成功的调用与被拒的调用都进入宿主提供的 audit sink。
 *
 * **三条「插件做不到」的性质**（这就是 TR-10 的缓解落地）：
 *
 *   a. **插件不能抑制审计。** 审计 sink 由宿主构造并持有，SDK 只往里写。
 *      插件拿不到 sink 的引用，也没法把事件从序列里抹掉；SDK 的事件序号
 *      单调递增，且与 sink 已写入的条数一致。
 *   b. **插件不能伪造证据。** 证据的 SHA-256 由宿主的 resolver 计算，
 *      插件只能给出引用；`reportOutcome` 不接受插件自报的摘要。
 *   c. **插件不能自己批准自己的结论。** 结论是**提案**：`approval` 恒为
 *      `pending`，且提案人不得自审（与 ATS-401 的评审规则同一口径）。
 *
 * **宿主与隔离不在本模块范围内**：谁来加载插件、插件跑在哪个进程、怎么隔离
 * 归 ATS-502/503/506（远程面）与 ATS-403（沙箱）。这里交付的是 SDK 的**契约
 * 与操作面**。
 */
import {
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_OPERATIONS,
  PLUGIN_SDK_SURFACE,
  authorizePluginOperation,
  resolvePluginPermissions,
  validatePluginManifest,
} from './contract.mjs';

/**
 * 本模块自己实现一个「普通对象」判定，而不从 contract.mjs 导入：
 * contract.mjs 的 `isPlainObject` 是内部工具，不属于它的公开契约面。
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 提案人标识的前缀：插件提案人一律带这个前缀，评审自审检查靠它生效。 */
const PLUGIN_PRODUCER_PREFIX = 'plugin:';

function fail(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  throw err;
}

/**
 * 宿主提供的**读**接口。SDK 不自己碰文件系统——由宿主注入，插件因此
 * 无法绕过宿主的路径策略。
 *
 *   readTestFile(projectId, relativePath) -> { file, content, hash }
 *   readRequirements(projectId)          -> object
 *   readRunEvidence(projectId, runUid)   -> { runUid, artifacts: [...] }
 *
 * `resolveEvidenceDigest(projectId, runUid, artifact)` -> sha256 十六进制串
 * 由宿主计算（插件不可伪造）。
 */
function assertHost(host) {
  if (!isPlainObject(host)) fail('PLUGIN_MANIFEST_INVALID', 'host must be an object');
  for (const [name, fn] of Object.entries({
    readTestFile: 'readTestFile',
    readRequirements: 'readRequirements',
    readRunEvidence: 'readRunEvidence',
    resolveEvidenceDigest: 'resolveEvidenceDigest',
  })) {
    if (typeof host[name] !== 'function') {
      fail('PLUGIN_MANIFEST_INVALID', `host.${fn} must be a function`);
    }
  }
  // An audit sink is not optional. A host that cannot record events would
  // make every plugin call unauditable, so the SDK refuses to be built
  // rather than running without a trail.
  if (typeof host.audit !== 'function') {
    fail('PLUGIN_AUDIT_REQUIRED', 'host.audit must be a function: a plugin SDK without an audit sink is refused');
  }
  return host;
}

/**
 * 归一化宿主授予的作用域。作用域里的每一项都是「可读文件或目录前缀」，
 * 归一化成 POSIX 相对前缀。空的作用域 = 什么都读不到。
 */
function normalizeScope(scope) {
  if (scope === undefined || scope === null) return { files: [] };
  if (!isPlainObject(scope)) {
    fail('PLUGIN_MANIFEST_INVALID', 'scope must be an object');
  }
  const files = scope.files === undefined ? [] : scope.files;
  if (!Array.isArray(files)) {
    fail('PLUGIN_MANIFEST_INVALID', 'scope.files must be an array');
  }
  if (files.length > 200) {
    fail('PLUGIN_MANIFEST_INVALID', 'scope.files accepts at most 200 entries');
  }
  const normalized = [];
  for (const entry of files) {
    if (typeof entry !== 'string' || !entry.trim()) {
      fail('PLUGIN_MANIFEST_INVALID', 'scope.files entries must be non-empty strings');
    }
    if (entry.includes('\0')) {
      fail('PLUGIN_MANIFEST_INVALID', 'scope.files entries must not contain NUL');
    }
    if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
      fail('PLUGIN_MANIFEST_INVALID', 'scope.files entries must be relative paths');
    }
    const posix = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = posix.split('/');
    if (segments.some((s) => s === '..' || s === '')) {
      fail('PLUGIN_MANIFEST_INVALID', 'scope.files entries must not traverse upwards');
    }
    if (!normalized.includes(posix)) normalized.push(posix);
  }
  return { files: normalized };
}

/**
 * 作用域检查：路径必须是相对路径且落在宿主授予的作用域前缀内。
 *
 * 越界的路径**只报告**，不抛错——抛错由调用方（SDK 方法）来做，这样那里
 * 才能同时写一条审计事件。
 *
 * @returns {{ok: true, path: string}|{ok: false, reason: string}}
 */
function checkScopedPath(scope, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return { ok: false, reason: 'the path must be a non-empty string' };
  }
  if (relativePath.includes('\0')) {
    return { ok: false, reason: 'the path must not contain NUL' };
  }
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    return { ok: false, reason: 'the path must be relative' };
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..' || s === '')) {
    return { ok: false, reason: 'the path must not traverse upwards' };
  }
  for (const prefix of scope.files) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return { ok: true, path: normalized };
    }
  }
  return { ok: false, reason: 'the path is not inside the plugin scope' };
}

/**
 * 构造一个插件的 SDK 实例。
 *
 * @param {object} options
 * @param {object} options.manifest    插件清单（会被校验并归一化）
 * @param {object} options.host        宿主注入的读接口 + 审计 sink
 * @param {object} [options.scope]     **宿主**授予的作用域（可读文件前缀）
 * @param {string} [options.tier]      宿主策略档位（默认 readonly）
 * @param {string} [options.pluginId]  覆盖清单里的 id（用于多实例）
 */
export function createPluginSdk({ manifest, host, scope, tier, pluginId } = {}) {
  const normalized = validatePluginManifest(manifest);
  const effectiveTier = tier === undefined ? 'readonly' : tier;
  const resolution = resolvePluginPermissions(normalized.permissions, effectiveTier);
  const id = pluginId === undefined ? normalized.id : pluginId;
  const producer = `${PLUGIN_PRODUCER_PREFIX}${id}`;

  assertHost(host);

  // The scope is the HOST's decision, never the manifest's. A plugin that
  // could declare its own scope could widen its own file access, so the
  // manifest carries no scope field at all and the default is "nothing is
  // readable".
  const effectiveScope = normalizeScope(scope);

  let seq = 0;

  /**
   * 写一条审计事件。**这是 SDK 唯一的出口**：事件既不携带插件可写的
   * 「已审计」标记，也不允许插件传入自己的序号。
   */
  function audit(type, data) {
    seq += 1;
    host.audit({
      seq,
      at: new Date().toISOString(),
      pluginId: id,
      pluginVersion: normalized.version,
      type,
      data: data ?? {},
    });
    return seq;
  }

  /**
   * 授权闸门。被拒的调用**也**记审计事件——「插件试图越权」本身就是
   * 需要留痕的事实。
   */
  function authorize(operation) {
    const decision = authorizePluginOperation(normalized, operation, effectiveTier);
    if (decision.allowed) return decision;
    audit('plugin.operation.denied', {
      operation,
      permission: decision.permission,
      reason: decision.reason,
    });
    if (decision.permission === null) {
      fail('PLUGIN_OPERATION_UNSUPPORTED', `the plugin SDK has no operation '${operation}'`, {
        operation,
        known: [...PLUGIN_SDK_SURFACE],
      });
    }
    fail('PLUGIN_PERMISSION_DENIED', `the plugin is not allowed to call '${operation}'`, {
      operation,
      permission: decision.permission,
      reason: decision.reason,
    });
    return decision;
  }

  /**
   * 作用域闸门。越界的路径**也**记审计事件——插件试图读作用域外的文件
   * 是需要留痕的事实，与越权调用同级。
   */
  function scopePath(operation, relativePath) {
    const checked = checkScopedPath(effectiveScope, relativePath);
    if (checked.ok) return checked.path;
    audit('plugin.scope.denied', { operation, reason: checked.reason });
    fail('PLUGIN_SCOPE_INVALID', checked.reason, { path: relativePath });
    return checked.path;
  }

  const sdk = {
    /** SDK 的公开操作面。属性集合必须与 PLUGIN_OPERATIONS 的键完全相等。 */
    describe() {
      return {
        contract: PLUGIN_CONTRACT_VERSION,
        pluginId: id,
        pluginVersion: normalized.version,
        kind: normalized.kind,
        tier: effectiveTier,
        grantedPermissions: [...resolution.granted],
        deniedPermissions: resolution.denied.map((d) => ({ ...d })),
        sdkSurface: [...PLUGIN_SDK_SURFACE],
        auditSeq: seq,
      };
    },

    async readTestFile(projectId, relativePath) {
      authorize('readTestFile');
      const scoped = scopePath('readTestFile', relativePath);
      const result = await host.readTestFile(projectId, scoped);
      audit('plugin.test.read', { projectId, file: scoped });
      return result;
    },

    async readRequirements(projectId) {
      authorize('readRequirements');
      const result = await host.readRequirements(projectId);
      audit('plugin.requirements.read', { projectId });
      return result;
    },

    async readRunEvidence(projectId, runUid) {
      authorize('readRunEvidence');
      if (typeof runUid !== 'string' || !/^run_[0-9a-f-]{36}$/.test(runUid)) {
        fail('PLUGIN_SCOPE_INVALID', 'runUid must be a run id');
      }
      const result = await host.readRunEvidence(projectId, runUid);
      audit('plugin.evidence.read', { projectId, runUid });
      return result;
    },

    /**
     * 上报一次运行的结论。
     *
     * 这**不是**「设置 Run 终态」：SDK 产出的是一份**提案**——
     *   - `approval` 恒为 `pending`；
     *   - `evidenceRefs` 必须非空（无证据不上报）；
     *   - 每个证据引用的 SHA-256 由**宿主**算好，插件只能引用。
     */
    async reportOutcome(projectId, runUid, outcome) {
      authorize('reportOutcome');
      if (typeof runUid !== 'string' || !/^run_[0-9a-f-]{36}$/.test(runUid)) {
        fail('PLUGIN_SCOPE_INVALID', 'runUid must be a run id');
      }
      if (!isPlainObject(outcome)) {
        fail('PLUGIN_PROPOSAL_INVALID', 'outcome must be an object');
      }
      const summary = outcome.summary;
      if (typeof summary !== 'string' || !summary.trim() || summary.length > 2000) {
        fail('PLUGIN_PROPOSAL_INVALID', 'outcome.summary must be a non-empty string of at most 2000 characters');
      }
      const evidenceRefs = outcome.evidenceRefs;
      if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
        fail('PLUGIN_EVIDENCE_REQUIRED', 'an outcome must cite at least one evidence reference');
      }
      if (evidenceRefs.length > 64) {
        fail('PLUGIN_PROPOSAL_INVALID', 'outcome.evidenceRefs accepts at most 64 entries');
      }
      const resolved = [];
      for (const ref of evidenceRefs) {
        if (typeof ref !== 'string' || !ref.trim() || ref.length > 500) {
          fail('PLUGIN_PROPOSAL_INVALID', 'outcome.evidenceRefs entries must be non-empty strings');
        }
        // The digest comes from the HOST. A plugin-supplied digest is not
        // accepted at all -- otherwise the plugin could vouch for its own
        // evidence.
        const digest = await host.resolveEvidenceDigest(projectId, runUid, ref);
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
          fail('PLUGIN_EVIDENCE_REQUIRED', `the host could not resolve a digest for '${ref}'`, { ref });
        }
        resolved.push({ ref, sha256: digest });
      }
      const status = outcome.status;
      if (status !== undefined && !['passed', 'failed', 'flaky', 'skipped'].includes(status)) {
        fail('PLUGIN_PROPOSAL_INVALID', "outcome.status must be one of passed, failed, flaky, skipped");
      }
      const proposal = {
        proposalId: `plgprop_${id}_${seq + 1}`,
        contract: PLUGIN_CONTRACT_VERSION,
        pluginId: id,
        pluginVersion: normalized.version,
        projectId,
        runUid,
        kind: 'outcome',
        status: status === undefined ? null : status,
        summary,
        evidenceRefs: resolved,
        // The approval state is the host's, never the plugin's.
        approval: 'pending',
        producedBy: producer,
        createdAt: new Date().toISOString(),
      };
      audit('plugin.outcome.reported', {
        projectId,
        runUid,
        evidenceCount: resolved.length,
        approval: 'pending',
      });
      return proposal;
    },
  };

  // The SDK must not carry a single operation beyond the declared surface:
  // an extra method is an extra escape path.
  const extra = Object.keys(sdk).filter((k) => !PLUGIN_OPERATIONS[k]);
  if (extra.length) {
    fail('PLUGIN_MANIFEST_INVALID', `the SDK exposes operations outside the declared surface: ${extra.join(', ')}`);
  }
  const missing = PLUGIN_SDK_SURFACE.filter((k) => typeof sdk[k] !== 'function');
  if (missing.length) {
    fail('PLUGIN_MANIFEST_INVALID', `the SDK is missing declared operations: ${missing.join(', ')}`);
  }

  return Object.freeze(sdk);
}

/**
 * 评审一份插件提案。规则与 ATS-401 同一口径：
 *   - 只有 `pending` 提案可评审；
 *   - 提案人不得自审（归一化比较，不是精确字符串比较）。
 *
 * 评审**不**改提案内容，只改审批状态。
 */
export function reviewPluginProposal(proposal, { reviewer, decision, note } = {}) {
  if (!isPlainObject(proposal)) {
    fail('PLUGIN_REVIEW_STATE_INVALID', 'proposal must be an object');
  }
  if (typeof reviewer !== 'string' || !reviewer.trim()) {
    fail('PLUGIN_REVIEW_STATE_INVALID', 'reviewer must be a non-empty string');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    fail('PLUGIN_REVIEW_STATE_INVALID', "decision must be 'approved' or 'rejected'");
  }
  if (proposal.approval !== 'pending') {
    fail('PLUGIN_REVIEW_STATE_INVALID', 'only a pending proposal can be reviewed', {
      approval: proposal.approval,
    });
  }
  const normalize = (v) => String(v).trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalize(proposal.producedBy) === normalize(reviewer)) {
    fail('PLUGIN_REVIEW_SELF_FORBIDDEN', 'the producer of a proposal may not review it');
  }
  const reviewNote = note === undefined || note === null ? '' : String(note);
  if (reviewNote.length > 2000) {
    fail('PLUGIN_REVIEW_STATE_INVALID', 'review note exceeds 2000 characters');
  }
  return {
    ...proposal,
    approval: decision,
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString(),
    reviewNote,
  };
}
