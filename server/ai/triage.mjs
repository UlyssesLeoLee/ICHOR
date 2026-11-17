/**
 * ATS-410 ｜ 失败归因内核（Triage core）
 *
 * 这个模块回答一个问题：**这次失败是谁的锅**——脚本、产品、环境，还是说不准。
 * 验收标准是「分类含脚本/产品/环境/不确定；每条推断附可核对来源」。
 *
 * 为什么不是「把报错丢给模型」
 * --------------------------
 * 因为那样得到的结论**不可核对**：同样的报错，模型两次可能给出不同的归因，
 * 而验收标准要求每条推断附**可核对来源**。一个不可复现的归因没有来源可核对。
 *
 * 因此归因内核是**确定性的**：同一份证据 → 同一组事实 → 同一个分类。
 * 模型增强是**可选叠加**在确定性判定之上的（§「模型增强」），不参与决定分类——
 * 分类错了，模型的话不能把它圆回来。
 *
 * 四条硬规则
 * ----------
 *   1. **分类是封闭集合**：脚本 / 产品 / 环境 / 不确定，四类，不多不少。
 *   2. **每条结论必须有可核对的证据引用**。没有证据引用的结论不被接受。
 *   3. **证据引用必须指得到**：引用不在本次运行里的用例或文件，报错而不是接受。
 *   4. **本模块不写任何东西**：不 import 写入接口，不 spawn 进程，不改断言，
 *      不提交。Git 历史由**注入的**读取器提供。
 *
 * 第 4 条是「不能自动修改断言或提交」这条验收标准（FR-025）的落点：它**不是**
 * 一条约定，而是模块本身碰不到写路径。静态检查见
 * `tools/ats410-probes/probe-triage-boundary.mjs`（带负控）。
 *
 * 依赖的既有口径（**复用，不重写**）
 * ----------------------------------
 *   * `normalizeErrorSignature` / `classifyFailureKind` / `testKeyOf`
 *     —— 来自 `apps/studio/public/quality.mjs`（ATS-216）。失败签名、失败种类
 *     与「同一个逻辑用例」的识别口径**已有一个实现**；再写一份就会漂移。
 *   * 证据是否被篡改的判定属 ATS-209 的 `verifyEvidence`，由**调用方**注入结果，
 *     本模块不重复实现（它需要读文件系统，而本模块刻意不读）。
 */
import crypto from 'node:crypto';

import {
  classifyFailureKind,
  normalizeErrorSignature,
  testKeyOf,
} from '../../apps/studio/public/quality.mjs';

/** 本层的契约版本。 */
export const TRIAGE_CONTRACT_VERSION = 'triage/v1';

/**
 * 归因分类。**封闭集合**：验收标准要求「分类含脚本/产品/环境/不确定」，
 * 这四类就是全部——不开放第五类，因此一个无法归因的失败只能进「不确定」，
 * 不会被塞进某个看起来更具体的类别里。
 */
export const TRIAGE_CATEGORIES = Object.freeze([
  'script',
  'product',
  'environment',
  'undetermined',
]);

/** 归因结论的置信度区间（闭区间）。 */
export const TRIAGE_CONFIDENCE = Object.freeze({
  SCRIPT: 0.7,
  PRODUCT: 0.5,
  ENVIRONMENT: 0.8,
  UNDETERMINED: 0.2,
});

/** 归因内核的错误码。调用方按 `err.code` 分支，不解析消息文本。 */
export const TRIAGE_ERROR_CODES = Object.freeze([
  'TRIAGE_REQUEST_INVALID',
  'TRIAGE_RUN_NOT_FOUND',
  'TRIAGE_RUN_NOT_TERMINAL',
  'TRIAGE_EVIDENCE_REQUIRED',
  'TRIAGE_EVIDENCE_OUT_OF_SCOPE',
  'TRIAGE_EVIDENCE_NOT_FOUND',
  'TRIAGE_MODEL_UNAVAILABLE',
  'TRIAGE_MODEL_OUTPUT_INVALID',
]);

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 一个**可复算**的摘要。
 *
 * 证据引用的摘要必须是读者能**自己重算**的那个值，否则它就只是装饰。因此
 * 摘要取自「这份证据的可观察事实」的规范 JSON，而不是文件字节——运行记录在
 * `state.json` 里，读者拿得到。
 *
 * 事实的取法是**规范化的**：键排序、无 `undefined`、无函数。这样同一份运行
 * 记录永远得到同一个摘要，与字段在对象里的书写顺序无关。
 *
 * @param {object} facts 证据的可观察事实
 * @returns {string} sha256 十六进制
 */
