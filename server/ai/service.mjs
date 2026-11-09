/**
 * ATS-403 ｜ 模型调用服务（Service）
 *
 * ATS-401 的契约层管「请求与提案的形状」，ATS-402 管「密钥与外传授权」，
 * 本模块把三者**接起来**：一次真实的模型调用要走完
 *
 *   外传闸门（ATS-402）→ 密钥解析（ATS-402）→ 回退链（ATS-403）→ 契约收敛（ATS-401）
 *
 * 三条硬规则，每一条都在本模块里有对应代码与可机读的断言：
 *
 *   1. **没有授权就不发请求。** 外传闸门先判（`authorizeEgress`），判不过
 *      就**不读文件、不取密钥、不发请求**，并把这次拒绝写进外传审计。
 *   2. **密钥只来自凭据库。** `credentialStore.resolve(id, 'ai-provider')`
 *      是唯一入口；配置里不允许有明文密钥（见 `protocols.mjs`）。
 *   3. **失败不污染工作区。** 本模块**不写任何文件**：没有缓存、没有临时
 *      文件、没有「失败也留一份」的痕迹。超时或限流时，工作区一个字节都
 *      不变——这一点由 `tools/ats403-probes/probe-ai-boundary.mjs` 用
 *      「调用前后目录摘要逐字节相同」实测。
 *
 * **多步执行**（`maxSteps`）：ATS-401 只校验 `maxSteps` 的上限，没有施加它；
 * 本模块把它落成「最多几步」的硬约束，步数用尽即 `AI_STEPS_EXCEEDED`。
 */
import { aiError, isRetryableAiError } from './errors.mjs';
import { asContractProvider, createAiProvider } from './provider.mjs';
import { createFallbackChain } from './fallback.mjs';
import { authorizeEgress } from '../security/egress-gate.mjs';

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
   * @returns {Promise<{allowed:boolean, code?:string, reason?:string, inputs?:Array}>}
   */
  async function authorize({ projectId, inputs, consentId }) {
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
      inputs,
      consent,
      consentStore,
      runResolver,
    });
    if (!verdict.allowed) {
      await audit({
        event: 'egress.denied',
        outcome: 'denied',
        code: verdict.code,
        reason: verdict.reason,
        consentId: consent?.id ?? null,
        projectId: project.id,
        kinds: [...new Set(inputs.map((i) => i?.kind).filter((k) => typeof k === 'string'))],
        items: [],
      });
      return { allowed: false, code: verdict.code, reason: verdict.reason };
    }
    await audit({
      event: 'egress.granted',
      outcome: 'allowed',
      consentId: consent?.id ?? null,
      projectId: project.id,
      kinds: verdict.scope.kinds,
      items: verdict.scope.items,
      scopeDigest: verdict.scope.scopeDigest,
    });
    return { allowed: true, scope: verdict.scope, inputs: verdict.inputs };
  }

  /** 写一条外传审计（审计存储不存在时不静默吞掉——那会让「都留痕」变成谎话）。 */
  async function audit(record) {
    if (!auditStore || typeof auditStore.record !== 'function') return;
    await auditStore.record(record);
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
    if (!verdict.allowed) {
      throw aiError('AI_EGRESS_DENIED', verdict.reason || 'the egress was refused', {
        cause: verdict.code,
      });
    }
    // --- 2. the chain ------------------------------------------------------
    const chain = chainOf(providers);
    const ctx = { deadlineAt };
    try {
      const result = await chain.run(request, ctx);
      return result;
    } catch (error) {
      if (error && error.code === 'AI_FALLBACK_EXHAUSTED') throw error;
      // A single provider's failure that is not retryable keeps its own code
      // (the chain already attached the attempts).
      throw error;
    }
  }

  /**
   * 多步执行：把一次契约调用跑完，步数用尽即失败。
   *
   * `maxSteps` 是 ATS-401 契约里已声明但未施加的上限。每一「步」是一次
   * 模型调用；步骤之间**不**共享任何文件状态——所以步数用尽时工作区照样
   * 干净。
   */
  async function executeSteps({ request, providers, maxSteps, deadlineAt }) {
    const steps = maxSteps === undefined ? 1 : maxSteps;
    if (!Number.isInteger(steps) || steps <= 0) {
      throw aiError('AI_PROVIDER_REQUEST_INVALID', 'maxSteps must be a positive integer');
    }
    const attempts = [];
    let last = null;
    for (let step = 1; step <= steps; step += 1) {
      try {
        const result = await complete({ providers, request, deadlineAt });
        attempts.push({ step, ok: true, provider: result.provider });
        return { ...result, steps: step, attempts };
      } catch (error) {
        attempts.push({ step, ok: false, code: error?.code ?? 'AI_PROVIDER_UNAVAILABLE' });
        last = error;
        if (!isRetryableAiError(error) && error?.code !== 'AI_FALLBACK_EXHAUSTED') break;
        if (step === steps) break;
      }
    }
    const error = aiError('AI_STEPS_EXCEEDED', 'the step budget was exhausted', {
      steps,
      attempts,
      cause: last?.code,
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
