/**
 * ATS-402 ｜ 外传闸门（Egress gate）
 *
 * 本模块是**平台侧**的组件：它把「将要外传什么」变成一份**可核对的**范围，
 * 并在**读取内容之前**判定「有没有有效的知情授权」。
 *
 * 它同时补上 ATS-401 契约层留下的一个缺口（`docs/17-AGENT-CONTRACT.md` §6
 * 「未实现与后续」表）：
 *
 *   | 「`ref` 对应真实源内容」的构造 | ATS-402 / 平台侧 |
 *   | 本层只保证「摘要与内容自洽」且「`ref` 在作用域内」。平台侧读取真实文件
 *   | 并计算摘要的代码路径尚未实现 |
 *
 * 契约层的 `digest` 由**请求方**提供，因此它只能证明「二者自洽」；本模块
 * 在平台侧**亲自读取真实文件**并复算摘要，于是这条保证才成立。
 *
 * 三条硬规则：
 *
 *   1. **先判定，后读取。** `buildEgressScope()` 先判定授权，再读文件。
 *      没有授权时，文件内容**根本不会被读进 Bridge 的内存**。
 *   2. **路径必须落在项目根之内。** 读文件前做 realpath + 子路径判定，
 *      与 ATS-101 的 SEC-004 同一口径。
 *   3. **范围摘要绑定内容。** 授权记录记的是范围摘要（种类 + ref + 内容
 *      摘要），内容一变摘要就变，授权即失效。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { describeEgressScope } from './egress-consent.mjs';

/** 外传闸门的错误码。 */
export const EGRESS_GATE_ERROR_CODES = Object.freeze([
  'EGRESS_GATE_INPUT_INVALID',
  'EGRESS_GATE_SCOPE_INVALID',
  'EGRESS_GATE_PROJECT_UNKNOWN',
]);

const RUN_ID = /^run_(?:[0-9a-f-]{36}|1_[0-9a-f]{24})$/;

