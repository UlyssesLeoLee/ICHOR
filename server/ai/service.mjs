/**
 * ATS-403 ｜ 模型调用服务（Service）
 *
 * ATS-402 管「密钥与外传授权」，ATS-403 管「协议、回退与传输」，本模块把
 * 这两者**接起来**：一次真实的模型调用要走完
 *
 *   外传闸门（ATS-402）→ 密钥解析（ATS-402）→ 回退链（ATS-403）
 *
 * **ATS-401 的契约层不在这条链上**：`complete()` 不经过契约层，
 * `asContractProvider()` 在仓库里没有调用方。契约收敛仍是 ATS-401 的事，
 * 本模块不声称已经接入。
 *
 * 四条硬规则，每一条都在本模块里有对应代码与可机读的断言：
 *
 *   1. **没有授权就不发请求。** 外传闸门先判（`authorizeEgress`），判不过
 *      就**不读文件、不取密钥、不发请求**，并把这次拒绝写进外传审计。
 *   2. **发出去的就是被授权的那一份。** 发给提供商的输入取自闸门读出并
 *      复算过摘要的 `verdict.inputs`，**不采用**调用方给的
 *      `request.inputs[].content`（那完全由调用方控制）。于是外传审计记的
 *      与实际发出的必然一致（见 `bindRequestToConsent`）。
 *   3. **密钥只来自凭据库。** `credentialStore.resolve(id, 'ai-provider')`
 *      是唯一入口；配置里不允许有明文密钥（见 `protocols.mjs`）。
 *   4. **失败不污染工作区。** 本模块**不写任何文件**：没有缓存、没有临时
 *      文件、没有「失败也留一份」的痕迹。超时或限流时，工作区一个字节都
 *      不变——这一点由 `tools/ats403-probes/probe-ai-boundary.mjs` 用
 *      「调用前后目录摘要逐字节相同」实测。
 *
 * **审计不可用时不外发**：审计存储缺失时闸门**不做出决定**
 * （`allowed === null`，`AI_AUDIT_UNAVAILABLE`），`complete()` 因此不发送
 * 任何请求——一次「放行但没有留痕」的外发事后既无法证明也无法追查。
 *
 * **多步执行**（`maxSteps`）：ATS-401 只校验 `maxSteps` 的上限，没有施加它；
 * 本模块把它落成「最多几步」的硬约束，步数用尽即 `AI_STEPS_EXCEEDED`；
 * 不可回退的错误**保留自己的错误码**，不被改标成「步数用尽」。
 */
import { aiError, isRetryableAiError } from './errors.mjs';
import { asContractProvider, createAiProvider } from './provider.mjs';
import { createFallbackChain } from './fallback.mjs';
import { authorizeEgress } from '../security/egress-gate.mjs';

/**
 * 取一个错误的**根本原因码**。
 *
 * 回退链把「链上每个提供商都失败了」报成 `AI_FALLBACK_EXHAUSTED`，而真正
 * 的原因在它的 `details.attempts` 里（最后一个尝试的码）。只报
 * `AI_FALLBACK_EXHAUSTED` 会让调用方以为「再配一个提供商也许有用」，而
 * 实际原因可能只是「密钥错了」——那是配多少个提供商都没用的。
 *
 * @param {object} error
 * @returns {string} 根本原因码
 */
export function rootCauseCode(error) {
  const code = error && error.code ? error.code : 'AI_PROVIDER_UNAVAILABLE';
  if (code !== 'AI_FALLBACK_EXHAUSTED') return code;
  const attempts = error?.details?.attempts;
  if (!Array.isArray(attempts)) return code;
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const attempt = attempts[i];
    if (attempt && attempt.ok === false && attempt.code) return attempt.code;
  }
  return code;
}

/**
 * 把一次请求的输入**绑定到已被授权的那一份**。
 *
 * 这是外传闸门与适配层之间的那一步，也是「授权的是什么，发出去的就是什么」
 * 这条保证的落点：
 *
 *   - **发出去的输入**来自 `verdict.inputs`——平台侧从项目里读出来的真实内容，
 *     摘要已被复算并与同意书核对过；
 *   - **调用方给的 `request.inputs[].content`** 一律**不采用**。调用方的正文
 *     完全由它自己控制，如果直接发出去，一份针对 `tests/home.spec.ts` 的授权
 *     就能被用来发送任意文本（哪怕引用的是另一个文件）。
 *
 * 调用方的 `instructions`（模型指令）予以保留：它是**指令**而不是**输入内容**，
 * 不构成外传的项目数据。
 *
 * @param {object} request     调用方的统一请求
 * @param {Array}  consented   闸门放行的输入（平台读出并核对过摘要）
 * @returns {object} 绑定后的统一请求
 */