export function digestOfFacts(facts) {
  return crypto.createHash('sha256').update(canonicalJson(facts), 'utf8').digest('hex');
}

/**
 * 规范 JSON：键按字典序、无 `undefined`、数组保持原序。
 *
 * 数组保持原序是**刻意的**：用例列表的顺序是事实的一部分（报告的次序），排序
 * 会把「同一批用例、另一种排列」变成同一个摘要，而它们不是同一份证据。
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** 一次运行的可观察事实（摘要的取数口径）。 */
export function runFacts(run) {
  return {
    id: run?.id ?? null,
    status: run?.status ?? null,
    gitCommit: run?.gitCommit ?? null,
    runner: run?.runner ?? null,
    startedAt: run?.startedAt ?? null,
    finishedAt: run?.finishedAt ?? null,
    failed: Number.isFinite(run?.summary?.failed) ? run.summary.failed : null,
    total: Number.isFinite(run?.summary?.total) ? run.summary.total : null,
  };
}

/** 一个用例的可观察事实（摘要的取数口径）。 */
export function caseFacts(kase) {
  return {
    key: caseKeyOf(kase),
    title: kase?.title ?? '',
    file: kase?.file ?? '',
    line: Number.isInteger(kase?.line) ? kase.line : null,
    status: kase?.status ?? null,
    error: kase?.error ?? '',
  };
}

/**
 * 失败的**种类**（ATS-216 的口径）：timeout / network / assertion / element /
 * navigation / cancelled / other。
 *
 * 归因分类建立在它之上，但**不是**同一件事：`element` 与 `navigation` 说的是
 * 「哪一步没成」，而归因说的是「谁的锅」。
 */
export function failureKindOf(errorText) {
  return classifyFailureKind(normalizeErrorSignature(errorText));
}

/**
 * 这类失败是不是**环境**问题。
 *
 * 判据是失败种类的集合，不是对错误文本的自由匹配：
 *
 *   * `timeout` —— 引擎等不到东西。环境慢、网络不通、服务没起来都会这样。
 *   * `network` —— 连接失败。依赖的网络不可达。
 *   * `element` —— 定位不到元素。元素不存在（产品错）与元素没渲染出来
 *     （环境错）**都会**这样，所以 `element` 本身**不判**为环境。
 *   * `navigation` —— 页面到不了。地址错（脚本错）与服务没起（环境错）都会这样，
 *     同样**不判**为环境。
 *
 * `element` 与 `navigation` 之所以**不**判为环境：把它们判为环境，会让「页面真的
 * 变了」这种最常见的产品缺陷被系统性地归成环境问题——而环境问题的处理方式
 * （重试、等一等）是**不会**让产品缺陷消失的。
 *
 * @param {string} kind 失败种类
 * @returns {boolean}
 */
export function isEnvironmentKind(kind) {
  return kind === 'timeout' || kind === 'network';
}

/**
 * 归类一次失败。
 *
 * **四条判据**：
 *
 *   1. `environment` —— 超时 / 网络。环境坏了的时候脚本与产品**都**跑不起来，
 *      这类失败不区分二者。
 *   2. `script` —— 断言类失败，且失败用例所在的测试脚本文件**命中可疑变更**。
 *   3. `product` —— 断言类失败，且**未命中**可疑变更。
 *   4. `undetermined` —— 其余一切。
 *
 * 第 2/3 步依赖可疑变更：断言失败只说明「实际值 ≠ 期望值」，至于期望值写错了
 * 还是实现错了，**断言文本里没有这个信息**——唯一能提供它的是代码变更历史。
 * 没有可比的历史时**降级为 `undetermined`**，而不是降级为 `product`：把
 * 「没有证据」当成「证据指向产品」，会让归因系统在没有证据时系统性冤枉产品代码。
 *
 * **关于顺序**：判据 1 与判据 2/3 覆盖的失败种类**互不相交**（`{timeout, network}`
 * 对 `{assertion, element, navigation}`），因此对调二者**不改变任何一个输入的结果**——
 * 顺序本身不是承重的。**承重的是历史闸门**（第 2/3 步里 `hasHistory` 的那一步）：
 * 去掉它，每一个没有历史的断言类失败都会被归咎于某一方。这一点由
 * `tools/ats410-probes/probe-triage-boundary.mjs` 实测（变异前后分类结果改变）。
 *
 * @param {object} options
 * @param {string} options.kind       失败种类（ATS-216 口径）
 * @param {boolean} options.suspect   失败用例所在的测试脚本是否命中可疑变更
 * @param {boolean} options.hasHistory 是否**有**可比的历史（没有则不判脚本/产品）
 * @returns {{category:string, confidence:number, basis:string}}
 */
