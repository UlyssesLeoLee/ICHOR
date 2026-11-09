/**
 * ATS-403 ｜ 模型协议（Protocol）
 *
 * 「至少两种兼容协议可配置」是本任务的完成定义之一。这里的「协议」指的是
 * **模型 API 的请求/响应形状**，不是传输方式：两种协议都用 HTTPS + JSON，
 * 但请求体字段、认证头、响���里取文本的位置完全不同。
 *
 * 本模块实现两种：
 *
 *   1. `openai-chat`  —— OpenAI 兼容的 `/chat/completions`：
 *      请求 `{ model, messages, max_tokens, temperature }`，认证头
 *      `Authorization: Bearer <key>`，文本在 `choices[0].message.content`。
 *      很多第三方服务也用这个形状，所以叫「兼容协议」。
 *   2. `anthropic-messages` —— Anthropic 的 `/v1/messages`：
 *      请求 `{ model, max_tokens, system, messages }`，认证头
 *      `x-api-key: <key>`，文本在 `content[0].text`，并且**必须**带
 *      `anthropic-version` 头。
 *
 * 设计要点：
 *
 *   - **协议层不含任何 I/O**。它只把「统一的请求」翻译成「某协议的请求体」，
 *     再把「某协议的响应」翻译回「统一的响应」。发请求的事在
 *     `server/ai/transport.mjs`（用 fetch），因此协议可以用纯函数测试。
 *   - **统一形状是 ATS-401 契约层的那一份**：`buildProviderRequest()` 产出的
 *     `{ role, outputKind, instructions, scope, budget, inputs }`。协议层把
 *     `instructions` 变成 system 消息、把 `inputs` 变成 user 消息——**输入内容
 *     与指令分列**，这正是 ATS-401 契约层要求的「模型不能把输入当指令」。
 *   - **密钥不进入请求体的任何字段**，只进认证头。协议层拿到的 key 由调用方
 *     从 ATS-402 的凭据库解析后传入，本模块不碰凭据存储。
 */
import { aiError } from './errors.mjs';

/** 本模块支持的协议标识。 */
export const AI_PROTOCOLS = Object.freeze(['openai-chat', 'anthropic-messages']);

/** 协议标识的形状。 */
const PROTOCOL_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * 统一的模型请求。
 *
 * 这个形状**就是** ATS-401 契约层交给 provider 的那一份（`ctx.deadlineAt`
 * 除外，那是运行时信息），因此适配器可以直接把它交给协议层翻译。
 */
export function normalizeModelRequest(request) {
  if (!request || typeof request !== 'object') {
    throw aiError('AI_PROVIDER_REQUEST_INVALID', 'the model request must be an object');
  }
  const inputs = Array.isArray(request.inputs) ? request.inputs : [];
  return {
    role: typeof request.role === 'string' ? request.role : 'planner',
    outputKind: typeof request.outputKind === 'string' ? request.outputKind : 'test-intent',
    instructions: typeof request.instructions === 'string' ? request.instructions : '',
    scope: request.scope ?? null,
    budget: request.budget ?? null,
    inputs: inputs.map((input) => ({
      kind: input?.kind ?? 'file',
      ref: input?.ref ?? '',
      digest: input?.digest ?? '',
      content: typeof input?.content === 'string' ? input.content : '',
    })),
  };
}

/**
 * 把输入内容渲染成 user 消息的正文。
 *
 * 每一段都带 `ref` 与 `digest`，模型因此能引用输入出处（ATS-401 要求
 * `script-diff` 提案必须引用至少一个出处），平台侧也能核对「模型看到的
 * 就是用户确认过的那份内容」。
 */
export function renderInputs(inputs) {
  return inputs
    .map((input) => {
      const digest = input.digest ? ` sha256=${input.digest}` : '';
      return `--- input ${input.kind} ${input.ref}${digest} ---\n${input.content}`;
    })
    .join('\n\n');
}

