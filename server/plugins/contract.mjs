/**
 * ATS-512 ｜ 插件契约 v1（Plugin contract v1）
 *
 * 本模块定义**插件 Manifest**、**权限清单**与**插件 Runner SDK 的操作面**。
 * 它落实 ATS-501（远程 Runner 协议）冻结的 TR-10 缓解措施：
 *
 *   「插件 Manifest 声明权限；权限超出即拒绝；插件不得跳过审计与证据链路。」
 *
 * 三条设计原则（每条都有可机读校验，见 tools/ats512-probes/）：
 *
 *   1. **声明 ≠ 授予。** Manifest 里的 `permissions` 只是插件的**申请**。
 *      真正生效的是「申请 ∩ 宿主策略上限」：宿主给插件的 tier 决定了上限，
 *      插件自己声明不出来。插件申请超出上限的权限 → `PLUGIN_PERMISSION_DENIED`。
 *   2. **权限词汇表是封闭的。** 未登记的权限 → `PLUGIN_PERMISSION_UNKNOWN`；
 *      永远不可授予的权限（写源码、提交 Git、改 Run 终态、抑制审计、跳过证据、
 *      自审自批……）→ `PLUGIN_PERMISSION_FORBIDDEN`。两者都不因插件声明而放宽。
 *   3. **审计与证据由宿主掌握。** SDK 的审计事件由宿主的 sink 接收、序号由 SDK
 *      单调递增；证据的 SHA-256 由宿主的 resolver 计算，**不由插件提供**。
 *      插件无法自己声明「这个证据我算过了」。
 *
 * 本模块**不实现**插件宿主（谁来加载插件、插件跑在哪个进程、插件的代码怎么
 * 隔离）。宿主与隔离手段归 ATS-502/503/506（远程面）与 ATS-403（沙箱）。
 * 这里交付的是**契约**：清单、权限、SDK 操作面与它们的拒绝规则。
 */
import { CAPABILITY_VOCABULARY } from '../adapters/contract.mjs';

export const PLUGIN_CONTRACT_VERSION = 'plugin-contract/v1';
export const PLUGIN_MANIFEST_VERSION = 'plugin-manifest/v1';

/* ------------------------------------------------------------------ */
/* 权限清单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 可申请（授予）的权限词汇表。每一项都对应 SDK 的一个操作面。
 *
 * 词汇表是**封闭**的：不在这里面的名字一律 `PLUGIN_PERMISSION_UNKNOWN`。
 * 因此新增权限必须先改这里——插件无法靠声明获得一个「未定义但默认可用」的权限。
 */
export const PLUGIN_PERMISSIONS = Object.freeze({
  'test.read': Object.freeze({
    desc: '读取被测项目作用域内的测试脚本',
  }),
  'requirements.read': Object.freeze({
    desc: '读取需求文档',
  }),
  'evidence.read': Object.freeze({
    desc: '读取一次运行已归档的证据',
  }),
  'outcome.report': Object.freeze({
    desc: '上报一次运行的结论（经审核后才生效，不能直接改 Run 终态）',
  }),
});

/**
 * **永远不可授予**的权限。出现在 Manifest 里即拒绝，不因 tier、宿主或插件
 * 身份而放宽。
 *
 * 这份清单是「插件供应链风险」（TR-10）的核心：第三方插件最常见的越权路径
 * 就是申请写源码、提交 Git、直接改 Run 终态、抑制审计事件、跳过证据校验，
 * 或者给自己批自己的提案。
 */
export const PLUGIN_FORBIDDEN_PERMISSIONS = Object.freeze([
  'source.write',        // 写被测项目的源码
  'git.commit',          // 提交 Git
  'git.push',            // 推送 Git
  'run.status.set',      // 直接设置 Run 终态（绕过状态机与审核）
  'audit.suppress',      // 抑制审计事件
  'audit.erase',         // 抹除审计事件
  'evidence.skip',       // 不带证据就上报结论
  'review.self.approve', // 自审自批自己的提案
  'secret.read',         // 读取秘密
  'network.egress',      // 任意出网
  'process.spawn',       // 派生进程
]);

/**
 * 宿主策略档位（tier）。**档位由宿主选，插件不能选**。
 *
 * - `readonly`  只读：读测试脚本与需求文档；
 * - `observer`  观察者：额外可读证据；
 * - `reporter`  报告者：额外可上报运行结论（结论仍须经审核才生效）。
 *
 * 插件 Manifest 声明的权限是**申请**；生效集合 = 申请 ∩ 档位 ∩ 词汇表。
 * 于是「恶意插件请求超权」有两层拒绝：申请了词汇表外的名字（UNKNOWN），
 * 或申请了超出档位上限的名字（DENIED）。
 */
