/**
 * ATS-402 ｜ 外传审计（Egress audit）
 *
 * 本模块补上完成定义的最后一条：**「越权外传被拦截并审计」**。
 *
 * 闸门本身（`egress-gate.mjs`）负责「拦不拦」；本模块负责「拦了之后有没有留下
 * 痕迹」。两件事必须分开，否则「被拒绝了」这句话没有任何可核对的依据——用户
 * 看不到发生了什么，事后也没法查。
 *
 * 四条硬规则：
 *
 *   1. **成功与失败都记录。** 只记拒绝等于「记录了异常」，不是审计——正常的
 *      外传同样要留下「谁、什么时候、放行了什么范围」的记录。
 *   2. **审计记录永远不含内容。** 记录里只有 `ref`、`digest`（内容的 SHA-256）
 *      与字节数。**没有** content、没有 preview、没有密钥。审计文件本身不能
 *      变成第二个泄漏面。
 *   3. **追加写，不改写。** 记录只追加，撤销一条授权不会把「曾经放行过」的
 *      记录抹掉——审计记录是**事实**，不是状态。
 *   4. **有上限，且按类别计数。** 拒绝类与事实类（放行、授权、撤销）各有
 *      上限，超出后各自丢**本类**最旧的；拒绝再多也挤不掉放行与授权记录。
 *      审计日志不能把 `state.json` 撑成无界增长的单文件；上限写在代码里。
 *
 * 审计记录与授权记录一样持久化在 `state.json` 里（`state.egressAudit`）。
 * 授权与它的审计记录是**两次**相邻的 `saveState`（先授权、后审计）；审计写入
 * 失败会把异常抛给调用方，不会被吞掉。
 */
import crypto from 'node:crypto';

/** 审计日志的契约版本。 */
export const EGRESS_AUDIT_CONTRACT_VERSION = 'egress-audit/v1';

/** 审计事件的类型。 */
export const EGRESS_AUDIT_EVENTS = Object.freeze([
  'egress.granted',      // 闸门放行
  'egress.denied',       // 闸门拒绝
  'consent.granted',     // 用户确认授权
  'consent.revoked',     // 用户撤销授权
]);

/**
 * 审计记录条数的上限。**按类别分别计数、分别丢最旧的**：
 *
 *   - `egress.denied`（拒绝）一类，上限 500；
 *   - 其余（`egress.granted`、`consent.*`，即「事实记录」）一类，上限 500。
 *
 * 两类互不挤占：无论调用方连发多少次被拒绝的请求，放行与授权的记录都不会
 * 被冲掉。每一类超出上限后，丢的是**该类**最旧的一条。
 */
export const EGRESS_AUDIT_CAP = 500;

/** 拒绝类与事实类各自的上限（均为 `EGRESS_AUDIT_CAP`）。 */
export const EGRESS_AUDIT_CAPS = Object.freeze({ denied: EGRESS_AUDIT_CAP, decisions: EGRESS_AUDIT_CAP });

const auditClassOf = (record) => (record.event === 'egress.denied' ? 'denied' : 'decisions');

/**
 * 一条审计记录的形状。
 *
 * 注意这里**没有** `content` 字段，也没有任何字段能装下内容：只有 `ref`、
 * `digest` 与 `bytes`。这正是规则 2 的落点——审计记录描述「哪些文件、摘要是
 * 多少」，不描述「文件里写了什么」。
 */
export function describeAuditRecord(record) {
  return {
    id: record.id,
    at: record.at,
    event: record.event,
    outcome: record.outcome,
    code: record.code ?? null,
    reason: record.reason ?? null,
    consentId: record.consentId ?? null,
    projectId: record.projectId ?? null,
    kinds: Array.isArray(record.kinds) ? [...record.kinds] : [],
    itemCount: record.itemCount ?? 0,
    totalBytes: record.totalBytes ?? 0,
    scopeDigest: record.scopeDigest ?? null,
    items: Array.isArray(record.items)
      ? record.items.map((item) => ({
        kind: item.kind,
        ref: item.ref,
        digest: item.digest ?? null,
        bytes: item.bytes ?? 0,
      }))
      : [],
  };
}