/**
 * 校验一个协议配置的形状。
 *
 * 配置里**不允许**出现密钥：密钥只能由 ATS-402 的凭据库按引用解析，配置里
 * 放明文密钥等于把密钥写进配置文件（本仓库里配置文件是要进 Git 的）。
 */
export function validateProtocolConfig(protocol, config = {}) {
  if (!PROTOCOL_NAME.test(String(protocol))) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'the protocol name is invalid');
  }
  if (!AI_PROTOCOLS.includes(protocol)) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', `unsupported protocol ${protocol}`, {
      supported: [...AI_PROTOCOLS],
    });
  }
  const baseUrl = config.baseUrl === undefined ? defaultBaseUrl(protocol) : config.baseUrl;
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'baseUrl must be an http(s) URL');
  }
  if (config.credentialId !== undefined && config.credentialId !== null
    && !/^cred_[0-9a-f]{24}$/.test(String(config.credentialId))) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'credentialId must be a credential reference id');
  }
  // A plaintext key in the configuration would end up in a file that is
  // committed to Git. The credential store (ATS-402) is the only place a
  // secret may live, so the configuration may only carry a REFERENCE.
  if (config.apiKey !== undefined || config.secret !== undefined) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID',
      'the configuration must not carry a secret; use credentialId');
  }
  const model = config.model === undefined ? '' : config.model;
  if (typeof model !== 'string' || model.length > 200) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'model must be a string of at most 200 characters');
  }
  const maxTokens = config.maxTokens === undefined ? 4096 : config.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > 200_000) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'maxTokens must be an integer between 1 and 200000');
  }
  const temperature = config.temperature === undefined ? 0 : config.temperature;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)
    || temperature < 0 || temperature > 2) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'temperature must be a number between 0 and 2');
  }
  return {
    protocol,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    maxTokens,
    temperature,
    credentialId: config.credentialId ?? null,
    headers: sanitizeHeaders(config.headers),
  };
}

/**
 * 额外的请求头。
 *
 * **只允许**一组固定的名字，且**禁止** `authorization` / `x-api-key`：
 * 认证头由协议层从凭据库解析出的密钥构造，配置里再写一份就等于有两个
 * 密钥来源，而「用哪个」这件事必须是确定的。
 */
export function sanitizeHeaders(headers) {
  if (headers === undefined || headers === null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw aiError('AI_PROVIDER_CONFIG_INVALID', 'headers must be an object');
  }
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) {
      throw aiError('AI_PROVIDER_CONFIG_INVALID', `the header name ${name} is invalid`);
    }
    if (/^(authorization|x-api-key|cookie|host|content-length)$/i.test(name)) {
      throw aiError('AI_PROVIDER_CONFIG_INVALID',
        `the header ${name} may not be set by the configuration`);
    }
    if (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value)) {
      throw aiError('AI_PROVIDER_CONFIG_INVALID', `the header ${name} has an invalid value`);
    }
    out[name] = value;
  }
  return out;
}

/** 每个协议的默认端点。 */
export function defaultBaseUrl(protocol) {
  if (protocol === 'openai-chat') return 'https://api.openai.com/v1';
  if (protocol === 'anthropic-messages') return 'https://api.anthropic.com/v1';
  throw aiError('AI_PROVIDER_CONFIG_INVALID', `unsupported protocol ${protocol}`);
}

/** 每个协议的默认请求路径。 */
export function defaultPath(protocol) {
  if (protocol === 'openai-chat') return '/chat/completions';
  if (protocol === 'anthropic-messages') return '/messages';
  throw aiError('AI_PROVIDER_CONFIG_INVALID', `unsupported protocol ${protocol}`);
}

/**
 * 把统一请求翻译成协议请求体。
 *
 * 两种协议都遵循同一条规则：**指令与输入内容分列**。指令进 system 消息，
 * 输入内容进 user 消息。模型因此不会把「粘贴进来的项目文件」当成指令执行。
 */