export const PLUGIN_POLICY_TIERS = Object.freeze({
  readonly: Object.freeze(['test.read', 'requirements.read']),
  observer: Object.freeze(['test.read', 'requirements.read', 'evidence.read']),
  reporter: Object.freeze(['test.read', 'requirements.read', 'evidence.read', 'outcome.report']),
});

/** 本地 Bridge 出厂使用的档位：只读。宿主可在审核后为某个插件抬高档位。 */
export const DEFAULT_PLUGIN_POLICY_TIER = 'readonly';

export const PLUGIN_KINDS = Object.freeze(['runner', 'reporter', 'collector']);

/* ------------------------------------------------------------------ */
/* SDK 操作面                                                          */
/* ------------------------------------------------------------------ */

/**
 * SDK 的**全部**操作面。SDK 对象的自有属性必须与这个表的键**完全相等**——
 * 多一个键就多一条逃逸路径，少一个键就少一个能力。
 *
 * `permission: null` 表示该操作不需要权限（只有 describe）。
 */
export const PLUGIN_OPERATIONS = Object.freeze({
  describe: Object.freeze({ permission: null, desc: '自述：清单摘要、生效权限与被拒权限' }),
  readTestFile: Object.freeze({ permission: 'test.read', desc: '读取作用域内的测试脚本' }),
  readRequirements: Object.freeze({ permission: 'requirements.read', desc: '读取需求文档' }),
  readRunEvidence: Object.freeze({ permission: 'evidence.read', desc: '读取一次运行的证据' }),
  reportOutcome: Object.freeze({ permission: 'outcome.report', desc: '上报运行结论（提案，待审核）' }),
});

/** SDK 暴露的操作名列表（有序）。 */
export const PLUGIN_SDK_SURFACE = Object.freeze(Object.keys(PLUGIN_OPERATIONS));

/* ------------------------------------------------------------------ */
/* 错误码                                                              */
/* ------------------------------------------------------------------ */