export function bindRequestToConsent(request, consented) {
  const source = request && typeof request === 'object' ? request : {};
  const inputs = Array.isArray(consented) ? consented : [];
  return {
    ...source,
    instructions: typeof source.instructions === 'string' ? source.instructions : '',
    // The CONTENT comes from the consented inputs. Only the descriptor
    // fields (kind/ref/digest) are carried over from the caller's own
    // request, and only to describe the same inputs the gate approved.
    inputs: inputs.map((input) => ({
      kind: input?.kind ?? 'file',
      ref: input?.ref ?? '',
      digest: input?.digest ?? '',
      content: typeof input?.content === 'string' ? input.content : '',
    })),
  };
}

/**
 * 创建一个模型调用服务。
 *
 * @param {object} options
 * @param {object} options.credentialStore  ATS-402 的凭据存储
 * @param {object} options.consentStore    ATS-402 的外传授权存储
 * @param {object} options.auditStore      ATS-402 的外传审计存储
 * @param {Function} options.getProject     由项目 id 取项目（{ id, root }）
 * @param {Function}[options.runResolver]  run 类输入的解析器
 * @param {Function}[options.now]          当前时间（毫秒）
 */
export function createModelService({
  credentialStore,
  consentStore,
  auditStore,
  getProject,
  runResolver,
  now = () => Date.now(),
  // The transport is injectable so that "no request left the machine" is a
  // MEASUREMENT (the injected fetch was not called) rather than an
  // assumption. The production wiring does not pass one.
  transport,
} = {}) {
  if (!credentialStore || typeof credentialStore.resolve !== 'function') {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'a credential store with resolve() is required');
  }
  if (!consentStore || typeof consentStore.check !== 'function') {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'a consent store with check() is required');
  }
  if (typeof getProject !== 'function') {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'getProject is required');
  }

  /**
   * 判定一次外传是否被允许，并**无论放行与否都留痕**。
   *
   * The verdict is a THREE-state answer, and the third state matters:
   *
   *   - `allowed === true`   the egress is allowed (and the decision recorded);
   *   - `allowed === false`  the egress is REFUSED (consent or scope);
   *   - `allowed === null`   **no decision was made** -- the platform cannot
   *     record egress decisions (the audit store is missing), so it must not
   *     claim that it decided anything. This is NOT the same as a refusal:
   *     a refusal is a decision about the content, this is a failure of the
   *     platform itself.
   *
   * @returns {Promise<{allowed:boolean|null, code?:string, reason?:string, inputs?:Array}>}
   */
  async function authorize({ projectId, inputs, consentId }) {
    // The audit store is not optional. Without it no egress decision can be
    // recorded, and an egress that leaves no trace cannot be claimed to have
    // been controlled. The missing store is therefore reported LOUDLY --
    // it is never silently ignored -- and no content is sent.
    if (!auditStore || typeof auditStore.record !== 'function') {
      return {
        allowed: null,
        code: 'AI_AUDIT_UNAVAILABLE',
        reason: 'the egress audit store is required: an egress decision that cannot be recorded is not a decision',
        auditRecorded: false,
        inputs: [],
      };
    }
    // A missing input list is a DENIAL, not a crash: the caller gave nothing
    // to send, and the gate has nothing to consent to.
    const requested = Array.isArray(inputs) ? inputs : [];
    let project;
    try {
      project = getProject(projectId);
    } catch {
      const code = 'EGRESS_GATE_PROJECT_UNKNOWN';
      await audit({ event: 'egress.denied', outcome: 'denied', code, reason: 'the project is not registered', consentId: consentId ?? null, projectId: null, kinds: [], items: [] });
      return { allowed: false, code, reason: 'the project is not registered' };
    }
    const consent = typeof consentId === 'string' ? await consentStore.find(consentId) : null;
    const verdict = authorizeEgress({
      project,
      inputs: requested,
      consent,
      consentStore,
      runResolver,
    });
    if (!verdict.allowed) {
      const recorded = await audit({
        event: 'egress.denied',
        outcome: 'denied',
        code: verdict.code,
        reason: verdict.reason,
        consentId: consent?.id ?? null,
        projectId: project.id,
        kinds: [...new Set(requested.map((i) => i?.kind).filter((k) => typeof k === 'string'))],
        items: [],
      });
      return {
        allowed: false,
        code: verdict.code,
        reason: verdict.reason,
        auditRecorded: recorded,
        ...(recorded ? {} : { auditCode: 'AI_AUDIT_UNAVAILABLE' }),
      };
    }
    const recorded = await audit({
      event: 'egress.granted',
      outcome: 'allowed',
      consentId: consent?.id ?? null,
      projectId: project.id,
      kinds: verdict.scope.kinds,
      items: verdict.scope.items,
      scopeDigest: verdict.scope.scopeDigest,
    });
    return {
      allowed: true,
      scope: verdict.scope,
      inputs: verdict.inputs,
      // Whether the decision could be RECORDED. A missing audit store is
      // reported here rather than swallowed: `complete()` refuses to send a
      // request for a decision that could not be recorded.
      auditRecorded: recorded,
      ...(recorded ? {} : { auditCode: 'AI_AUDIT_UNAVAILABLE' }),
    };
  }

  /**
   * 写一条外传审计。
   *
   * 审计存储**不存在**时**不静默吞掉**：那会让「都留痕」变成谎话。缺失被
   * 报成一个**可见的失败**——`audit()` 返回 `false`，`authorize()` 把它写进
   * 判定结果（`auditRecorded: false`），`complete()` 则据此**不外发**。
   *
   * 理由：一条没有落盘的审计记录等于没有记录；而「授权放行但没有留痕」的
   * 那一次外发，事后是无法被证明或被追责的。因此**没有审计存储就不外发**。
   *
   * 审计存储**存在但写失败**时，异常照常向上抛（不吞）。
   *
   * @returns {Promise<boolean>} 审计是否真的写下了
   */
  async function audit(record) {
    if (!auditStore || typeof auditStore.record !== 'function') return false;
    await auditStore.record(record);
    return true;
  }

  /**
   * 解析一个提供商的密钥。
   *
   * 返回的密钥**只**用于这一次请求的认证头。它不会被返回给调用方，也不
   * 会被写进任何地方。
   */
  async function resolveKey(credentialId) {
    return credentialStore.resolve(credentialId, 'ai-provider');
  }

  /**
   * 构造回退链。
   *
   * 每个条目是 `{ id, protocol, config }`。密钥**不在**这里——它由每个
   * provider 在发请求的那一刻自己去凭据库取。
   */
  function chainOf(entries) {
    const providers = entries.map((entry) => createAiProvider({
      id: entry.id,
      protocol: entry.protocol,
      config: entry.config,
      resolveKey,
      transport,
    }));
    return createFallbackChain({ providers });
  }

  /**
   * 跑一次模型调用（带外传闸门与回退链）。
   *
   * @param {object} options
   * @param {string} options.projectId
   * @param {Array}  options.inputs      [{ kind, ref }]
   * @param {string} [options.consentId] 外传授权记录 id
   * @param {Array}  options.providers   回退链上的提供商配置
   * @param {object} options.request      统一请求（ATS-401 的 provider 请求形状）
   * @param {number} [options.deadlineAt]
   * @returns {Promise<{text:string, provider:string, attempts:Array}>}
   */
  async function complete({ projectId, inputs, consentId, providers, request, deadlineAt }) {
    if (!Array.isArray(providers) || !providers.length) {
      throw aiError('AI_PROVIDER_CONFIG_INVALID', 'the fallback chain needs at least one provider');
    }
    // --- 1. the gate comes FIRST: no consent, no request, no file read ------
    const verdict = await authorize({ projectId, inputs, consentId });
    // `allowed === null` means NO DECISION was made (the platform cannot
    // record egress decisions). That is a platform failure, not a refusal of
    // the content, and it is reported with its own code.
    if (verdict.allowed === null) {
      throw aiError('AI_AUDIT_UNAVAILABLE', verdict.reason || 'the egress could not be recorded', {
        cause: verdict.code,
      });
    }
    if (!verdict.allowed) {
      throw aiError('AI_EGRESS_DENIED', verdict.reason || 'the egress was refused', {
        cause: verdict.code,
      });
    }
    // An egress decision that could not be RECORDED is not a decision this
    // platform is willing to act on: the trail would not show that the
    // content left the machine. The request is refused, and the refusal says
    // why.
    if (verdict.auditRecorded === false) {
      throw aiError('AI_AUDIT_UNAVAILABLE',
        'the egress decision could not be recorded, so no content is sent',
        { cause: verdict.auditCode ?? 'AI_AUDIT_UNAVAILABLE' });
    }
    // --- 2. the payload is the CONSENTED payload, not the caller's ---------
    // `verdict.inputs` are the inputs the PLATFORM read from disk and whose
    // digests it recomputed and matched against the consent. The caller's
    // `request.inputs[].content` is NOT used: it is attacker-controlled and
    // would let a caller send arbitrary text (or another file) under a
    // consent that covers something else. The consent therefore binds what
    // actually leaves the machine, and the audit trail describes exactly
    // that.
    const boundRequest = bindRequestToConsent(request, verdict.inputs);
    // --- 3. the chain ------------------------------------------------------
    const chain = chainOf(providers);
    const ctx = { deadlineAt };
    const result = await chain.run(boundRequest, ctx);
    return result;
  }

  /**
   * 多步执行：把一次契约调用跑完，步数用尽即失败。
   *
   * `maxSteps` 是 ATS-401 契约里已声明但未施加的上限。每一「步」是一次
   * 模型调用；步骤之间**不**共享任何文件状态——所以步数用尽时工作区照样
   * 干净。
   *
   * 每一步都走 `complete()`，因此它同样受外传闸门约束：`projectId`、
   * `inputs` 与 `consentId` **必须**透传下去，否则闸门会拒绝这次外传，
   * 而那一次拒绝会被当成「步数用尽」——错误码就会指向一个与真实原因
   * 无关的方向。
   *
   * **不可回退的错误保留自己的错误码**。只有「这一步失败了但换一个提供商
   * 可能成功」的错误才消耗步数预算继续走；鉴权失败、配置非法、请求非法
   * 这类错误立刻原样抛出，调用方看到的是它真正遇到的那个问题。
   */
  async function executeSteps({ projectId, inputs, consentId, request, providers, maxSteps, deadlineAt }) {
    const steps = maxSteps === undefined ? 1 : maxSteps;
    if (!Number.isInteger(steps) || steps <= 0) {
      throw aiError('AI_PROVIDER_REQUEST_INVALID', 'maxSteps must be a positive integer');
    }
    const attempts = [];
    let last = null;
    for (let step = 1; step <= steps; step += 1) {
      try {
        const result = await complete({
          projectId,
          inputs,
          consentId,
          providers,
          request,
          deadlineAt,
        });
        attempts.push({ step, ok: true, provider: result.provider });
        return { ...result, steps: step, attempts };
      } catch (error) {
        attempts.push({
          step,
          ok: false,
          // The ROOT cause, not the wrapper: a chain that exhausted itself
          // because every provider was rate limited must not be recorded as
          // "the chain was exhausted" alone.
          code: rootCauseCode(error),
        });
        last = error;
        // A failure that cannot be recovered by trying another provider is
        // reported AS ITSELF -- relabelling it as "the step budget ran out"
        // would hide the real cause from the caller.
        const recoverable = isRetryableAiError(error) || error?.code === 'AI_FALLBACK_EXHAUSTED';
        if (!recoverable) throw error;
        if (step === steps) break;
      }
    }
    const error = aiError('AI_STEPS_EXCEEDED', 'the step budget was exhausted', {
      steps,
      attempts,
      cause: rootCauseCode(last),
    });
    error.cause = last;
    throw error;
  }

  return Object.freeze({
    authorize,
    complete,
    executeSteps,
    /**
     * 把一个提供商包装成 ATS-401 契约层认识的形状。
     *
     * 契约层不认识 `AI_*` 错误码，所以这里把 ATS-403 的码放进
     * `details.cause`——调用方既能按契约层的 `AGENT_PROVIDER_ERROR` 分支，
     * 也能读到真正的失败原因。
     */
    asContractProvider,
  });
}