export function buildProtocolBody(protocol, request, config) {
  const normalized = normalizeModelRequest(request);
  const body = renderInputs(normalized.inputs);
  const userContent = normalized.instructions
    ? `${normalized.instructions}\n\n${body}`.trim()
    : body;

  if (protocol === 'openai-chat') {
    const messages = [];
    if (normalized.instructions) {
      messages.push({ role: 'system', content: normalized.instructions });
      messages.push({ role: 'user', content: body });
    } else {
      messages.push({ role: 'user', content: userContent });
    }
    return {
      model: config.model,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    };
  }

  if (protocol === 'anthropic-messages') {
    const messages = [{ role: 'user', content: userContent }];
    const out = {
      model: config.model,
      max_tokens: config.maxTokens,
      messages,
    };
    if (normalized.instructions) out.system = normalized.instructions;
    if (config.temperature !== 0) out.temperature = config.temperature;
    return out;
  }

  throw aiError('AI_PROVIDER_CONFIG_INVALID', `unsupported protocol ${protocol}`);
}

/**
 * 构造请求头（含认证）。
 *
 * `apiKey` 由调用方从 ATS-402 的凭据库解析得到。它**只**出现在认证头里，
 * 不出现在 URL、不出现在请求体、不出现在日志里。
 */
export function buildProtocolHeaders(protocol, config, apiKey) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...config.headers,
  };
  if (typeof apiKey === 'string' && apiKey.length) {
    if (protocol === 'openai-chat') headers.authorization = `Bearer ${apiKey}`;
    else if (protocol === 'anthropic-messages') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      throw aiError('AI_PROVIDER_CONFIG_INVALID', `unsupported protocol ${protocol}`);
    }
  }
  return headers;
}

/**
 * 从协议响应里取出文本。
 *
 * 两种协议的取法不同，但**失败的方式一样**：取不到就抛
 * `AI_PROVIDER_OUTPUT_INVALID`，绝不返回空字符串或半截文本——ATS-401 的
 * 契约层会把空/坏文本判为 `AGENT_PROVIDER_OUTPUT_INVALID`，但那是在更外层；
 * 在这一层就该知道自己没拿到东西。
 */
export function extractProtocolText(protocol, payload) {
  if (!payload || typeof payload !== 'object') {
    throw aiError('AI_PROVIDER_RESPONSE_INVALID', 'the provider response is not an object');
  }
  if (protocol === 'openai-chat') {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const content = choice?.message?.content;
    if (typeof content !== 'string') {
      throw aiError('AI_PROVIDER_OUTPUT_INVALID', 'the response carries no message content');
    }
    return content;
  }
  if (protocol === 'anthropic-messages') {
    if (!Array.isArray(payload.content)) {
      throw aiError('AI_PROVIDER_OUTPUT_INVALID', 'the response carries no content blocks');
    }
    const text = payload.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    if (!text) {
      throw aiError('AI_PROVIDER_OUTPUT_INVALID', 'the response carries no text block');
    }
    return text;
  }
  throw aiError('AI_PROVIDER_CONFIG_INVALID', `unsupported protocol ${protocol}`);
}

/**
 * 从协议响应里取「模型说了要停」的信息。
 *
 * `stop_reason` 用来识别**长度截断**：输出被截断的模型结果不是有效的提案
 * （半个 JSON 解析不了），必须当成失败而不是当成一次正常的短回答。
 */
export function extractStopReason(protocol, payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (protocol === 'openai-chat') {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    return typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  }
  if (protocol === 'anthropic-messages') {
    return typeof payload.stop_reason === 'string' ? payload.stop_reason : null;
  }
  return null;
}

/** 这个停止原因表示输出被截断。 */
export function isTruncatedStopReason(stopReason) {
  if (typeof stopReason !== 'string') return false;
  return stopReason === 'length' || stopReason === 'max_tokens';
}