export function classifyFailure({ kind, suspect = false, hasHistory = false } = {}) {
  const failureKind = String(kind ?? 'other');
  if (isEnvironmentKind(failureKind)) {
    return {
      category: 'environment',
      confidence: TRIAGE_CONFIDENCE.ENVIRONMENT,
      basis: `the failure kind is ${failureKind}: the environment did not answer (a timeout or a connection failure does not distinguish a script defect from a product defect)`,
    };
  }
  const assertionLike = failureKind === 'assertion' || failureKind === 'element' || failureKind === 'navigation';
  if (assertionLike && hasHistory) {
    if (suspect) {
      return {
        category: 'script',
        confidence: TRIAGE_CONFIDENCE.SCRIPT,
        basis: `the failure kind is ${failureKind} and the test script of the failing case changed between the compared commits`,
      };
    }
    return {
      category: 'product',
      confidence: TRIAGE_CONFIDENCE.PRODUCT,
      basis: `the failure kind is ${failureKind} and the test script of the failing case did NOT change between the compared commits`,
    };
  }
  return {
    category: 'undetermined',
    confidence: TRIAGE_CONFIDENCE.UNDETERMINED,
    basis: assertionLike
      ? `the failure kind is ${failureKind}, but there is no comparable commit history, so the assertion text alone cannot tell a script defect from a product defect`
      : `the failure kind is ${failureKind}: it names no assertion and no environment signal`,
  };
}

/**
 * 构造一条证据引用。
 *
 * 引用是**可核对的对象**，不是一句描述：读者拿着 `ref` 能回到那次运行、那个用例、
 * 那个文件，并自己核对 `digest`。
 *
 * @param {object} options
 * @param {string} options.kind    run / case / artifact / commit
 * @param {string} options.ref     标识（相对引用或标识符，**不含本机绝对路径**）
 * @param {string} [options.digest] SHA-256（`commit` 除外——commit 本身就是它的标识）
 * @param {string} options.detail  人读的说明
 * @returns {object}
 */
export function evidenceRef({ kind, ref, digest = null, detail = '' } = {}) {
  const known = ['run', 'case', 'artifact', 'commit'];
  if (!known.includes(kind)) {
    fail('TRIAGE_REQUEST_INVALID', `evidence kind must be one of ${known.join(', ')}`, { kind });
  }
  if (typeof ref !== 'string' || !ref.trim()) {
    fail('TRIAGE_REQUEST_INVALID', 'evidence ref must be a non-empty string');
  }
  // 绝对路径会把本机的目录结构带进报告，而报告是要给人看、也要被归档的。
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(ref)) {
    fail('TRIAGE_REQUEST_INVALID', 'evidence ref must not be an absolute path', { ref });
  }
  if (kind !== 'commit') {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      fail('TRIAGE_REQUEST_INVALID', `evidence ref ${ref} must carry a lowercase sha256 digest`);
    }
  }
  return { kind, ref, digest: kind === 'commit' ? null : digest, detail: String(detail ?? '') };
}

/**
 * 校验一份归因报告。
 *
 * 三条规则，各有理由：
 *
 *   1. **每条结论都要有证据引用**（`TRIAGE_EVIDENCE_REQUIRED`）。没有来源的
 *      结论不是结论。
 *   2. **引用必须落在本次归因的运行里**（`TRIAGE_EVIDENCE_OUT_OF_SCOPE`）。
 *      引用一次没参与归因的运行，等于没有引用。
 *   3. **引用必须指得到**（`TRIAGE_EVIDENCE_NOT_FOUND`）：`case` 引用要真的
 *      在那次运行的用例列表里，`artifact` 引用要真的在那次运行的证据清单里。
 *
 * @param {object} report
 * @param {object} options
 * @param {string[]} options.runIds      参与本次归因的运行 id
 * @param {Set<string>} options.caseKeys  参与本次归因的用例键
 * @param {Set<string>} options.artifacts 参与本次归因的证据文件相对路径
 * @returns {object} 校验后的报告
 */
