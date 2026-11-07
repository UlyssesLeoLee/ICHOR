/**
 * ATS-512 ｜ 插件 Runner SDK v1（Plugin Runner SDK）
 *
 * 这是**插件侧**调用的对象。它的每一个方法都做四件事：
 *
 *   1. **授权判定**：操作 → 权限 → 是否在生效权限集合内。不在 → 抛
 *      `PLUGIN_PERMISSION_DENIED` / `PLUGIN_OPERATION_UNSUPPORTED`，
 *      **并且照样记一条审计事件**（被拒的调用也是可审计的事实）。
 *   2. **作用域判定**：路径必须落在宿主授予的作用域内、project 必须落在
 *      宿主授予的项目列表内；越界 → `PLUGIN_SCOPE_INVALID`，同样进审计。
 *   3. **留痕**：成功的调用与被拒的调用都进入宿主提供的 audit sink。
 *      **每次 SDK 调用恰好写一条事件**——包括宿主读取失败的那一次。
 *   4. **交回宿主**：提案连同它的证据摘要由 SDK **直接**交给宿主注入的
 *      `host.submitProposal`，插件不经手这份权威记录。
 *
 * **四条「插件做不到」的性质**（这就是 TR-10 的缓解落地）：
 *
 *   a. **插件不能抑制审计。** 审计 sink 由宿主构造并持有，SDK 只往里写。
 *      插件拿不到 sink 的引用，也没法把事件从序列里抹掉；SDK 的事件序号
 *      单调递增，且与 sink 已写入的条数一致——序号在 sink **写入成功之后**
 *      才前进，sink 抛错时事件没有落进序列，序号就停在原处。
 *   b. **插件不能伪造证据。** 证据的 SHA-256 由宿主的 resolver 计算，
 *      插件只能给出引用；`reportOutcome` 不接受插件自报的摘要。
 *   c. **插件不能自己批准自己的结论。** 结论是**提案**：`approval` 恒为
 *      `pending`，且提案人不得自审（与 ATS-401 的评审规则同一口径）。
 *   d. **插件不能伪造提案。** 宿主持有**权威提案记录**（`host.submitProposal`
 *      写入、`host.getProposal` 读出）。评审时比对的是这份记录，不是
 *      插件手里那份：宿主记录里没有的提案、以及字段或证据摘要与宿主记录
 *      不一致的提案，一律 `PLUGIN_PROPOSAL_INVALID`。
 *
 * **宿主与隔离不在本模块范围内**：谁来加载插件、插件跑在哪个进程、怎么隔离
 * 归 ATS-502/503/506（远程面）与 ATS-403（沙箱）。这里交付的是 SDK 的**契约
 * 与操作面**。
 */
import {
  DEFAULT_PLUGIN_POLICY_TIER,
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
 * 提案记录里必须与宿主权威记录逐字段一致的那些字段。
 *
 * `approval` 与 `createdAt` 不在其中：前者是评审**结果**，评审前后会变；
 * 后者是提交时刻的墙钟时间，宿主记录与插件副本可能差几毫秒，比它没有
 * 意义。真正要锁住的是**结论与证据**。
 */
const PROPOSAL_RECORD_FIELDS = Object.freeze([
  'contract',
  'proposalId',
  'pluginId',
  'pluginVersion',
  'projectId',
  'runUid',
  'kind',
  'status',
  'summary',
  'producedBy',
]);

/**
 * 提案 id：全局唯一。
 *
 * 唯一性不能靠「插件 id + 实例内序号」——同一个插件的两个 SDK 实例会
 * 撞号，而两份记录在宿主的权威存储里必须是两个不同的东西。这里用
 * CSPRNG 生成的 UUID，进程内、跨进程、跨机器都唯一。
 */
function newProposalId(pluginId) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) {
    fail(
      'PLUGIN_MANIFEST_INVALID',
      'this runtime has no crypto.randomUUID, so a globally unique proposal id cannot be issued',
    );
  }
  return `plgprop_${pluginId}_${uuid}`;
}

