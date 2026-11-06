/**
 * Rejection codes of the deployable control-plane API (ATS-506).
 *
 * The table is the API-side copy of docs/19-REMOTE-RUNNER-PROTOCOL.md §6.2 /
 * §10 (`rejection.codes`). tests/control-plane.test.mjs compares the two code
 * by code, so a protocol change that is not mirrored here fails the build.
 *
 * Every code lives in the `REMOTE_` namespace and none of them equals a local
 * Bridge code (INVALID_SESSION, ORIGIN_NOT_ALLOWED, ...): the two API planes
 * must never be confused while troubleshooting (ADR-019).
 */

/** code -> {http, retryable, hint}. The hint is the one actionable sentence a client may see. */
export const REMOTE_CODES = Object.freeze({
  REMOTE_UNAUTHENTICATED: { http: 401, retryable: false, hint: '认证失败，需重新认证或重新入网' },
  REMOTE_ENROLLMENT_TOKEN_INVALID: { http: 401, retryable: false, hint: '入网凭据无效' },
  REMOTE_PROTOCOL_MISMATCH: { http: 409, retryable: false, hint: '协议版本不兼容' },
  REMOTE_CAPABILITY_MISSING: { http: 409, retryable: false, hint: '节点能力不满足作业要求' },
  REMOTE_TENANT_MISMATCH: { http: 403, retryable: false, hint: '租户上下文不匹配' },
  REMOTE_TENANT_REQUIRED: { http: 403, retryable: false, hint: '缺少租户上下文' },
  REMOTE_ROLE_FORBIDDEN: { http: 403, retryable: false, hint: '权限不足' },
  REMOTE_POLICY_REJECTED: { http: 403, retryable: false, hint: '请求不被协议策略允许，请按契约调整' },
  REMOTE_JOB_NOT_FOUND: { http: 404, retryable: false, hint: '作业不存在' },
  REMOTE_RESOURCE_NOT_FOUND: { http: 404, retryable: false, hint: '资源不存在' },
  REMOTE_JOB_NOT_LEASABLE: { http: 409, retryable: true, hint: '作业当前不可派发' },
  REMOTE_LEASE_EXPIRED: { http: 409, retryable: true, hint: '租约已过期' },
  REMOTE_IDEMPOTENCY_CONFLICT: { http: 409, retryable: false, hint: '幂等键冲突' },
  REMOTE_QUOTA_EXCEEDED: { http: 429, retryable: true, hint: '超出资源配额' },
  REMOTE_RATE_LIMITED: { http: 429, retryable: true, hint: '请求过于频繁' },
  REMOTE_PAYLOAD_TOO_LARGE: { http: 413, retryable: false, hint: '消息过大' },
  REMOTE_PATH_FORBIDDEN: { http: 422, retryable: false, hint: '禁止传递本地路径' },
  REMOTE_SECRET_INLINE_FORBIDDEN: { http: 422, retryable: false, hint: '禁止内联秘密' },
  REMOTE_GIT_SHA_INVALID: { http: 422, retryable: false, hint: 'Git SHA 非法' },
  REMOTE_CODE_UNAVAILABLE: { http: 422, retryable: false, hint: '本节点不具备该代码版本' },
  REMOTE_TEST_UID_UNKNOWN: { http: 422, retryable: false, hint: '测试标识未知' },
  REMOTE_WORKSPACE_DIRTY: { http: 409, retryable: false, hint: '工作区状态不符' },
  REMOTE_EVIDENCE_CHECKSUM_MISMATCH: { http: 422, retryable: false, hint: '证据校验和不匹配' },
  REMOTE_RUNNER_UNREACHABLE: { http: 503, retryable: true, hint: '节点暂不可达' },
  REMOTE_INTERNAL: { http: 500, retryable: true, hint: '服务端内部错误' },
});

function entryOf(code) {
  const entry = Object.prototype.hasOwnProperty.call(REMOTE_CODES, code) ? REMOTE_CODES[code] : null;
  // An unknown code is a programming error inside the control plane, never a
  // client-facing condition: fail loudly instead of inventing a response.
  if (!entry) throw new TypeError(`unknown control-plane code: ${String(code)}`);
  return entry;
}

/**
 * The error the request pipeline throws. `reason` is AUDIT-ONLY: it explains
 * the rejection in the audit trail and is never written to the response
 * (docs/19 §3.4, ADR-021).
 */
export class ControlPlaneError extends Error {
  constructor(code, reason = null) {
    const entry = entryOf(code);
    super(code);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.http = entry.http;
    this.retryable = entry.retryable;
    this.reason = reason;
  }
}

/** The only body an error response may carry: no request data, path, stack or message. */
export function errorBody(code) {
  const entry = entryOf(code);
  return { error: code, hint: entry.hint, retryable: entry.retryable };
}
