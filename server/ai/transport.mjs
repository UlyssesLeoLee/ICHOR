/**
 * ATS-403 ｜ 传输层（Transport）
 *
 * 传输层做**一件事**：把一次模型调用发出去，并把结果收敛成一个统一的形状。
 * 它是**唯一**做网络 I/O 的地方，因此：
 *
 *   - 协议层（`protocols.mjs`）可以被纯函数测试，不需要网络；
 *   - 传输层的依赖可以整体替换——测试注入一个假 fetch，不碰真实网络；
 *   - **超时是强制施加的**：请求带自己的 AbortController，超时即中止，
 *     而不是等 fetch 自己超时。
 *
 * 传输层**不重试**。重试与回退是 `server/ai/fallback.mjs` 的事——回退是
 * 「换提供商」，重试是「换协议下的同一次调用」，两者放在不同层，回退链的
 * 语义才不会被重试次数污染。
 *
 * **不污染工作区**：传输层不写任何文件。它的输入是内存里的请求体，输出是
 * 内存里的响应文本；超时或限流时它**什么都不产出**——不会有半截文件、不会
 * 有临时文件、不会有「下次继续」的残状态。
 */
import { aiError, classifyProviderStatus, redactSecret } from './errors.mjs';
import {
  buildProtocolBody, buildProtocolHeaders, defaultPath,
  extractProtocolText, extractStopReason, isTruncatedStopReason,
} from './protocols.mjs';

/** 一次传输的默认超时（毫秒）。 */
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 60_000;

/** 响应正文的大小上限（字符）。超出即拒绝，避免一个失控的响应吃掉内存。 */
export const MAX_RESPONSE_CHARS = 4_000_000;

/**
 * 创建一个传输器。
 *
 * @param {object} options
 * @param {Function} [options.fetch]   fetch 实现（测试注入）
 * @param {number}  [options.timeoutMs] 单次请求的超时
 * @param {Function}[options.now]      当前时间（毫秒），测试注入
 */
export function createTransport({ fetch: fetchImpl, timeoutMs = DEFAULT_TRANSPORT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'no fetch implementation is available');
  }

  /**
   * 发一次请求。
   *
   * @param {object} options
   * @param {object} options.config    协议配置（validateProtocolConfig 的产物）
   * @param {object} options.request   统一请求
   * @param {string} [options.apiKey]  从凭据库解析出的密钥（可选）
   * @param {number} [options.deadlineAt] 绝对截止时间戳（epoch ms）
   * @returns {Promise<{text:string, stopReason:string|null, status:number, elapsedMs:number}>}
   */
  async function send({ config, request, apiKey, deadlineAt }) {
    const body = buildProtocolBody(config.protocol, request, config);
    const headers = buildProtocolHeaders(config.protocol, config, apiKey);
    const url = `${config.baseUrl}${defaultPath(config.protocol)}`;

    const limit = deadlineAt === undefined || deadlineAt === null
      ? timeoutMs
      : Math.min(timeoutMs, Math.max(0, deadlineAt - now()));
    if (limit <= 0) {
      // The deadline has already passed. This is a timeout, and it is
      // reported as one -- not as a provider error.
      throw aiError('AI_PROVIDER_TIMEOUT', 'the deadline had already passed');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);
    const startedAt = now();
    try {
      let response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) {
          throw aiError('AI_PROVIDER_TIMEOUT', 'the request exceeded its time budget');
        }
        // A network-level failure is "the provider is not reachable" -- the
        // kind of error a fallback chain may survive.
        throw aiError('AI_PROVIDER_UNAVAILABLE',
          error && error.message ? error.message : 'the provider could not be reached');
      }
      const status = typeof response?.status === 'number' ? response.status : 0;
      let text = '';
      try {
        text = typeof response.text === 'function' ? await response.text() : '';
      } catch {
        text = '';
      }
      if (timedOut) {
        throw aiError('AI_PROVIDER_TIMEOUT', 'the request exceeded its time budget');
      }
      if (status < 200 || status >= 300) {
        const code = classifyProviderStatus(status);
        // The provider's own body may name the reason; it is truncated so a
        // huge error page cannot flood the logs.
        //
        // The body is REDACTED against the key this request actually used:
        // a provider that echoes the key back (many compatible gateways do)
        // would otherwise put the secret into `message`, and from there into
        // `details.attempts[].reason` and straight to the client.
        //
        // The ORDER matters and is not interchangeable: the redaction runs on
        // the WHOLE body first, and only the redacted text is truncated. Doing
        // it the other way round (truncate, then redact) leaves a PREFIX of
        // the key in the message whenever the key straddles the cut -- the
        // full secret is gone, but `split(secret)` no longer matches, so the
        // leftover prefix survives into `message` and `details`.
        const reason = redactSecret(
          String(text || '').replace(/\s+/g, ' ').trim(),
          apiKey,
        ).slice(0, 500);
        throw aiError(code, reason || `the provider answered with status ${status}`, { status });
      }
      if (text.length > MAX_RESPONSE_CHARS) {
        throw aiError('AI_PROVIDER_RESPONSE_INVALID', 'the response is too large');
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw aiError('AI_PROVIDER_RESPONSE_INVALID', 'the response is not valid JSON');
      }
      const content = extractProtocolText(config.protocol, payload);
      const stopReason = extractStopReason(config.protocol, payload);
      if (isTruncatedStopReason(stopReason)) {
        // A truncated answer is NOT a short answer: it is an incomplete one,
        // and the contract layer would reject the broken JSON anyway. It is
        // reported as a provider output problem.
        //
        // This error IS retryable: the truncation is usually a property of
        // THIS provider's output cap (the caps differ between providers), so
        // the fallback chain moves on to the next provider, which may answer
        // within its own cap.
        throw aiError('AI_PROVIDER_OUTPUT_INVALID', 'the response was truncated by the provider', {
          stopReason,
        });
      }
      return { text: content, stopReason, status, elapsedMs: now() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ send, timeoutMs });
}