export function validateTriageReport(report, { runIds = [], caseKeys = new Set(), artifacts = new Set() } = {}) {
  if (!isPlainObject(report)) fail('TRIAGE_REQUEST_INVALID', 'the triage report must be an object');
  if (!Array.isArray(report.findings)) {
    fail('TRIAGE_REQUEST_INVALID', 'the triage report must carry a findings array');
  }
  const scope = new Set(runIds);
  const findings = report.findings.map((finding, index) => {
    if (!isPlainObject(finding)) {
      fail('TRIAGE_REQUEST_INVALID', `findings[${index}] must be an object`);
    }
    if (!TRIAGE_CATEGORIES.includes(finding.category)) {
      fail('TRIAGE_REQUEST_INVALID', `findings[${index}].category must be one of ${TRIAGE_CATEGORIES.join(', ')}`, {
        category: finding.category,
      });
    }
    const refs = finding.evidenceRefs;
    if (!Array.isArray(refs) || !refs.length) {
      fail('TRIAGE_EVIDENCE_REQUIRED', `findings[${index}] must cite at least one evidence ref`, {
        index,
      });
    }
    const out = [];
    for (const ref of refs) {
      if (!isPlainObject(ref)) {
        fail('TRIAGE_REQUEST_INVALID', `findings[${index}].evidenceRefs entries must be objects`);
      }
      if (ref.kind === 'run' && !scope.has(ref.ref)) {
        fail('TRIAGE_EVIDENCE_OUT_OF_SCOPE', `evidence ref ${ref.ref} is not part of this triage`, {
          ref: ref.ref,
        });
      }
      if (ref.kind === 'case' && !caseKeys.has(ref.ref)) {
        fail('TRIAGE_EVIDENCE_NOT_FOUND', `evidence ref ${ref.ref} is not one of the triaged cases`, {
          ref: ref.ref,
        });
      }
      if (ref.kind === 'artifact' && artifacts.size && !artifacts.has(ref.ref)) {
        fail('TRIAGE_EVIDENCE_NOT_FOUND', `evidence ref ${ref.ref} is not one of the triaged artifacts`, {
          ref: ref.ref,
        });
      }
      out.push(ref);
    }
    return { ...finding, evidenceRefs: out };
  });
  return { ...report, findings };
}

/**
 * 找出**可疑变更**：两次运行的 commit 不同时，失败用例所在的测试脚本文件
 * 在两次提交之间是否改过。
 *
 * 规则（三条，各有理由）：
 *
 *   1. **只比对同一个用例**——跨运行比的是同一个逻辑用例（`testKeyOf()` 的键）。
 *   2. **commit 必须不同**——commit 相同就意味着代码没变，两次结果不同是 flaky，
 *      不是变更引起的（与 `evidence-workbench.mjs` 的 `sameCommit` 同一口径）。
 *   3. **只看测试脚本文件**——产品代码的变更不是「可疑变更」：它可能是修复，
 *      也可能是引入缺陷，正是归因要判断的对象。
 *
 * @param {object} options
 * @param {object} options.run           失败的运行记录
 * @param {object} options.baseline      比对基线的运行记录
 * @param {Function} options.gitChanged  (from, to, file) => boolean
 * @param {Function} [options.gitDiff]   (from, to, file) => Array  改动文件列表
 * @returns {{suspect:boolean, files:Array, commits:Array, comparable:boolean}}
 */
export function detectSuspectChanges({ run, baseline, gitChanged, gitDiff } = {}) {
  const from = baseline?.gitCommit ?? null;
  const to = run?.gitCommit ?? null;
  const commits = [from, to].filter((c) => typeof c === 'string' && c.length);
  if (!from || !to || from === to) {
    // 没有可比的 commit：两次结果不同就归因不了是变更引起的。
    return { suspect: false, files: [], commits, comparable: false };
  }
  if (typeof gitChanged !== 'function') {
    return { suspect: false, files: [], commits, comparable: true };
  }
  const files = [];
  for (const file of changedScriptFiles(run)) {
    let changed = false;
    try {
      changed = Boolean(gitChanged(from, to, file));
    } catch {
      changed = false;
    }
    if (!changed) continue;
    files.push(file);
    let diff = [];
    if (typeof gitDiff === 'function') {
      try {
        diff = gitDiff(from, to, file) ?? [];
      } catch {
        diff = [];
      }
    }
    files[files.length - 1] = { file, diff };
  }
  return {
    suspect: files.length > 0,
    files,
    commits,
    comparable: true,
  };
}