export const PLUGIN_ERROR_CODES = Object.freeze([
  'PLUGIN_MANIFEST_INVALID',
  'PLUGIN_MANIFEST_VERSION_UNSUPPORTED',
  'PLUGIN_PERMISSION_UNKNOWN',
  'PLUGIN_PERMISSION_FORBIDDEN',
  'PLUGIN_PERMISSION_DENIED',
  'PLUGIN_CAPABILITY_UNKNOWN',
  'PLUGIN_CAPABILITY_REQUIRED',
  'PLUGIN_SCOPE_INVALID',
  'PLUGIN_OPERATION_UNSUPPORTED',
  'PLUGIN_AUDIT_REQUIRED',
  'PLUGIN_EVIDENCE_REQUIRED',
  'PLUGIN_PROPOSAL_INVALID',
  'PLUGIN_REVIEW_SELF_FORBIDDEN',
  'PLUGIN_REVIEW_STATE_INVALID',
]);

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function fail(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  throw err;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlainString(value, max = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** 相对路径：不含 `..` 段、不以 `/` 或盘符开头、不含 NUL。 */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  return segments.every((s) => s !== '..' && s !== '');
}

/* ------------------------------------------------------------------ */
/* 权限解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析插件申请到的权限。
 *
 * 返回：
 *   granted —— 真正生效的权限（申请 ∩ 档位 ∩ 词汇表），已排序；
 *   denied  —— 被拒的申请，逐条给出原因：
 *               `forbidden`      该权限永远不可授予；
 *               `unknown`        不在权限词汇表内；
 *               `not-in-tier`    超出宿主档位上限。
 *
 * **档位是宿主的决定**：插件声明得再多，也只能在档位内生效。
 */
export function resolvePluginPermissions(declared, tier = DEFAULT_PLUGIN_POLICY_TIER) {
  const ceiling = PLUGIN_POLICY_TIERS[tier];
  if (!ceiling) {
    fail('PLUGIN_MANIFEST_INVALID', `unknown policy tier: ${tier}`, {
      tier,
      known: Object.keys(PLUGIN_POLICY_TIERS),
    });
  }
  const requested = Array.isArray(declared) ? declared : [];
  const granted = [];
  const denied = [];
  for (const name of requested) {
    if (typeof name !== 'string' || !name.trim()) {
      fail('PLUGIN_MANIFEST_INVALID', 'permissions entries must be non-empty strings');
    }
    if (PLUGIN_FORBIDDEN_PERMISSIONS.includes(name)) {
      denied.push({ permission: name, reason: 'forbidden', detail: 'this permission can never be granted to a plugin' });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(PLUGIN_PERMISSIONS, name)) {
      denied.push({ permission: name, reason: 'unknown', detail: 'this permission is not in the plugin permission vocabulary' });
      continue;
    }
    if (!ceiling.includes(name)) {
      denied.push({ permission: name, reason: 'not-in-tier', detail: `the host policy tier '${tier}' does not grant this permission` });
      continue;
    }
    granted.push(name);
  }
  granted.sort();
  return { tier, granted, denied };
}

/**
 * 判定某个操作在给定清单与档位下是否被允许。
 *
 * 返回 `{allowed, operation, permission, reason}`。`allowed:false` 时 `reason`
 * 是可行动的说明，调用方直接把它回给用户即可。
 */
export function authorizePluginOperation(manifest, operation, tier = DEFAULT_PLUGIN_POLICY_TIER) {
  const spec = PLUGIN_OPERATIONS[operation];
  if (!spec) {
    return {
      allowed: false,
      operation,
      permission: null,
      reason: `unknown operation: ${operation}`,
      known: [...PLUGIN_SDK_SURFACE],
    };
  }
  if (!spec.permission) {
    return { allowed: true, operation, permission: null, reason: '' };
  }
  const resolution = resolvePluginPermissions(manifest?.permissions, tier);
  if (resolution.granted.includes(spec.permission)) {
    return { allowed: true, operation, permission: spec.permission, reason: '' };
  }
  const denial = resolution.denied.find((d) => d.permission === spec.permission);
  return {
    allowed: false,
    operation,
    permission: spec.permission,
    reason: denial ? denial.detail : 'the permission was not granted',
  };
}

/* ------------------------------------------------------------------ */
/* Manifest 校验                                                       */
/* ------------------------------------------------------------------ */

/**
 * 校验插件 Manifest。返回**归一化后**的清单。
 *
 * 拒绝的情形：
 *   - 清单版本不是 `plugin-manifest/v1` → `PLUGIN_MANIFEST_VERSION_UNSUPPORTED`；
 *   - 字段形状不对 → `PLUGIN_MANIFEST_INVALID`；
 *   - 声明了永远不可授予的权限 → `PLUGIN_PERMISSION_FORBIDDEN`；
 *   - 声明了词汇表外的权限 → `PLUGIN_PERMISSION_UNKNOWN`；
 *   - 声明了 ATS-301 词汇表外的 capability → `PLUGIN_CAPABILITY_UNKNOWN`；
 *   - `kind='runner'` 却没声明四个必需操作 → `PLUGIN_CAPABILITY_REQUIRED`。
 *
 * 注意：超出宿主档位的权限**不在这里拒绝**——档位是运行时的宿主决定，
 * Manifest 本身是合法的，只是当前档位下不生效（见 resolvePluginPermissions）。
 */
export function validatePluginManifest(manifest) {
  if (!isPlainObject(manifest)) fail('PLUGIN_MANIFEST_INVALID', 'manifest must be an object');

  const contract = manifest.contract === undefined ? PLUGIN_MANIFEST_VERSION : manifest.contract;
  if (contract !== PLUGIN_MANIFEST_VERSION) {
    fail('PLUGIN_MANIFEST_VERSION_UNSUPPORTED', `unsupported plugin manifest ${contract}`, {
      supported: PLUGIN_MANIFEST_VERSION,
    });
  }

  const id = manifest.id;
  if (!isPlainString(id, 64) || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.id must be a lowercase identifier');
  }
  const version = manifest.version;
  if (!isPlainString(version, 32) || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.version must be a semantic version');
  }
  const kind = manifest.kind;
  if (!PLUGIN_KINDS.includes(kind)) {
    fail('PLUGIN_MANIFEST_INVALID', `manifest.kind must be one of ${PLUGIN_KINDS.join(', ')}`);
  }
  const entry = manifest.entry;
  if (!isSafeRelativePath(entry) || !/\.(mjs|cjs|js)$/.test(entry)) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.entry must be a relative path to a JavaScript module');
  }

  const protocol = manifest.protocol === undefined ? {} : manifest.protocol;
  if (!isPlainObject(protocol)) fail('PLUGIN_MANIFEST_INVALID', 'manifest.protocol must be an object');
  const major = protocol.major;
  const minor = protocol.minor === undefined ? 0 : protocol.minor;
  if (!Number.isInteger(major) || major < 0) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.protocol.major must be a non-negative integer');
  }
  if (!Number.isInteger(minor) || minor < 0) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.protocol.minor must be a non-negative integer');
  }

  // ATS-301 的能力词汇表：插件声明的 capability 必须是已登记的名字。
  const capabilities = manifest.capabilities === undefined ? [] : manifest.capabilities;
  if (!Array.isArray(capabilities)) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.capabilities must be an array');
  }
  if (capabilities.length > 64) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.capabilities accepts at most 64 entries');
  }
  for (const name of capabilities) {
    if (!isPlainString(name, 64)) {
      fail('PLUGIN_MANIFEST_INVALID', 'manifest.capabilities entries must be non-empty strings');
    }
    if (!Object.prototype.hasOwnProperty.call(CAPABILITY_VOCABULARY, name)) {
      fail('PLUGIN_CAPABILITY_UNKNOWN', `capability '${name}' is not in the ATS-301 capability vocabulary`, {
        capability: name,
      });
    }
  }
  if (kind === 'runner') {
    const required = ['discover', 'start', 'stop', 'collect'];
    const missing = required.filter((r) => !capabilities.includes(r));
    if (missing.length) {
      fail('PLUGIN_CAPABILITY_REQUIRED', 'a runner plugin must declare the four required capabilities', {
        missing,
      });
    }
  }

  // 权限申请：词汇表封闭；永远不可授予的权限直接拒绝。
  const permissions = manifest.permissions === undefined ? [] : manifest.permissions;
  if (!Array.isArray(permissions)) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.permissions must be an array');
  }
  if (permissions.length > 32) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.permissions accepts at most 32 entries');
  }
  const seen = new Set();
  for (const name of permissions) {
    if (!isPlainString(name, 64)) {
      fail('PLUGIN_MANIFEST_INVALID', 'manifest.permissions entries must be non-empty strings');
    }
    if (seen.has(name)) {
      fail('PLUGIN_MANIFEST_INVALID', `duplicate permission: ${name}`);
    }
    seen.add(name);
    if (PLUGIN_FORBIDDEN_PERMISSIONS.includes(name)) {
      fail('PLUGIN_PERMISSION_FORBIDDEN', `permission '${name}' can never be granted to a plugin`, {
        permission: name,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(PLUGIN_PERMISSIONS, name)) {
      fail('PLUGIN_PERMISSION_UNKNOWN', `permission '${name}' is not in the plugin permission vocabulary`, {
        permission: name,
        known: Object.keys(PLUGIN_PERMISSIONS),
      });
    }
  }

  const publisher = manifest.publisher === undefined ? {} : manifest.publisher;
  if (!isPlainObject(publisher)) fail('PLUGIN_MANIFEST_INVALID', 'manifest.publisher must be an object');
  if (!isPlainString(publisher.name, 120)) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.publisher.name must be a non-empty string');
  }
  if (publisher.signature !== undefined && publisher.signature !== null
    && !isPlainString(publisher.signature, 256)) {
    fail('PLUGIN_MANIFEST_INVALID', 'manifest.publisher.signature must be a string when present');
  }

  return {
    contract,
    id,
    version,
    kind,
    entry,
    protocol: { major, minor },
    capabilities: [...capabilities],
    permissions: [...permissions],
    publisher: {
      name: publisher.name,
      signature: publisher.signature === undefined ? null : publisher.signature,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 自述                                                                */
/* ------------------------------------------------------------------ */

/** 只读的契约描述。供 API 与文档引用。 */
export function describePluginContract(tier = DEFAULT_PLUGIN_POLICY_TIER) {
  return {
    contract: PLUGIN_CONTRACT_VERSION,
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    permissions: Object.entries(PLUGIN_PERMISSIONS).map(([name, spec]) => ({ name, desc: spec.desc })),
    forbiddenPermissions: [...PLUGIN_FORBIDDEN_PERMISSIONS],
    tiers: Object.fromEntries(
      Object.entries(PLUGIN_POLICY_TIERS).map(([name, list]) => [name, [...list]]),
    ),
    defaultTier: DEFAULT_PLUGIN_POLICY_TIER,
    kinds: [...PLUGIN_KINDS],
    operations: PLUGIN_SDK_SURFACE.map((name) => ({
      name,
      permission: PLUGIN_OPERATIONS[name].permission,
      desc: PLUGIN_OPERATIONS[name].desc,
    })),
    errorCodes: [...PLUGIN_ERROR_CODES],
    grantPolicy: 'a manifest declares; the host grants. the effective set is the declared set intersected with the host policy tier.',
    auditPolicy: 'every SDK call produces an audit event in the host sink; a denied call is audited as well. the plugin cannot suppress it.',
    evidencePolicy: 'the SHA-256 of an evidence reference is computed by the host resolver, never supplied by the plugin.',
    reviewPolicy: 'a plugin outcome is a proposal with approval=pending; the plugin may not review its own proposal.',
    designStatus: 'CONTRACT_ONLY',
  };
}
