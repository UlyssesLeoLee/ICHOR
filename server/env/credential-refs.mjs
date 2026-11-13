/**
 * ATS-213 ｜ 凭据引用的解析（credential reference resolution）
 *
 * 一条环境档案里的变量，其值可以是**引用**而不是明文：
 *
 *   { "API_TOKEN": { "credentialRef": "cred_<24 hex>" } }
 *   { "API_TOKEN": "cred:<24 hex>" }
 *
 * 档案里只留**引用**；平台在**运行启动时**把引用解析成密钥，注入封口的
 * runner 环境。解析出来的密钥**只**进入子进程的环境块，不进入运行记录、
 * 事件日志、SQLite 镜像、证据归档或 stderr。
 *
 * 三条硬规则（每条都有可机读校验）：
 *
 *   1. **解析失败即拒绝启动。** 引用不存在、凭据库不可达、或者读出来是
 *      空字符串——都**拒绝**这次运行并报出 `CREDENTIAL_*` 原因码。
 *      在**缺少密钥**的情况下静默运行是更坏的形态：被测系统会拿到一个
 *      空的 token，测试结果变得毫无意义，而没有人知道为什么。
 *
 *   2. **秘密只出现在子进程的环境块里。** 解析的结果不回写到档案，不
 *      回写到运行记录，不出现在任何被归档的文件里。档案里留着的永远是
 *      引用。
 *
 *   3. **运行记录只记变量名。** 一个带引用的变量名照样进 `envVariables`
 *      （那是变量**名**，不是值）；档案里存的是引用，引用**不是秘密**，
 *      但运行记录里依然不出现它——记录里出现的是名字与「它来自凭据库」
 *      这一事实。
 */
import { parseCredentialRef } from './whitelist.mjs';

/**
 * 引用解析失败时抛出的错误。
 *
 * 错误码是**封闭**的，调用方按 `err.code` 分支，不解析消息文本。消息里
 * 只有**变量名**与**引用 id**——两者都不是秘密。
 */
export const CREDENTIAL_REF_ERROR_CODES = Object.freeze([
  'CREDENTIAL_REF_NOT_FOUND',
  'CREDENTIAL_REF_STORE_UNAVAILABLE',
  'CREDENTIAL_REF_RESOLVE_FAILED',
]);

/**
 * 把档案里的变量分成「普通值」与「引用」。
 *
 * @param {object} variables the profile's variables
 * @returns {{plain:object, refs:Array<{name:string,id:string}>}}
 */
export function splitCredentialRefs(variables) {
  const plain = {};
  const refs = [];
  for (const [name, value] of Object.entries(variables ?? {})) {
    const ref = parseCredentialRef(value);
    if (ref) refs.push({ name, id: ref.id });
    else plain[name] = value;
  }
  return { plain, refs };
}

/**
 * 把档案里的引用解析成密钥。
 *
 * 解析出来的密钥只出现在返回值里；调用方把它放进子进程的环境块，仅此
 * 一处。任何一条引用解析不出来，**整次解析失败**——不做「部分解析」，
 * 因为半套凭据的运行比不运行的运行更难解释。
 *
 * @param {object} variables the profile's variables (with references)
 * @param {object} options
 * @param {object} options.credentialStore the credential store
 * @param {string} [options.purpose] the purpose the reference is read for
 * @returns {Promise<{values:object, names:string[], referenced:string[]}>}
 *   `values` carries the RESOLVED values (plain ones and resolved ones);
 *   `names` are the variable names that reached the runner;
 *   `referenced` are the names that came from the credential store.
 * @throws {Error} with `.code` in `CREDENTIAL_REF_ERROR_CODES`
 */
export async function resolveCredentialRefs(variables, { credentialStore, purpose = 'other' } = {}) {
  const { plain, refs } = splitCredentialRefs(variables);
  if (!refs.length) {
    return {
      values: { ...plain },
      names: Object.keys(plain).sort(),
      referenced: [],
    };
  }
  if (!credentialStore || typeof credentialStore.resolve !== 'function') {
    const error = new Error('CREDENTIAL_REF_STORE_UNAVAILABLE');
    error.code = 'CREDENTIAL_REF_STORE_UNAVAILABLE';
    throw error;
  }
  const values = { ...plain };
  const referenced = [];
  for (const { name, id } of refs) {
    let secret;
    try {
      secret = await credentialStore.resolve(id, purpose);
    } catch (cause) {
      // The reference could not be resolved. The reason code says WHICH
      // kind of failure it was -- "no such entry" and "the store is
      // unreachable" call for different actions -- and the message names
      // the variable and the reference, never the secret.
      const code = cause?.code === 'CREDENTIAL_NOT_FOUND'
        ? 'CREDENTIAL_REF_NOT_FOUND'
        : cause?.code === 'CREDENTIAL_STORE_UNAVAILABLE'
          ? 'CREDENTIAL_REF_STORE_UNAVAILABLE'
          : 'CREDENTIAL_REF_RESOLVE_FAILED';
      const error = new Error(code);
      error.code = code;
      error.variable = name;
      error.credentialRef = id;
      throw error;
    }
    if (typeof secret !== 'string' || !secret.length) {
      // The store answered with nothing usable. That is a failure of the
      // READ, not a usable secret -- running with an empty token would be
      // a silent downgrade.
      const error = new Error('CREDENTIAL_REF_RESOLVE_FAILED');
      error.code = 'CREDENTIAL_REF_RESOLVE_FAILED';
      error.variable = name;
      error.credentialRef = id;
      throw error;
    }
    values[name] = secret;
    referenced.push(name);
  }
  return {
    values,
    names: Object.keys(values).sort(),
    referenced: referenced.sort(),
  };
}