/**
 * 失败用例涉及的**测试脚本文件**。
 *
 * 只有测试脚本才是「可疑变更」的判据对象（规则 3）。产品代码不在其中。
 */
function changedScriptFiles(run) {
  const cases = Array.isArray(run?.summary?.cases) ? run.summary.cases : [];
  const files = new Set();
  for (const c of cases) {
    const file = c?.file;
    if (typeof file === 'string' && file && /\.(spec|test)\.[cm]?[jt]sx?$/.test(file)) {
      files.add(file);
    }
  }
  return [...files];
}

/**
 * 跨运行识别**同一个逻辑用例**。
 *
 * 口径来自 ATS-216 的 `testKeyOf()`：文件 + describe 路径 + 标题。行号**不**参与
 * 键——行号会随上方的任何改动而移动，拿它做键会把一个用例的历史切成两半。
 */
export function caseKeyOf(kase) {
  const scope = Array.isArray(kase?.scope)
    ? kase.scope.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  const line = Number.isInteger(kase?.line) ? kase.line : null;
  const caseKey = typeof kase?.caseKey === 'string' && kase.caseKey.length ? kase.caseKey : null;
  return testKeyOf(kase?.file ?? '', kase?.title ?? '', { scope, line, caseKey });
}

/**
 * 一个归因内核。
 *
 * @param {object} options
 * @param {Function} options.readRun      (runId) => 运行记录
 * @param {Function} [options.gitChanged]  (from, to, file) => boolean
 * @param {Function} [options.gitDiff]     (from, to, file) => Array
 * @param {Function} [options.digestOf]   (kind, ref) => SHA-256（证据引用的摘要）
 * @param {Function} [options.verifyEvidence] (run) => ATS-209 的校验结果
 * @param {Function} [options.modelEnhance] 可选的模型增强层（未接入时省略）
 */