/**
 * 宿主提供的**读**接口与**权威提案存储**。SDK 不自己碰文件系统——由宿主
 * 注入，插件因此无法绕过宿主的路径策略。
 *
 *   readTestFile(projectId, relativePath) -> { file, content, hash }
 *   readRequirements(projectId)          -> object
 *   readRunEvidence(projectId, runUid)   -> { runUid, artifacts: [...] }
 *
 * `resolveEvidenceDigest(projectId, runUid, artifact)` -> sha256 十六进制串
 * 由宿主计算（插件不可伪造）。
 *
 * `submitProposal(proposal)` 把一份提案与它的证据摘要写入宿主的**权威
 * 记录**；`getProposal(proposalId)` 把那份记录读回来，供评审比对。
 */
function assertHost(host) {
  if (!isPlainObject(host)) fail('PLUGIN_MANIFEST_INVALID', 'host must be an object');
  for (const name of [
    'readTestFile',
    'readRequirements',
    'readRunEvidence',
    'resolveEvidenceDigest',
  ]) {
    if (typeof host[name] !== 'function') {
      fail('PLUGIN_MANIFEST_INVALID', `host.${name} must be a function`);
    }
  }
  // An audit sink is not optional. A host that cannot record events would
  // make every plugin call unauditable, so the SDK refuses to be built
  // rather than running without a trail.
  if (typeof host.audit !== 'function') {
    fail('PLUGIN_AUDIT_REQUIRED', 'host.audit must be a function: a plugin SDK without an audit sink is refused');
  }
  // The authoritative proposal record is not optional either. Without it the
  // proposal only ever exists in the plugin's hands -- which is exactly the
  // hole "the plugin does not bypass the review/evidence chain" must not
  // have. The SDK refuses to be built rather than producing unverifiable
  // proposals.
  if (typeof host.submitProposal !== 'function') {
    fail('PLUGIN_HOST_REQUIRED', 'host.submitProposal must be a function: the host holds the authoritative proposal record');
  }
  if (typeof host.getProposal !== 'function') {
    fail('PLUGIN_HOST_REQUIRED', 'host.getProposal must be a function: the review gate reads the authoritative proposal record from the host');
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
 * 归一化宿主授予的**项目**列表。
 *
 * 作用域有两层：可读哪些文件、可以碰哪些项目。两者都是宿主的决定，
 * 两者都默认为空——什么都不读、什么都碰不到。
 */
function normalizeProjects(projects) {
  if (projects === undefined || projects === null) return [];
  if (!Array.isArray(projects)) {
    fail('PLUGIN_MANIFEST_INVALID', 'projects must be an array');
  }
  if (projects.length > 200) {
    fail('PLUGIN_MANIFEST_INVALID', 'projects accepts at most 200 entries');
  }
  const normalized = [];
  for (const entry of projects) {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 200) {
      fail('PLUGIN_MANIFEST_INVALID', 'projects entries must be non-empty strings');
    }
    if (!normalized.includes(entry)) normalized.push(entry);
  }
  return normalized;
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
 * 授权闸门的**拒绝**部分：被拒时抛哪个错误码。
 *
 * 未知操作（`permission === null`）与权限不足是两种不同的拒绝，错误码
 * 不同。SDK 内部与对外导出的 `authorizePluginCall` 共用这一段，所以
 * 「未知操作」这条路径只有一处实现。
 */
function refuseOperation(operation, decision) {
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
}

/**
 * 对一次操作做授权判定，**不**审计。
 *
 * 宿主侧可以在派发之前先问一句「这个操作允许吗」。SDK 自己调用它，
 * 并且在拒绝时**另外**补一条审计事件——所以这个导出函数不写审计，
 * 它的用途是「问一句」，不是「执行」。
 *
 * @param {object} options
 * @param {object} options.manifest  插件清单
 * @param {string} options.operation 操作名
 * @param {string} [options.tier]    宿主策略档位
 * @returns {object} 允许时返回判定结果
 * @throws {Error} 被拒时抛 PLUGIN_OPERATION_UNSUPPORTED / PLUGIN_PERMISSION_DENIED
 */
export function authorizePluginCall({ manifest, operation, tier = DEFAULT_PLUGIN_POLICY_TIER } = {}) {
  const decision = authorizePluginOperation(manifest, operation, tier);
  if (!decision.allowed) refuseOperation(operation, decision);
  return decision;
}

/**
 * 构造一个插件的 SDK 实例。
 *
 * @param {object} options
 * @param {object} options.manifest    插件清单（会被校验并归一化）
 * @param {object} options.host        宿主注入的读接口 + 审计 sink + 权威提案存储
 * @param {object} [options.scope]     **宿主**授予的作用域（可读文件前缀）
 * @param {string[]} [options.projects] **宿主**授予的项目（可访问的 projectId）
 * @param {string} [options.tier]      宿主策略档位（默认 readonly）
 * @param {string} [options.pluginId]  覆盖清单里的 id（用于多实例）
 */
export function createPluginSdk({ manifest, host, scope, projects, tier, pluginId } = {}) {
  const normalized = validatePluginManifest(manifest);
  const effectiveTier = tier === undefined ? DEFAULT_PLUGIN_POLICY_TIER : tier;
  const resolution = resolvePluginPermissions(normalized.permissions, effectiveTier);
  const id = pluginId === undefined ? normalized.id : pluginId;
  const producer = `${PLUGIN_PRODUCER_PREFIX}${id}`;

  assertHost(host);

  // The scope is the HOST's decision, never the manifest's. A plugin that
  // could declare its own scope could widen its own file access, so the
  // manifest carries no scope field at all and the default is "nothing is
  // readable".
  const effectiveScope = normalizeScope(scope);
  // The same reasoning applies to the projects: a file scope that is not
  // bound to a project would let a plugin read another tenant's tests
  // through its own scope. Default: no project is reachable.
  const grantedProjects = normalizeProjects(projects);

  let seq = 0;

  /**
   * 写一条审计事件。**这是 SDK 唯一的出口**：事件既不携带插件可写的
   * 「已审计」标记，也不允许插件传入自己的序号。
   *
   * 序号在 sink **写入成功之后**才前进：sink 抛错说明这条事件没有落进
   * 序列，序号必须停在原处，「序号与 sink 已写入的条数一致」才不是一句
   * 空话。
   */
  function audit(type, data) {
    const next = seq + 1;
    host.audit({
      seq: next,
      at: new Date().toISOString(),
      pluginId: id,
      pluginVersion: normalized.version,
      type,
      data: data ?? {},
    });
    seq = next;
    return seq;
  }

  /**
   * 记一条**被拒**事件，然后抛出拒绝。
   *
   * 「插件试图越权 / 试图跳过证据 / 试图读别的项目」是需要留痕的事实，
   * 与成功的调用同级。
   */
  function refuse(code, eventType, data, message, details) {
    audit(eventType, data);
    fail(code, message, details);
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
    refuseOperation(operation, decision);
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

  /**
   * 项目闸门。宿主只授予了哪几个项目，插件就只能碰哪几个；其余项目
   * 一律拒绝并审计。
   */
  function scopeProject(operation, projectId) {
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200) {
      refuse(
        'PLUGIN_SCOPE_INVALID',
        'plugin.project.denied',
        { operation, projectId: String(projectId ?? ''), reason: 'the project id must be a non-empty string' },
        'the project id must be a non-empty string',
      );
    }
    if (!grantedProjects.includes(projectId)) {
      refuse(
        'PLUGIN_SCOPE_INVALID',
        'plugin.project.denied',
        { operation, projectId, reason: 'the project is outside the host-granted project scope' },
        'the project is outside the host-granted project scope',
        { projectId },
      );
    }
    return projectId;
  }

  /**
   * 跑一次宿主读取，然后**恰好**写一条审计事件——成功与失败都写。
   *
   * 失败的那次读取恰恰是最需要留痕的事实，所以事件在读取**之后**写，
   * 但它一定写。sink 自己抛错时，读取的错误更重要（它说明宿主那边出了
   * 什么事），所以它胜出，sink 的错误挂在它的 cause 上；读取成功而 sink
   * 失败时，异常照抛——一次没有留下记录的调用不允许看起来是成功的。
   */
  async function auditedHostRead(eventType, data, run) {
    let result;
    let failure = null;
    try {
      result = await run();
    } catch (error) {
      failure = error;
    }
    const payload = { ...data, outcome: failure ? 'failed' : 'ok' };
    if (failure) payload.error = failure.code || failure.message;
    if (failure) {
      try {
        audit(eventType, payload);
      } catch (auditError) {
        failure.cause = failure.cause ?? auditError;
      }
      throw failure;
    }
    audit(eventType, payload);
    return result;
  }

  const sdk = {
    /** SDK 的公开操作面。属性集合必须与 PLUGIN_OPERATIONS 的键完全相等。 */
    describe() {
      // describe() 是 SDK 的一个操作，所以它也进审计——否则「每一次 SDK
      // 调用都留下痕迹」这句话就有一个例外，而例外正是插件会去找的地方。
      audit('plugin.describe', { tier: effectiveTier, projects: [...grantedProjects] });
      return {
        contract: PLUGIN_CONTRACT_VERSION,
        pluginId: id,
        pluginVersion: normalized.version,
        kind: normalized.kind,
        tier: effectiveTier,
        grantedPermissions: [...resolution.granted],
        deniedPermissions: resolution.denied.map((d) => ({ ...d })),
        grantedProjects: [...grantedProjects],
        sdkSurface: [...PLUGIN_SDK_SURFACE],
        auditSeq: seq,
      };
    },

    async readTestFile(projectId, relativePath) {
      authorize('readTestFile');
      scopeProject('readTestFile', projectId);
      const scoped = scopePath('readTestFile', relativePath);
      return auditedHostRead(
        'plugin.test.read',
        { projectId, file: scoped },
        () => host.readTestFile(projectId, scoped),
      );
    },

    async readRequirements(projectId) {
      authorize('readRequirements');
      scopeProject('readRequirements', projectId);
      return auditedHostRead(
        'plugin.requirements.read',
        { projectId },
        () => host.readRequirements(projectId),
      );
    },

    async readRunEvidence(projectId, runUid) {
      authorize('readRunEvidence');
      scopeProject('readRunEvidence', projectId);
      if (typeof runUid !== 'string' || !/^run_[0-9a-f-]{36}$/.test(runUid)) {
        refuse(
          'PLUGIN_SCOPE_INVALID',
          'plugin.run.denied',
          { operation: 'readRunEvidence', runUid: String(runUid) },
          'runUid must be a run id');
      }
      return auditedHostRead(
        'plugin.evidence.read',
        { projectId, runUid },
        () => host.readRunEvidence(projectId, runUid),
      );
    },

    /**
     * 上报一次运行的结论。
     *
     * 这**不是**「设置 Run 终态」：SDK 产出的是一份**提案**——
     *   - `approval` 恒为 `pending`；
     *   - `evidenceRefs` 必须非空（无证据不上报）；
     *   - 每个证据引用的 SHA-256 由**宿主**算好，插件只能引用；
     *   - 提案连同摘要**直接**交给宿主的权威存储（`host.submitProposal`），
     *     插件手里那份不是权威记录，评审比对的是宿主那一份。
     */
    async reportOutcome(projectId, runUid, outcome) {
      authorize('reportOutcome');
      scopeProject('reportOutcome', projectId);
      if (typeof runUid !== 'string' || !/^run_[0-9a-f-]{36}$/.test(runUid)) {
        refuse(
          'PLUGIN_SCOPE_INVALID',
          'plugin.run.denied',
          { operation: 'reportOutcome', runUid: String(runUid) },
          'runUid must be a run id');
      }
      if (!isPlainObject(outcome)) {
        refuse(
          'PLUGIN_PROPOSAL_INVALID',
          'plugin.proposal.refused',
          { operation: 'reportOutcome', reason: 'outcome must be an object' },
          'outcome must be an object');
      }
      const summary = outcome.summary;
      if (typeof summary !== 'string' || !summary.trim() || summary.length > 2000) {
        refuse(
          'PLUGIN_PROPOSAL_INVALID',
          'plugin.proposal.refused',
          { operation: 'reportOutcome', reason: 'outcome.summary is missing or too long' },
          'outcome.summary must be a non-empty string of at most 2000 characters');
      }
      const evidenceRefs = outcome.evidenceRefs;
      if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
        refuse(
          'PLUGIN_EVIDENCE_REQUIRED',
          'plugin.proposal.refused',
          { operation: 'reportOutcome', reason: 'the outcome cites no evidence' },
          'an outcome must cite at least one evidence reference');
      }
      if (evidenceRefs.length > 64) {
        refuse(
          'PLUGIN_PROPOSAL_INVALID',
          'plugin.proposal.refused',
          { operation: 'reportOutcome', reason: 'too many evidence references' },
          'outcome.evidenceRefs accepts at most 64 entries');
      }
      const resolved = [];
      for (const ref of evidenceRefs) {
        if (typeof ref !== 'string' || !ref.trim() || ref.length > 500) {
          refuse(
            'PLUGIN_PROPOSAL_INVALID',
            'plugin.proposal.refused',
            { operation: 'reportOutcome', reason: 'an evidence reference is not a string' },
            'outcome.evidenceRefs entries must be non-empty strings');
        }
        // The digest comes from the HOST. A plugin-supplied digest is not
        // accepted at all -- otherwise the plugin could vouch for its own
        // evidence.
        let digest = null;
        let resolutionFailure = null;
        try {
          digest = await host.resolveEvidenceDigest(projectId, runUid, ref);
        } catch (error) {
          resolutionFailure = error;
        }
        if (resolutionFailure || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
          refuse(
            'PLUGIN_EVIDENCE_REQUIRED',
            'plugin.proposal.refused',
            {
              operation: 'reportOutcome',
              reason: 'the host could not resolve a digest for the reference',
              ref,
              error: resolutionFailure ? (resolutionFailure.code || resolutionFailure.message) : null,
            },
            `the host could not resolve a digest for '${ref}'`,
            { ref });
        }
        resolved.push({ ref, sha256: digest });
      }
      const status = outcome.status;
      if (status !== undefined && !['passed', 'failed', 'flaky', 'skipped'].includes(status)) {
        refuse(
          'PLUGIN_PROPOSAL_INVALID',
          'plugin.proposal.refused',
          { operation: 'reportOutcome', reason: 'outcome.status is not a known status' },
          'outcome.status must be one of passed, failed, flaky, skipped');
      }
      const proposal = {
        proposalId: newProposalId(id),
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
      // The proposal and its evidence digests go into the HOST's authoritative
      // record -- straight from the SDK, never through the plugin. The host
      // is what a reviewer later compares against.
      let submissionFailure = null;
      try {
        await host.submitProposal(proposal);
      } catch (error) {
        submissionFailure = error;
      }
      if (submissionFailure) {
        refuse(
          'PLUGIN_PROPOSAL_INVALID',
          'plugin.proposal.refused',
          {
            operation: 'reportOutcome',
            reason: 'the host refused the proposal record',
            proposalId: proposal.proposalId,
            error: submissionFailure.code || submissionFailure.message,
          },
          'the host refused the proposal record',
          { proposalId: proposal.proposalId });
      }
      audit('plugin.outcome.reported', {
        projectId,
        runUid,
        proposalId: proposal.proposalId,
        evidenceCount: resolved.length,
        // The digests go into the audit trail too: after the fact the reviewer
        // can tell WHICH evidence the proposal was about, even if the
        // plugin's copy of the proposal is gone or edited.
        evidenceDigests: resolved.map((entry) => ({ ref: entry.ref, sha256: entry.sha256 })),
        approval: 'pending',
      });
      return proposal;
    },
  };

  // The SDK must not carry a single operation beyond the declared surface:
  // an extra method is an extra escape path.
  const extra = Object.keys(sdk).filter((k) => !Object.prototype.hasOwnProperty.call(PLUGIN_OPERATIONS, k));
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
 * 比对一份提案与宿主的**权威记录**。
 *
 * 只有形状相同是不够的：被篡改过的提案形状完全合法（摘要换成一个别的
 * 哈希、producedBy 换成别人），所以这里比的是**内容**——每一个字段，
 * 以及每一条证据引用的 ref 与 sha256。
 */
function assertMatchesHostRecord(proposal, record) {
  for (const field of PROPOSAL_RECORD_FIELDS) {
    if (proposal[field] !== record[field]) {
      fail('PLUGIN_PROPOSAL_INVALID', `the proposal does not match the host record at '${field}'`, {
        field,
        proposalId: proposal.proposalId,
      });
    }
  }
  const offered = Array.isArray(proposal.evidenceRefs) ? proposal.evidenceRefs : [];
  const held = Array.isArray(record.evidenceRefs) ? record.evidenceRefs : [];
  if (offered.length !== held.length) {
    fail('PLUGIN_PROPOSAL_INVALID', "the proposal does not match the host record at 'evidenceRefs'", {
      field: 'evidenceRefs',
      proposalId: proposal.proposalId,
    });
  }
  for (let index = 0; index < held.length; index += 1) {
    const a = offered[index];
    const b = held[index];
    if (!isPlainObject(a) || !isPlainObject(b) || a.ref !== b.ref || a.sha256 !== b.sha256) {
      fail('PLUGIN_PROPOSAL_INVALID', `the proposal does not match the host record at 'evidenceRefs[${index}]'`, {
        field: 'evidenceRefs',
        proposalId: proposal.proposalId,
      });
    }
  }
}

/**
 * 评审一份插件提案。规则与 ATS-401 同一口径：
 *   - 只有 `pending` 提案可评审；
 *   - 提案人不得自审（归一化比较，不是精确字符串比较）；
 *   - **宿主必须持有这份提案**：宿主记录里没有的、或者字段与证据摘要
 *     与宿主记录不一致的，一律 `PLUGIN_PROPOSAL_INVALID`。
 *
 * 评审**不**改提案内容，只改审批状态。
 *
 * @param {object} proposal  待评审的提案
 * @param {object} options
 * @param {string} options.reviewer  评审人标识
 * @param {'approved'|'rejected'} options.decision  评审结论
 * @param {string} [options.note]    评审备注
 * @param {object} options.host       **宿主**：持有权威提案记录，必须提供
 *                                    同步的 `getProposal(proposalId)`
 */
export function reviewPluginProposal(proposal, { reviewer, decision, note, host } = {}) {
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
  // The authoritative record lives with the host. Without it the review has
  // nothing to compare against, so it is refused rather than trusted.
  if (!isPlainObject(host) || typeof host.getProposal !== 'function') {
    fail('PLUGIN_REVIEW_STATE_INVALID', 'the host must provide the proposal store that holds the authoritative record');
  }
  const record = host.getProposal(proposal.proposalId);
  if (record && typeof record.then === 'function') {
    fail('PLUGIN_REVIEW_STATE_INVALID', 'host.getProposal must be synchronous: the review gate compares the proposal with the host record in one step');
  }
  if (!isPlainObject(record)) {
    fail('PLUGIN_PROPOSAL_INVALID', 'the host does not hold this proposal', {
      proposalId: proposal.proposalId,
    });
  }
  if (record.approval !== 'pending') {
    fail('PLUGIN_REVIEW_STATE_INVALID', 'the host record is not pending any more', {
      approval: record.approval,
    });
  }
  assertMatchesHostRecord(proposal, record);
  return {
    ...proposal,
    approval: decision,
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString(),
    reviewNote,
  };
}
