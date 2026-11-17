/**
 * ATS-403 ｜ 模型 API 适配层（Model API adapter layer）
 *
 * 这一层把「一次模型调用」拆成五层，每层各管一件事，因此每层都能被单独
 * 测、被单独替换：
 *
 *   protocols.mjs  协议翻译   统一请求 → 协议请求体；协议响应 → 统一文本
 *   transport.mjs  传输       发请求、强制超时、把 HTTP 状态码归成 AI 错误码
 *   provider.mjs   提供商     一个可配置的模型端点（协议 + 端点 + 凭据引用）
 *   fallback.mjs   回退链     按顺序试提供商，只在可回退的错误上继续
 *   service.mjs    服务       外传闸门 → 凭据解析 → 回退链
 *
 * 分层的意义在于**「不污染工作区」是可以被证明的**：只有 `service.mjs` 会
 * 触碰状态，而它做的事只有「判定」与「留痕」；`transport.mjs` 是唯一的
 * 网络出口；协议层与提供商层都是纯内存的。
 */
export {
  AI_ERROR_CODES,
  RETRYABLE_AI_ERROR_CODES,
  AI_STATUS_FOR_CODE,
  aiError,
  isRetryableAiError,
  classifyProviderStatus,
} from './errors.mjs';

import { AI_ERROR_CODES, AI_STATUS_FOR_CODE, RETRYABLE_AI_ERROR_CODES } from './errors.mjs';
import { AI_PROTOCOLS } from './protocols.mjs';

export {
  AI_PROTOCOLS,
  normalizeModelRequest,
  renderInputs,
  validateProtocolConfig,
  sanitizeHeaders,
  defaultBaseUrl,
  defaultPath,
  buildProtocolBody,
  buildProtocolHeaders,
  extractProtocolText,
  extractStopReason,
  isTruncatedStopReason,
} from './protocols.mjs';

export {
  DEFAULT_TRANSPORT_TIMEOUT_MS,
  MAX_RESPONSE_CHARS,
  createTransport,
} from './transport.mjs';

export { createAiProvider, asContractProvider } from './provider.mjs';
export { createFallbackChain, explainAiError } from './fallback.mjs';
export { createModelService, bindRequestToConsent, describeInstructions } from './service.mjs';

/** 本层的契约版本。 */
export const AI_ADAPTER_CONTRACT_VERSION = 'ai-adapter/v1';

/**
 * 供诊断与 API 使用的契约描述。
 *
 * 它**不含**任何密钥、不含任何端点凭据、不含任何本机路径。
 */
export function describeAiAdapter() {
  return {
    contract: AI_ADAPTER_CONTRACT_VERSION,
    protocols: [...AI_PROTOCOLS],
    errorCodes: [...AI_ERROR_CODES],
    retryableErrorCodes: [...RETRYABLE_AI_ERROR_CODES],
    // The status table is PUBLISHED, so the documentation cannot drift from
    // the code that uses it: there is one table and it is exposed.
    statusByCode: { ...AI_STATUS_FOR_CODE },
    fallbackPolicy: 'A provider is tried at most once. Only a retryable error moves the chain to the next provider; an auth, configuration or request error fails immediately.',
    secretPolicy: 'A provider configuration may only carry a credential REFERENCE. The secret is read from the credential store at the moment the request is sent and never enters the configuration, the URL, the request body or a log. A provider that ECHOES the key back in its error body has it redacted before the message leaves the adapter.',
    egressPolicy: 'The egress gate runs BEFORE the request: without a granted consent whose scope still matches the content, no file is read, no secret is resolved and no request is sent. The INPUT CONTENT that is sent is the content the gate read and verified against the consent, not the content supplied by the caller. The caller\'s INSTRUCTIONS are a separate channel: they are sent to the provider as they are, and the egress audit records their SHA-256 digest and byte length -- never the text itself.',
    workspacePolicy: 'The adapter layer writes no file: a timeout or a rate limit leaves the working tree byte-identical.',
    stepPolicy: 'executeSteps() is a LIBRARY function of the adapter layer, not a Bridge route: the step bound applies only to a caller that invokes executeSteps() itself, and no /api/ai route calls it. When it is invoked, the step budget running out is reported as AI_STEPS_EXCEEDED, and a failure that cannot be recovered by trying another provider keeps its own error code instead of being relabelled as AI_STEPS_EXCEEDED.',
    deadlinePolicy: 'When a deadline is set, the time that is left is divided among the providers still to try, so one hanging provider cannot consume the whole budget.',
    providerSource: 'A call uses the CONFIGURED providers only. A request body cannot supply a provider list or an endpoint.',
  };
}