/**
 * 创建一个外传审计存储。
 *
 * 与授权存储一样，持久化由调用方注入（`list` / `persist`），于是审计记录与
 * 其它平台状态共享同一次原子写。
 *
 * @param {object} options
 * @param {() => Promise<object[]>} options.list       读出审计记录
 * @param {(records: object[]) => Promise<void>} options.persist 写回审计记录
 * @param {() => number} [options.now]                 当前时间（毫秒），测试可注入
 */
export function createEgressAuditStore({ list, persist, now = () => Date.now() } = {}) {
  if (typeof list !== 'function' || typeof persist !== 'function') {
    throw new TypeError('list and persist are required');
  }

  /**
   * 追加一条记录。
   *
   * 记录在返回给调用方**之前**落盘：一条没有落盘的审计记录等于没有记录。
   * 落盘失败时把异常抛给调用方——审计写不进去是一次需要被看见的失败，
   * 而不是可以吞掉的细节。
   */
  async function record({
    event,
    outcome,
    code = null,
    reason = null,
    consentId = null,
    projectId = null,
    kinds = [],
    items = [],
    scopeDigest = null,
  } = {}) {
    if (!EGRESS_AUDIT_EVENTS.includes(event)) {
      const error = new Error('EGRESS_AUDIT_EVENT_INVALID');
      error.code = 'EGRESS_AUDIT_EVENT_INVALID';
      throw error;
    }
    const entry = {
      id: `eag_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      at: new Date(now()).toISOString(),
      event,
      outcome: outcome ?? (event === 'egress.denied' ? 'denied' : 'allowed'),
      code,
      reason,
      consentId,
      projectId,
      kinds: [...kinds],
      itemCount: items.length,
      totalBytes: items.reduce((n, item) => n + (Number(item.bytes) || 0), 0),
      scopeDigest,
      // The items are reduced to their DESCRIPTORS. The content itself is
      // dropped here, at the boundary: nothing downstream of this function can
      // see it, so the audit file cannot become a second copy of the data.
      items: items.map((item) => ({
        kind: item.kind,
        ref: item.ref,
        digest: item.digest ?? null,
        bytes: Number(item.bytes) || 0,
      })),
    };
    const records = await list();
    records.push(entry);
    // The cap is per CLASS: a flood of denials only evicts older denials, so a
    // granted/consent record can never be pushed out through this API.
    const klass = auditClassOf(entry);
    let excess = records.filter((r) => auditClassOf(r) === klass).length - EGRESS_AUDIT_CAPS[klass];
    for (let i = 0; excess > 0 && i < records.length; ) {
      if (auditClassOf(records[i]) === klass) { records.splice(i, 1); excess -= 1; } else i += 1;
    }
    await persist(records);
    return describeAuditRecord(entry);
  }

  /** 全部记录（最新的在前）。 */
  async function all() {
    const records = await list();
    return records.slice().reverse().map(describeAuditRecord);
  }

  /** 按 id 找一条记录。 */
  async function find(id) {
    const records = await list();
    const found = records.find((record) => record.id === id);
    return found ? describeAuditRecord(found) : null;
  }

  return Object.freeze({
    contract: EGRESS_AUDIT_CONTRACT_VERSION,
    record,
    all,
    find,
    /** 记录条数（诊断用）。 */
    count: async () => (await list()).length,
  });
}

/** 供诊断使用的契约描述（不含任何内容）。 */
export function describeEgressAudit() {
  return {
    contract: EGRESS_AUDIT_CONTRACT_VERSION,
    events: [...EGRESS_AUDIT_EVENTS],
    cap: EGRESS_AUDIT_CAP,
    note: 'Every egress decision is recorded, allowed or denied. A record names the refs and their digests; it never carries the content and never carries a secret.',
  };
}
