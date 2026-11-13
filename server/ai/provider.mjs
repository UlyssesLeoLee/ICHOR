/**
 * ATS-403 ｜ 模型提供商（Model provider）
 *
 * ATS-401 的契约层定义了 `createModelProvider({ id, complete })` 的**形状**，
 * 并明确「模型提供商实现与错误回退」属 ATS-403。本模块是那个形状的**实现**：
 *
 *   complete(request, ctx) -> Promise<{ text }>
 *
 * 三个要点：
 *
 *   1. **密钥不进 provider**。provider 只拿到一个 `resolveKey` 回调，由它
 *      在**真正要发请求的那一刻**去 ATS-402 的凭据库取密钥。密钥因此不
 *      出现在 provider 的配置、状态、日志或错误消息里。
 *   2. **超时由 provider 施加**，不是由传输层「顺便」施加：provider 按
 *      `ctx.deadlineAt` 算出自己这次调用的时间预算。
 *      回退链（`fallback.mjs`）把**剩余时间**分给链上还没试的提供商，因此
 *      一个挂起的提供商不会吃掉整个预算、让下一个提供商从已过期的截止时间
 *      开始。
 *   3. **provider 不碰文件系统**。它不写缓存、不写日志文件、不落任何
 *      中间产物——超时或限流时工作区**一个字节都不会变**。
 */
import { aiError } from './errors.mjs';
import { validateProtocolConfig } from './protocols.mjs';
import { createTransport } from './transport.mjs';

/**
 * 创建一个模型提供商。
 *
 * @param {object} options
 * @param {string} options.id            提供商的标识（进错误消息与提案）
 * @param {string} options.protocol      协议标识（`openai-chat` / `anthropic-messages`）
 * @param {object} options.config        协议配置（模型、端点、maxTokens…）
 * @param {Function}[options.resolveKey] 解析密钥的回调：(credentialId) => Promise<string>
 * @param {object}[options.transport]    传输器（测试注入）
 * @param {number}[options.timeoutMs]    单次调用的超时上限
 */
export function createAiProvider({
  id,
  protocol,
  config = {},
  resolveKey,
  transport,
  timeoutMs,
} = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'the provider id must be a non-empty string');
  }
  const resolved = validateProtocolConfig(protocol, config);
  const sender = transport || createTransport(timeoutMs === undefined ? {} : { timeoutMs });

  /**
   * 解析密钥。
   *
   * 没有 `credentialId` 就**不**带认证头（有的服务用其它方式鉴权，或者
   * 注入测试用的假 fetch）；有 `credentialId` 但没有 `resolveKey` 回调就是
   * 配置错误——**绝不**退回「明文写在配置里」。
   */
  async function key() {
    if (!resolved.credentialId) return null;
    if (typeof resolveKey !== 'function') {
      throw aiError('AI_PROVIDER_CONFIG_INVALID',
        'the provider has a credential reference but no key resolver');
    }
    let secret;
    try {
      secret = await resolveKey(resolved.credentialId);
    } catch (error) {
      // The credential store refused (unavailable / not found). That is NOT a
      // provider failure: switching to another provider would fail the same
      // way, so the error must not be treated as retryable.
      throw aiError('AI_CREDENTIAL_UNAVAILABLE',
        error && error.code ? error.code : 'the credential could not be resolved');
    }
    if (typeof secret !== 'string' || !secret.length) {
      throw aiError('AI_CREDENTIAL_UNAVAILABLE', 'the credential store returned no secret');
    }
    return secret;
  }

  return Object.freeze({
    id,
    protocol: resolved.protocol,
    config: resolved,
    /** 供诊断用：只有配置，**没有**密钥。 */
    describe() {
      return {
        id,
        protocol: resolved.protocol,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        maxTokens: resolved.maxTokens,
        temperature: resolved.temperature,
        credentialId: resolved.credentialId,
        hasKeyResolver: typeof resolveKey === 'function',
      };
    },
    /**
     * 一次模型调用。
     *
     * `ctx.deadlineAt` 是绝对截止时间戳。provider 用它算出本次调用的时间
     * 预算：剩余时间不足时**不再发请求**，直接报超时——这样回退链里的下一个
     * 提供商不会从一个已经过期的截止时间开始。
     */
    async complete(request, ctx = {}) {
      const apiKey = await key();
      const deadlineAt = typeof ctx.deadlineAt === 'number' ? ctx.deadlineAt : undefined;
      const result = await sender.send({
        config: resolved,
        request,
        apiKey,
        deadlineAt,
      });
      return { text: result.text };
    },
  });
}

/**
 * 把一个 provider 包成 ATS-401 契约层认识的 `ModelProvider` 形状。
 *
 * 契约层的 `createModelProvider()` 要求 `{ id, complete }`；本函数做的只是
 * 把 ATS-403 的 provider 接上去，并在**适配器层**已经报错时保留原错误码
 * （`AGENT_PROVIDER_ERROR` 是契约层的码，ATS-403 的码要能穿透它，所以
 * 这里把 `err.code` 放进 `details`）。
 */
export function asContractProvider(provider) {
  if (!provider || typeof provider.complete !== 'function') {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'the provider has no complete() function');
  }
  return {
    id: provider.id,
    async complete(request, ctx) {
      try {
        return await provider.complete(request, ctx);
      } catch (error) {
        const wrapped = new Error(error && error.message ? error.message : 'the provider failed');
        wrapped.code = 'AGENT_PROVIDER_ERROR';
        wrapped.details = {
          provider: provider.id,
          cause: error && error.code ? error.code : undefined,
        };
        throw wrapped;
      }
    },
  };
}