export function createTriageEngine({
  readRun,
  gitChanged,
  gitDiff,
  digestOf,
  verifyEvidence,
  modelEnhance,
} = {}) {
  if (typeof readRun !== 'function') {
    fail('TRIAGE_REQUEST_INVALID', 'a readRun() resolver is required');
  }

  /**
   * 一次运行的失败用例。
   *
   * 只看**失败**的用例：通过了的不需要归因。`flaky` 的用例单列——它失败过又
   * 通过了，归因的对象是那次失败，而 flaky 的成因与「稳定失败」不同。
   */
  function failedCases(run) {
    const cases = Array.isArray(run?.summary?.cases) ? run.summary.cases : [];
    return cases.filter((c) => c && c.status === 'failed');
  }

  /**
   * 对一次运行做归因。
   *
   * @param {object} request
   * @param {string} request.runId
   * @param {string} [request.baselineRunId]
   * @param {boolean} [request.modelEnhanced]
   * @returns {Promise<object>}
   */
  async function triage(request = {}) {
    if (!isPlainObject(request)) {
      fail('TRIAGE_REQUEST_INVALID', 'the triage request must be an object');
    }
    const runId = request.runId;
    if (typeof runId !== 'string' || !runId.trim()) {
      fail('TRIAGE_REQUEST_INVALID', 'runId must be a non-empty string');
    }
    const run = readRun(runId);
    if (!run) fail('TRIAGE_RUN_NOT_FOUND', `the run ${runId} does not exist`, { runId });
    if (!run.status || !['passed', 'failed', 'cancelled', 'error', 'interrupted'].includes(run.status)) {
      fail('TRIAGE_RUN_NOT_TERMINAL', `the run ${runId} is still in flight`, {
        runId,
        status: run.status ?? null,
      });
    }
    const baseline = request.baselineRunId ? readRun(request.baselineRunId) : null;
    if (request.baselineRunId && !baseline) {
      fail('TRIAGE_RUN_NOT_FOUND', `the baseline run ${request.baselineRunId} does not exist`, {
        runId: request.baselineRunId,
      });
    }

    const failures = failedCases(run);
    const suspect = detectSuspectChanges({ run, baseline, gitChanged, gitDiff });

    // 跨运行找出「同一个用例在基线里是通过的」——那是差异建议的前提。
    const baselineByKey = new Map();
    for (const c of Array.isArray(baseline?.summary?.cases) ? baseline.summary.cases : []) {
      if (!c) continue;
      baselineByKey.set(caseKeyOf(c), c);
    }

    const findings = [];
    for (const c of failures) {
      const key = caseKeyOf(c);
      const errorText = c.error ?? '';
      const kind = failureKindOf(errorText);
      // 可疑变更只对**该用例所在的那个文件**判定：一个用例的失败不因另一个文件
      // 改过就变成脚本问题。
      const fileSuspect = suspect.comparable && suspect.files.some((f) => f.file === c.file);
      const verdict = classifyFailure({
        kind,
        suspect: fileSuspect,
        hasHistory: suspect.comparable,
      });

      const refs = [];
      const runDigest = digestOf ? digestOf('run', runId, run) : digestOfFacts(runFacts(run));
      refs.push(evidenceRef({
        kind: 'run',
        ref: runId,
        digest: runDigest,
        detail: `the run that failed (status ${run.status}, commit ${run.gitCommit ?? 'unknown'})`,
      }));
      const caseDigest = digestOf ? digestOf('case', key, c) : digestOfFacts(caseFacts(c));
      refs.push(evidenceRef({
        kind: 'case',
        ref: key,
        digest: caseDigest,
        detail: `the failing case ${c.title ?? '(untitled)'} in ${c.file ?? '(unknown file)'}`,
      }));
      if (run.gitCommit) {
        refs.push(evidenceRef({
          kind: 'commit',
          ref: String(run.gitCommit),
          detail: `the commit the failing run was made from`,
        }));
      }
      if (baseline && baseline.gitCommit && baseline.gitCommit !== run.gitCommit) {
        refs.push(evidenceRef({
          kind: 'commit',
          ref: String(baseline.gitCommit),
          detail: `the commit of the baseline run the failure is compared against`,
        }));
      }

      // 差异建议：**同一个用例**从通过变成失败，且两次 commit 不同。
      let diffSuggestion = null;
      const baseCase = baselineByKey.get(key);
      if (baseCase && baseCase.status === 'passed' && suspect.comparable) {
        const changed = suspect.files.filter((f) => f.file === c.file);
        diffSuggestion = {
          kind: 'regression',
          from: { runId: baseline.id ?? null, commit: baseline.gitCommit ?? null, status: baseCase.status },
          to: { runId: run.id ?? null, commit: run.gitCommit ?? null, status: c.status },
          changedFiles: changed.map((f) => f.file),
          // 建议**不含**修复动作，也不含要改的断言：改断言是 ATS-411 与平台侧
          // 评审的事。
          note: 'the same case passed on the baseline commit and fails on this commit; the changed files are listed above for a human to review',
        };
      }

      findings.push({
        caseKey: key,
        title: c.title ?? '',
        file: c.file ?? '',
        line: Number.isInteger(c.line) ? c.line : null,
        category: verdict.category,
        confidence: verdict.confidence,
        basis: verdict.basis,
        failureKind: kind,
        error: errorText,
        evidenceRefs: refs,
        suspectChanges: fileSuspect
          ? suspect.files.filter((f) => f.file === c.file).map((f) => ({ file: f.file, diff: f.diff }))
          : [],
        diffSuggestion,
      });
    }

    const byCategory = {};
    for (const category of TRIAGE_CATEGORIES) byCategory[category] = 0;
    for (const f of findings) byCategory[f.category] += 1;

    const checks = [];
    const caseKeys = new Set(findings.map((f) => f.caseKey));
    checks.push({
      name: 'every failed case of the run produced exactly one finding',
      ok: findings.length === failures.length,
      detail: `${failures.length} failed case(s), ${findings.length} finding(s)`,
    });
    checks.push({
      name: 'every finding cites at least one evidence ref',
      ok: findings.every((f) => f.evidenceRefs.length > 0),
      detail: `${findings.length} finding(s), ${findings.filter((f) => f.evidenceRefs.length > 0).length} with evidence`,
    });
    if (verifyEvidence) {
      const verification = verifyEvidence(run);
      checks.push({
        name: 'the evidence of the triaged run is intact',
        ok: Boolean(verification?.verified),
        detail: verification?.verified
          ? 'the evidence manifest of the run verifies'
          : `the evidence of the run does NOT verify: ${verification?.reason ?? 'unknown'}`,
      });
    }

    let modelEnhanced = false;
    if (request.modelEnhanced) {
      // 模型增强是**可选叠加**的。没有配置提供商时**报错**，不静默退化成
      // 确定性结果——一次「请求了模型但其实没调用」的诊断，报告上却写着
      // modelEnhanced: true，是撒谎。
      if (typeof modelEnhance !== 'function') {
        fail('TRIAGE_MODEL_UNAVAILABLE', 'no model provider is configured for triage enhancement');
      }
      const enhanced = await modelEnhance({ run, baseline, findings });
      if (!isPlainObject(enhanced) || !Array.isArray(enhanced.notes)) {
        fail('TRIAGE_MODEL_OUTPUT_INVALID', 'the model enhancement did not return a notes array');
      }
      modelEnhanced = true;
      findings.forEach((f, i) => {
        const note = enhanced.notes[i];
        if (typeof note === 'string' && note.length) f.modelNote = note;
      });
    }

    const report = {
      contract: TRIAGE_CONTRACT_VERSION,
      runId,
      gitCommit: run.gitCommit ?? null,
      baselineRunId: baseline?.id ?? null,
      findings,
      summary: {
        byCategory,
        total: findings.length,
        suspectChanges: suspect.files.map((f) => f.file),
        comparableHistory: suspect.comparable,
      },
      checks,
      modelEnhanced,
    };
    return validateTriageReport(report, {
      runIds: [runId, baseline?.id].filter(Boolean),
      caseKeys,
      artifacts: new Set(),
    });
  }

  return Object.freeze({ triage });
}