/** True when `other` is inside `root` (and not `root` itself). */
export function isSubpath(root, other) {
  const rel = path.relative(root, other);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * 读出真实文件内容并复算摘要。
 *
 * 这是「平台侧构造请求」的落点：摘要由**本机文件系统**给出，不是由请求方
 * 声明。`ref` 越出项目根、或经符号链接越界，一律拒绝。
 */
export function readScopedInput(projectRoot, { kind, ref }) {
  if (!kind || !ref || typeof ref !== 'string') {
    const error = new Error('EGRESS_GATE_INPUT_INVALID');
    error.code = 'EGRESS_GATE_INPUT_INVALID';
    throw error;
  }
  if (path.isAbsolute(ref) || /^[A-Za-z]:/.test(ref)) {
    const error = new Error('EGRESS_GATE_SCOPE_INVALID');
    error.code = 'EGRESS_GATE_SCOPE_INVALID';
    throw error;
  }
  const joined = path.resolve(projectRoot, ref);
  if (!isSubpath(projectRoot, joined)) {
    const error = new Error('EGRESS_GATE_SCOPE_INVALID');
    error.code = 'EGRESS_GATE_SCOPE_INVALID';
    throw error;
  }
  let actual;
  try {
    actual = fs.realpathSync(joined);
  } catch {
    const error = new Error('EGRESS_GATE_INPUT_INVALID');
    error.code = 'EGRESS_GATE_INPUT_INVALID';
    throw error;
  }
  // The REAL path must also be inside the project: a symlink inside the
  // project pointing outside it must not be followed.
  if (!isSubpath(projectRoot, actual)) {
    const error = new Error('EGRESS_GATE_SCOPE_INVALID');
    error.code = 'EGRESS_GATE_SCOPE_INVALID';
    throw error;
  }
  const stat = fs.statSync(actual);
  if (!stat.isFile()) {
    const error = new Error('EGRESS_GATE_INPUT_INVALID');
    error.code = 'EGRESS_GATE_INPUT_INVALID';
    throw error;
  }
  if (stat.size > 1_000_000) {
    const error = new Error('EGRESS_GATE_INPUT_INVALID');
    error.code = 'EGRESS_GATE_INPUT_INVALID';
    throw error;
  }
  const content = fs.readFileSync(actual, 'utf8');
  return {
    kind,
    ref: ref.replace(/\\/g, '/'),
    digest: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

/**
 * 构造一次外传的范围。
 *
 * @param {object} options
 * @param {object} options.project       已登记的项目（{ id, uid, root }）
 * @param {Array}  options.inputs        [{ kind, ref }]
 * @param {object} [options.runResolver] run 类输入的解析器
 */
export function buildEgressScope({ project, inputs, runResolver } = {}) {
  if (!project || typeof project.root !== 'string' || !project.root) {
    const error = new Error('EGRESS_GATE_PROJECT_UNKNOWN');
    error.code = 'EGRESS_GATE_PROJECT_UNKNOWN';
    throw error;
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    const error = new Error('EGRESS_GATE_INPUT_INVALID');
    error.code = 'EGRESS_GATE_INPUT_INVALID';
    throw error;
  }
  const resolved = [];
  for (const input of inputs) {
    if (!input || typeof input !== 'object') {
      const error = new Error('EGRESS_GATE_INPUT_INVALID');
      error.code = 'EGRESS_GATE_INPUT_INVALID';
      throw error;
    }
    if (input.kind === 'run') {
      if (!RUN_ID.test(String(input.ref))) {
        const error = new Error('EGRESS_GATE_INPUT_INVALID');
        error.code = 'EGRESS_GATE_INPUT_INVALID';
        throw error;
      }
      if (typeof runResolver !== 'function') {
        const error = new Error('EGRESS_GATE_INPUT_INVALID');
        error.code = 'EGRESS_GATE_INPUT_INVALID';
        throw error;
      }
      const evidence = runResolver(input.ref);
      if (!evidence) {
        const error = new Error('EGRESS_GATE_INPUT_INVALID');
        error.code = 'EGRESS_GATE_INPUT_INVALID';
        throw error;
      }
      resolved.push(evidence);
      continue;
    }
    resolved.push(readScopedInput(project.root, input));
  }
  return describeEgressScope(resolved);
}

/**
 * 判定并返回将要外传的输入。
 *
 * 顺序是**判定在前、读取在后**：
 *
 *   1. 先问「这份同意书还有效吗、它允许这些种类吗」——此时**还没有读任何
 *      文件**，因此被拒绝时文件内容根本不会进入 Bridge 的内存。
 *   2. 通过之后才读文件、由平台侧复算摘要，再问「内容与用户当时看到的是
 *      同一份吗」。
 *
 * @param {object} options
 * @param {object} options.project      已登记的项目
 * @param {Array}  options.inputs       [{ kind, ref }]
 * @param {object} [options.consent]    授权记录（或 null）
 * @param {object} options.consentStore 外传授权存储（提供 check/checkConsent）
 * @param {Function} [options.runResolver] run 类输入的解析器
 */
export function authorizeEgress({ project, inputs, consent, consentStore, runResolver } = {}) {
  if (!consentStore || typeof consentStore.check !== 'function') {
    throw new TypeError('consentStore with a check() function is required');
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    const error = new Error('EGRESS_GATE_INPUT_INVALID');
    error.code = 'EGRESS_GATE_INPUT_INVALID';
    throw error;
  }

  // --- step 1: the consent itself, before any file is touched --------------
  const kinds = [...new Set(inputs.map((input) => input.kind))];
  const validity = typeof consentStore.checkConsent === 'function'
    ? consentStore.checkConsent(consent, kinds)
    : consentStore.check(consent, []);
  if (!validity.allowed) {
    return { allowed: false, code: validity.code, reason: validity.reason };
  }

  // --- step 2: read the real content and recompute its digest --------------
  const resolved = [];
  for (const input of inputs) {
    if (input.kind === 'run') {
      if (!RUN_ID.test(String(input.ref))) {
        const error = new Error('EGRESS_GATE_INPUT_INVALID');
        error.code = 'EGRESS_GATE_INPUT_INVALID';
        throw error;
      }
      if (typeof runResolver !== 'function') {
        const error = new Error('EGRESS_GATE_INPUT_INVALID');
        error.code = 'EGRESS_GATE_INPUT_INVALID';
        throw error;
      }
      const evidence = runResolver(input.ref);
      if (!evidence) {
        const error = new Error('EGRESS_GATE_INPUT_INVALID');
        error.code = 'EGRESS_GATE_INPUT_INVALID';
        throw error;
      }
      resolved.push(evidence);
      continue;
    }
    resolved.push(readScopedInput(project.root, input));
  }

  // --- step 3: the content must be the content the user confirmed ---------
  const scope = describeEgressScope(resolved);
  const verdict = consentStore.check(consent, resolved);
  return {
    allowed: verdict.allowed,
    code: verdict.code,
    reason: verdict.reason,
    scope,
    inputs: resolved,
  };
}
