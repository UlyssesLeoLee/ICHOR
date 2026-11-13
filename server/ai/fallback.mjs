/**
 * ATS-403 ｜ 错误回退链（Fallback chain）
 *
 * 「错误回退」是本任务的交付物之一。回退链的语义必须**窄**而确定：
 *
 *   - 只有**可回退**的错误才走到下一个提供商（超时、限流、不可用、服务端
 *     错误）。密钥错、配置错、请求本身不合法这类错误**立即失败**——换一
 *     个提供商只会把同一个错误再犯一遍，还多烧一次调用预算。
 *   - 每个提供商在链上**最多被试一次**。同一个提供商上的「重试」不在本
 *     模块的语义里（限流重试与换提供商是两件事，见 §1）。
 *   - 链子走完仍失败时，抛 `AI_FALLBACK_EXHAUSTED`，并把**每个**环节的
 *     失败原因按顺序挂在 `details.attempts` 上——调用方能看出「试过谁、
 *     为什么换」。
 *
 * **回退不污染工作区**：本模块不写任何文件。它只在内存里换提供商，因此
 * 一个被限流的提供商不会在工作区留下任何痕迹（没有半截缓存、没有临时
 * 文件、没有「下次继续」的状态）。
 *
 * ## 1. 回退与重试的区别
 *
 * 「重试」= 对**同一个**提供商再发一次（限流后等一下再试）；「回退」=
 * **换**一个提供商。本模块只做后者。前者由调用方在链外决定（平台侧的
 * 限流退避策略不在本任务范围），本模块的 `attempts` 数组因此每个提供商
 * 只出现一次。
 */
import { aiError, isRetryableAiError } from './errors.mjs';

/**
 * 创建一个回退链。
 *
 * @param {object} options
 * @param {Array}  options.providers  提供商数组，按顺序尝试
 * @param {Function}[options.onAttempt] 每一次尝试的回调：(record) => void
 */
export function createFallbackChain({ providers = [], onAttempt } = {}) {
  if (!Array.isArray(providers)) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'providers must be an array');
  }
  for (const provider of providers) {
    if (!provider || typeof provider.complete !== 'function') {
      throw aiError('AI_PROVIDER_CONFIG_INVALID', 'every provider needs a complete() function');
    }
  }

  /**
   * 依次尝试每个提供商。
   *
   * @param {object} request 统一请求
   * @param {object} ctx     { deadlineAt, signal }
   * @returns {Promise<{provider:string, text:string, attempts:Array}>}
   */
  async function run(request, ctx = {}) {
    const attempts = [];
    if (!providers.length) {
      throw aiError('AI_FALLBACK_EXHAUSTED', 'the fallback chain is empty', { attempts });
    }
    // The remaining deadline is DIVIDED among the providers that are still
    // left on the chain: each one gets the remaining time divided by the
    // number of providers still to try. Without this the first provider can
    // consume the whole budget, and every provider after it would start from
    // an already expired deadline -- the request would never be sent even
    // though a healthy provider was next on the chain.
    //
    // The share is computed from the time that is LEFT when the provider is
    // reached, so the sum of the shares can never exceed the deadline.
    const now = typeof ctx.now === 'function' ? ctx.now : () => Date.now();
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      const remainingProviders = providers.length - index;
      const providerCtx = { ...ctx };
      if (typeof ctx.deadlineAt === 'number') {
        const left = ctx.deadlineAt - now();
        const share = Math.floor(left / remainingProviders);
        providerCtx.deadlineAt = now() + share;
        providerCtx.remainingMs = left;
      }
      const startedAt = Date.now();
      try {
        const result = await provider.complete(request, providerCtx);
        const record = {
          provider: provider.id,
          ok: true,
          elapsedMs: Date.now() - startedAt,
        };
        attempts.push(record);
        if (typeof onAttempt === 'function') onAttempt(record);
        return { provider: provider.id, text: result.text, attempts };
      } catch (error) {
        const code = error && error.code ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        const record = {
          provider: provider.id,
          ok: false,
          code,
          // The message may carry the provider's own reason. It never carries
          // a secret (the secret is in a header) and never a local path.
          reason: error && error.message ? String(error.message).slice(0, 300) : '',
          elapsedMs: Date.now() - startedAt,
        };
        attempts.push(record);
        if (typeof onAttempt === 'function') onAttempt(record);
        if (!isRetryableAiError(error)) {
          // Not recoverable by switching providers: report THIS error, not a
          // generic "exhausted" one -- the caller needs the real cause.
          error.details = { ...(error.details || {}), attempts };
          throw error;
        }
      }
    }
    // The chain is exhausted. When EVERY attempt failed with the SAME
    // retryable code, that code is reported instead of the generic
    // "exhausted": a rate limit must reach the client as 429 (retry later)
    // and a timeout as 504, not as an opaque 502. When the attempts
    // disagree, there is no single actionable reason and the generic code
    // is the honest one.
    const codes = [...new Set(attempts.map((a) => a.code).filter(Boolean))];
    if (codes.length === 1 && isRetryableAiError({ code: codes[0] })) {
      throw aiError(codes[0], 'every provider in the chain failed with the same error', { attempts });
    }
    throw aiError('AI_FALLBACK_EXHAUSTED', 'every provider in the chain failed', { attempts });
  }

  return Object.freeze({
    run,
    /** 链上的提供商 id（诊断用）。 */
    ids: () => providers.map((p) => p.id),
    size: providers.length,
  });
}

/**
 * 按错误码给出一个「该怎么办」的说明。
 *
 * 这不是给人看的日志，是给**调用方**看的：调用方据此决定是提示用户
 * 「稍后重试」（限流/超时）还是「去修配置」（密钥/配置错误）。
 */
export function explainAiError(code) {
  switch (code) {
    case 'AI_PROVIDER_TIMEOUT':
      return 'the provider did not answer within the time budget; retry later or use another provider';
    case 'AI_PROVIDER_RATE_LIMITED':
      return 'the provider is rate limiting; retry later or use another provider';
    case 'AI_PROVIDER_UNAVAILABLE':
      return 'the provider could not be reached; check the endpoint or use another provider';
    case 'AI_PROVIDER_SERVER_ERROR':
      return 'the provider failed with a server error; retry later or use another provider';
    case 'AI_PROVIDER_AUTH_FAILED':
      return 'the provider rejected the credentials; the key must be fixed. Another provider may use a DIFFERENT credential and still succeed, so the chain stops here by policy rather than because it must fail again';
    case 'AI_PROVIDER_REQUEST_INVALID':
      return 'the provider rejected the request itself; the request must be fixed';
    case 'AI_PROVIDER_CONFIG_INVALID':
      return 'the provider configuration is invalid';
    case 'AI_CREDENTIAL_UNAVAILABLE':
      return 'the secret could not be read from the credential store';
    case 'AI_EGRESS_DENIED':
      return 'the egress was refused: there is no valid informed consent for this content';
    case 'AI_AUDIT_UNAVAILABLE':
      return 'the platform could not record the egress decision, so no content was sent';
    case 'AI_PROVIDER_OUTPUT_INVALID':
      return 'the provider answered with something the contract cannot accept';
    case 'AI_FALLBACK_EXHAUSTED':
      return 'every provider in the fallback chain failed';
    default:
      return 'the model call failed';
  }
}