/**
 * 契约描述。**不含**任何密钥、端点或本机路径。
 */
export function describeTriageContract() {
  return {
    contract: TRIAGE_CONTRACT_VERSION,
    categories: [...TRIAGE_CATEGORIES],
    // 判据的**顺序**记录在契约里，但它**不是**承重的：environment 分支与
    // 断言类分支覆盖的失败种类互不相交，对调二者不改变任何一个输入的结果。
    // 真正承重的是历史闸门（见 `rules.undetermined`）。
    classificationOrder: ['environment', 'script', 'product', 'undetermined'],
    rules: {
      environment: 'the failure kind is timeout or network: the environment did not answer, which does not distinguish a script defect from a product defect',
      script: 'an assertion-like failure whose test script changed between the compared commits',
      product: 'an assertion-like failure whose test script did NOT change between the compared commits',
      undetermined: 'everything else -- including an assertion-like failure with no comparable commit history, because the assertion text alone cannot tell a script defect from a product defect',
    },
    loadBearing:
      'the HISTORY GATE: an assertion-like failure with no comparable commit history is `undetermined`, never `script` or `product`. The order between the environment branch and the assertion-like branch is NOT load-bearing (the two cover disjoint kinds); the gate is.',
    confidence: { ...TRIAGE_CONFIDENCE },
    evidenceRules: {
      required: 'every finding must cite at least one evidence ref',
      inScope: 'a run ref must be one of the runs this triage compared',
      found: 'a case or artifact ref must really exist in the triaged run',
      noAbsolutePaths: 'an evidence ref is never an absolute path',
    },
    suspectChangeDefinition:
      'the test script of the failing case changed between two runs whose gitCommit differs; product code changes are NOT suspect changes (they may be the fix or the defect), and a comparison at the same commit is not comparable at all',
    diffSuggestion:
      'the same case passed on the baseline commit and fails on this commit; the suggestion names the changed files and carries NO fix action and NO assertion change',
    writePolicy:
      'triage is READ-ONLY: it writes no file, changes no assertion, updates no expected result and creates no commit. The Git history is read through an INJECTED reader, so this module has no process-spawning path of its own.',
    modelPolicy:
      'model enhancement is OPTIONAL and additive: it never decides the category. When no provider is configured, a request for it FAILS instead of silently degrading to the deterministic result.',
    evidenceIntegrity:
      'the ATS-209 verification result of the triaged run is reported as a check; a run whose evidence does not verify says so',
  };
}
