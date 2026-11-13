/**
 * ATS-403 ｜ 模型 API 适配层的错误码
 *
 * 错误码是**稳定契约**的一部分：调用方按 `err.code` 分支，不解析消息文本。
 * ATS-401 的契约层已经确立了 `AGENT_*` 错误码；本模块是它下游的**提供商层**
 * 的错误码，两者互不重叠：`AGENT_*` 说「请求不满足契约」，`AI_*` 说「契约
 * 满足，但调用模型这一段出了问题」。
 *
 * 分成两类的原因很实际：**能不能回退**取决于错误的种类**：
 *
 *   - 可回退（`AI_PROVIDER_TIMEOUT` / `AI_PROVIDER_RATE_LIMITED` /
 *     `AI_PROVIDER_UNAVAILABLE` / `AI_PROVIDER_SERVER_ERROR`）：换一个提供商
 *     仍然可能成功，因此回退链会继续往下走；
 *   - 不可回退（`AI_PROVIDER_AUTH_FAILED` / `AI_PROVIDER_CONFIG_INVALID` /
 *     `AI_PROVIDER_REQUEST_INVALID`）：换提供商也一样会失败（密钥错了、配置
 *     错了、请求本身不合法），立刻失败比白白重试一遍更诚实。
 *
 * 换句话说：**错误码不只是给人看的，它决定回退链的行为。**
 */
export const AI_ERROR_CODES = Object.freeze([
  'AI_PROVIDER_UNKNOWN',
  'AI_PROVIDER_CONFIG_INVALID',
  'AI_PROVIDER_REQUEST_INVALID',
  'AI_PROVIDER_AUTH_FAILED',
  'AI_PROVIDER_RATE_LIMITED',
  'AI_PROVIDER_TIMEOUT',
  'AI_PROVIDER_UNAVAILABLE',
  'AI_PROVIDER_SERVER_ERROR',
  'AI_PROVIDER_OUTPUT_INVALID',
  'AI_PROVIDER_RESPONSE_INVALID',
  'AI_FALLBACK_EXHAUSTED',
  'AI_STEPS_EXCEEDED',
  'AI_EGRESS_DENIED',
  'AI_CREDENTIAL_UNAVAILABLE',
  'AI_AUDIT_UNAVAILABLE',
  'AI_CHILD_FAILED',
]);

/**
 * 可以回退到下一个提供商的错误码。
 *
 * `AI_PROVIDER_OUTPUT_INVALID` 在其中：提供商**答了**，但答出来的东西用不了
 * （内容被截断、或没有可取的文本）。这通常是**该提供商**的输出上限造成的
 * （不同提供商的实际上限不同），因此换一个提供商有可能答得出来——这正是
 * 回退链存在的意义。
 *
 * `AI_PROVIDER_RESPONSE_INVALID`（根本不是 JSON，即该端点不说这个协议）
 * **不在**其中：不说话的端点换个提供商也不会开始说话。
 */
export const RETRYABLE_AI_ERROR_CODES = Object.freeze([
  'AI_PROVIDER_TIMEOUT',
  'AI_PROVIDER_RATE_LIMITED',
  'AI_PROVIDER_UNAVAILABLE',
  'AI_PROVIDER_SERVER_ERROR',
  'AI_PROVIDER_OUTPUT_INVALID',
]);

/**
 * 造一个带 `.code` 的 AI 错误。
 *
 * 消息里**只有错误码**（和可选的原因说明），不带密钥、不带本机绝对路径：
 * 错误消息会被写进日志与 API 响应。
 */
export function aiError(code, reason, details) {
  if (!AI_ERROR_CODES.includes(code)) {
    throw new Error(`unknown AI error code ${code}`);
  }
  const error = new Error(reason ? `${code}: ${reason}` : code);
  error.code = code;
  if (details !== undefined && details !== null) error.details = details;
  return error;
}

/** 这个错误是否应该回退到下一个提供商。 */
export function isRetryableAiError(error) {
  return Boolean(error) && RETRYABLE_AI_ERROR_CODES.includes(error.code);
}

/**
 * 从一段文本里抹掉一个密钥。
 *
 * 提供商的错误正文会**回显**它收到的密钥——兼容网关这么做很常见（OpenAI
 * 的 `Incorrect API key provided: sk-...` 就是如此）。错误正文会经由
 * `message` → `details.attempts[].reason` 一路回到客户端，因此**必须**在
 * 传输层就把本次解析出的密钥抹掉，否则「密钥不进错误消息」这条声明不成立。
 *
 * 抹除是**按本次请求实际解析出的那把密钥**做的，不是按形状猜的：形状猜测
 * 会漏掉没有固定前缀的密钥，也会误伤正常的错误文本。
 *
 * @param {string} text  待处理的文本
 * @param {string|null} secret  本次解析出的密钥（可为空）
 * @returns {string} 处理后的文本
 */
export function redactSecret(text, secret) {
  if (typeof text !== 'string' || !text.length) return '';
  if (typeof secret !== 'string' || !secret.length) return text;
  // The secret is replaced wherever it appears. The placeholder is fixed so
  // a redacted message never carries the length of the original secret.
  return text.split(secret).join('[redacted]');
}

/**
 * 把 HTTP 状态码规整成 AI 错误码。
 *
 * 429 单独成码是因为它是最典型的「稍后重试」信号：回退链必须能认出它，
 * 而不是把它笼统地当成 5xx。
 */
export function classifyProviderStatus(status) {
  if (status === 401 || status === 403) return 'AI_PROVIDER_AUTH_FAILED';
  if (status === 429) return 'AI_PROVIDER_RATE_LIMITED';
  if (status === 400 || status === 422) return 'AI_PROVIDER_REQUEST_INVALID';
  if (status === 408 || status === 504) return 'AI_PROVIDER_TIMEOUT';
  if (status === 503) return 'AI_PROVIDER_UNAVAILABLE';
  if (status >= 500) return 'AI_PROVIDER_SERVER_ERROR';
  return 'AI_PROVIDER_RESPONSE_INVALID';
}

/** 提供方的响应不可用时（正文不是 JSON 等）用的码。 */
export const AI_STATUS_FOR_CODE = Object.freeze({
  AI_PROVIDER_CONFIG_INVALID: 400,
  AI_PROVIDER_REQUEST_INVALID: 400,
  AI_PROVIDER_UNKNOWN: 400,
  AI_STEPS_EXCEEDED: 429,
  AI_EGRESS_DENIED: 403,
  AI_CREDENTIAL_UNAVAILABLE: 503,
  AI_AUDIT_UNAVAILABLE: 503,
  AI_PROVIDER_UNAVAILABLE: 503,
  AI_PROVIDER_RATE_LIMITED: 429,
  AI_PROVIDER_TIMEOUT: 504,
  AI_FALLBACK_EXHAUSTED: 502,
  AI_PROVIDER_AUTH_FAILED: 502,
  AI_PROVIDER_SERVER_ERROR: 502,
  AI_PROVIDER_OUTPUT_INVALID: 502,
  AI_PROVIDER_RESPONSE_INVALID: 502,
  AI_CHILD_FAILED: 502,
});
