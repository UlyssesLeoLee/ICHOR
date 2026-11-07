/**
 * ATS-402 ｜ 凭据存储（Credential store）
 *
 * 本模块实现 FR-027 的第一条完成定义：**「密钥使用系统凭据库」**。
 *
 * 三条硬规则（每条都有可机读校验，见 tools/ats402-probes/）：
 *
 *   1. **秘密值永不落盘。** 密钥本体只存在于**系统凭据库**里
 *      （Windows: Credential Manager）。落盘的只有一份**引用**：
 *      `{ id, name, provider, target, createdAt, updatedAt, fingerprint }`。
 *      `fingerprint` 是 SHA-256 的**前 8 个十六进制字符**——它用来让用户在
 *      界面上确认「这是同一个密钥」，而**不能**用来还原密钥。
 *   2. **秘密不进日志、不进错误消息、不进命令行。** 与凭据库交互的
 *      helper 进程通过 **stdin/stdout** 传递秘密，秘密不作为进程参数出现，
 *      因此不会出现在进程表里（tasklist / Procmon / WMI）。
 *   3. **凭据库不可用时**拒绝服务，而不是退回到「明文存文件」。
 *      没有系统凭据库就没有密钥存储能力——**不回退**是这条规则的全部意义。
 *
 * 平台差异：Windows 用 Credential Manager（`server/security/wincred.ps1`）；
 * macOS 用 Keychain（`server/security/mackeychain.sh`，走 `security`
 * 命令行工具）；Linux 用 Secret Service（`secret-tool`）。三者都只经由
 * 一个**受控的子进程接口**调用，Bridge 自己不直接碰这些 API。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CREDENTIAL_STORE_CONTRACT_VERSION = 'credential-store/v1';

/** 凭据的用途分类。用途决定它能不能被当作「可外传的输入」。 */
export const CREDENTIAL_PURPOSES = Object.freeze(['ai-provider', 'other']);

/** 凭据库的错误码。调用方按 `err.code` 分支，不解析消息文本。 */
export const CREDENTIAL_ERROR_CODES = Object.freeze([
  'CREDENTIAL_INVALID',
  'CREDENTIAL_NOT_FOUND',
  'CREDENTIAL_STORE_UNAVAILABLE',
  'CREDENTIAL_STORE_FAILED',
  'CREDENTIAL_DUPLICATE',
  'CREDENTIAL_NAME_INVALID',
]);

/** 凭据库文件（只存引用，不存秘密）的名字。 */
export const CREDENTIAL_INDEX_FILE = 'credentials.json';

/**
 * 凭据引用的形状。
 *
 * 注意这里**没有** `secret` 字段：引用里**不可能**有秘密。`fingerprint`
 * 是 SHA-256 的 8 个十六进制字符前缀，只用于让用户核对「是不是同一个
 * 密钥」，不足以还原密钥（密钥的熵远高于 32 bit）。
 */
export function describeCredentialReference(entry) {
  return {
    id: entry.id,
    name: entry.name,
    purpose: entry.purpose,
    provider: entry.provider,
    fingerprint: entry.fingerprint,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** 凭据 id 的形状：`cred_<24 hex>`。 */
const CREDENTIAL_ID = /^cred_[0-9a-f]{24}$/;

/** 凭据名的形状：1~64 字符，不含控制字符与路径分隔符。 */
const CREDENTIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * 凭据库的目标名前缀。系统凭据库里的条目按目标名索引，前缀保证本产品的
 * 条目不会和同机其它应用的条目撞名。
 */
export const CREDENTIAL_TARGET_PREFIX = 'ATS:ai-test-studio:';

/* ------------------------------------------------------------------ */
/* 平台后端                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每个平台后端都必须实现同一组操作：
 *
 *   backend()   -> 'windows' | 'macos' | 'linux' | null
 *   available() -> Promise<boolean>
 *   write()     -> Promise<void>   写秘密
 *   read()      -> Promise<string> 读秘密
 *   remove()    -> Promise<void>   删秘密
 *
 * 后端**只**通过子进程与系统凭据库交互，秘密走 stdin/stdout。
 */

/** Windows：Credential Manager（advapi32），经由一个 PowerShell helper。 */
function windowsBackend(scriptPath) {
  const target = (id) => `${CREDENTIAL_TARGET_PREFIX}${id}`;
  const call = (action, id, input) => new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        action, '-Target', target(id), '-User', 'ai-test-studio'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    // The helper never writes the secret to stderr, so stderr is safe to
    // surface as a diagnostic -- it carries the error CODE only.
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => reject(new Error(`CREDENTIAL_STORE_UNAVAILABLE:${error.code || error.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const codeMatch = /CREDENTIAL_[A-Z_]+/.exec(err);
      reject(new Error(codeMatch ? codeMatch[0] : 'CREDENTIAL_STORE_FAILED'));
    });
    if (input !== undefined) child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
  return {
    name: 'windows-credential-manager',
    available: async () => process.platform === 'win32' && fs.existsSync(scriptPath),
    write: async (id, secret) => { await call('write', id, secret); },
    read: async (id) => call('read', id),
    remove: async (id) => { await call('delete', id); },
  };
}

/** macOS：Keychain，经由 `security` 命令行工具。 */
function macosBackend() {
  const target = (id) => `${CREDENTIAL_TARGET_PREFIX}${id}`;
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = spawn('security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => reject(new Error(`CREDENTIAL_STORE_UNAVAILABLE:${error.code || error.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const codeMatch = /CREDENTIAL_[A-Z_]+/.exec(err);
      reject(new Error(codeMatch ? codeMatch[0] : 'CREDENTIAL_STORE_FAILED'));
    });
    if (input !== undefined) child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
  return {
    name: 'macos-keychain',
    available: async () => process.platform === 'darwin',
    write: async (id, secret) => {
      // `-w` takes the secret on the command line, which would expose it in
      // the process table. `security` reads a password from stdin when the
      // argument is omitted, so the secret is piped instead.
      await run(['add-generic-password', '-U', '-s', target(id), '-a', 'ai-test-studio', '-w'], secret);
    },
    read: async (id) => {
      const out = await run(['find-generic-password', '-s', target(id), '-a', 'ai-test-studio', '-w']);
      return out.replace(/\n$/, '');
    },
    remove: async (id) => { await run(['delete-generic-password', '-s', target(id), '-a', 'ai-test-studio']); },
  };
}

/** Linux：Secret Service，经由 `secret-tool`。 */
function linuxBackend() {
  const target = (id) => `${CREDENTIAL_TARGET_PREFIX}${id}`;
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => reject(new Error(`CREDENTIAL_STORE_UNAVAILABLE:${error.code || error.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const codeMatch = /CREDENTIAL_[A-Z_]+/.exec(err);
      reject(new Error(codeMatch ? codeMatch[0] : 'CREDENTIAL_STORE_FAILED'));
    });
    if (input !== undefined) child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
  return {
    name: 'linux-secret-service',
    available: async () => process.platform === 'linux' && hasBinary('secret-tool'),
    write: async (id, secret) => {
      await run(['store', '--label', 'AI Test Studio', 'service', 'ai-test-studio', 'account', id], secret);
    },
    read: async (id) => {
      const out = await run(['lookup', 'service', 'ai-test-studio', 'account', id]);
      return out.replace(/\n$/, '');
    },
    remove: async (id) => { await run(['clear', 'service', 'ai-test-studio', 'account', id]); },
  };
}

/** True when the named executable is on PATH. */
export function hasBinary(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(probe, [name], { encoding: 'utf8', timeout: 4000 });
    return result.status === 0 && Boolean((result.stdout || '').trim());
  } catch {
    return false;
  }
}

/**
 * 选出本机的凭据库后端。
 *
 * 找不到后端时返回 `null`——**不是**一个「明文文件」后端。没有系统凭据库
 * 就没有密钥存储能力，这是本模块拒绝回退的落点。
 *
 * `scriptPath` 是本模块旁边的 helper 脚本（Windows 用）。它按**模块自身
 * 的目录**解析，而不是数据目录——helper 是随源码走的，数据目录是用户
 * 状态，两者的生命周期不同。
 */
export function selectBackend(scriptPath) {
  if (process.platform === 'win32') return windowsBackend(scriptPath);
  if (process.platform === 'darwin') return macosBackend();
  if (process.platform === 'linux') return linuxBackend();
  return null;
}

/* ------------------------------------------------------------------ */
/* 凭据索引（只存引用）                                                */
/* ------------------------------------------------------------------ */

/**
 * 读取引用索引。
 *
 * 索引文件是 **JSON**，与 state.json 一样走 `tmp -> rename` 的原子写。
 * 索引损坏时**不**静默清空：清空会让用户以为密钥没了，实际是丢了引用。
 */
export function loadCredentialIndex(file) {
  if (!fs.existsSync(file)) return { version: CREDENTIAL_STORE_CONTRACT_VERSION, credentials: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const error = new Error('CREDENTIAL_STORE_FAILED');
    error.code = 'CREDENTIAL_STORE_FAILED';
    throw error;
  }
  if (!parsed || !Array.isArray(parsed.credentials)) {
    const error = new Error('CREDENTIAL_STORE_FAILED');
    error.code = 'CREDENTIAL_STORE_FAILED';
    throw error;
  }
  return parsed;
}

/** 原子写引用索引。 */
export function saveCredentialIndex(file, index) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 秘密的指纹：SHA-256 的前 8 个十六进制字符。 */
export function fingerprintOf(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* 凭据存储                                                            */
/* ------------------------------------------------------------------ */

/**
 * 创建一个凭据存储。
 *
 * @param {object} options
 * @param {string} options.indexFile  引用索引的文件路径
 * @param {object} [options.backend]  平台后端（测试注入用）
 */
export function createCredentialStore({ indexFile, backend } = {}) {
  if (typeof indexFile !== 'string' || !indexFile) {
    throw new TypeError('indexFile is required');
  }
  const resolvedBackend = backend || selectBackend(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'wincred.ps1'),
  );
  const now = () => new Date().toISOString();

  /** 后端的可用性。不可用时**拒绝**，绝不退回明文文件。 */
  async function requireBackend() {
    if (!resolvedBackend) {
      const error = new Error('CREDENTIAL_STORE_UNAVAILABLE');
      error.code = 'CREDENTIAL_STORE_UNAVAILABLE';
      throw error;
    }
    if (typeof resolvedBackend.available === 'function' && !(await resolvedBackend.available())) {
      const error = new Error('CREDENTIAL_STORE_UNAVAILABLE');
      error.code = 'CREDENTIAL_STORE_UNAVAILABLE';
      throw error;
    }
    return resolvedBackend;
  }

  /** 只读的凭据清单（引用，不含秘密）。 */
  async function list() {
    const index = loadCredentialIndex(indexFile);
    return index.credentials.map(describeCredentialReference);
  }

  /** 按 id 读取引用。找不到抛 CREDENTIAL_NOT_FOUND。 */
  async function describe(id) {
    const index = loadCredentialIndex(indexFile);
    const entry = index.credentials.find((c) => c.id === id);
    if (!entry) {
      const error = new Error('CREDENTIAL_NOT_FOUND');
      error.code = 'CREDENTIAL_NOT_FOUND';
      throw error;
    }
    return describeCredentialReference(entry);
  }

  /**
   * 存入一个密钥。
   *
   * 秘密写进**系统凭据库**，索引里只留引用。写入顺序是「先写凭据库，
   * 再写索引」：反过来会在两者之间留下一个「索引说有、凭据库里没有」的
   * 悬空引用。
   */
  async function put({ name, secret, purpose = 'ai-provider' } = {}) {
    if (typeof name !== 'string' || !CREDENTIAL_NAME.test(name.trim())) {
      const error = new Error('CREDENTIAL_NAME_INVALID');
      error.code = 'CREDENTIAL_NAME_INVALID';
      throw error;
    }
    if (typeof secret !== 'string' || !secret.length) {
      const error = new Error('CREDENTIAL_INVALID');
      error.code = 'CREDENTIAL_INVALID';
      throw error;
    }
    if (!CREDENTIAL_PURPOSES.includes(purpose)) {
      const error = new Error('CREDENTIAL_INVALID');
      error.code = 'CREDENTIAL_INVALID';
      throw error;
    }
    const store = await requireBackend();
    const index = loadCredentialIndex(indexFile);
    const duplicate = index.credentials.find((c) => c.name === name.trim());
    if (duplicate) {
      const error = new Error('CREDENTIAL_DUPLICATE');
      error.code = 'CREDENTIAL_DUPLICATE';
      throw error;
    }
    const id = `cred_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await store.write(id, secret);
    const entry = {
      id,
      name: name.trim(),
      purpose,
      provider: store.name,
      fingerprint: fingerprintOf(secret),
      createdAt: now(),
      updatedAt: now(),
    };
    index.credentials.push(entry);
    index.version = CREDENTIAL_STORE_CONTRACT_VERSION;
    saveCredentialIndex(indexFile, index);
    return describeCredentialReference(entry);
  }

  /**
   * 读取秘密本体。
   *
   * 这是**唯一**能取回秘密的入口，而且它需要**显式的用途声明**：
   * 调用方必须说清楚拿它做什么（`purpose`），因为「读取秘密」在 Agent
   * 契约层是**禁止能力**（`read_secret`）——平台侧替模型取密钥时，必须
   * 有一条可审计的理由。
   */
  async function resolve(id, purpose = 'ai-provider') {
    if (!CREDENTIAL_ID.test(String(id))) {
      const error = new Error('CREDENTIAL_NOT_FOUND');
      error.code = 'CREDENTIAL_NOT_FOUND';
      throw error;
    }
    const index = loadCredentialIndex(indexFile);
    const entry = index.credentials.find((c) => c.id === id);
    if (!entry) {
      const error = new Error('CREDENTIAL_NOT_FOUND');
      error.code = 'CREDENTIAL_NOT_FOUND';
      throw error;
    }
    if (entry.purpose !== purpose) {
      const error = new Error('CREDENTIAL_INVALID');
      error.code = 'CREDENTIAL_INVALID';
      throw error;
    }
    const store = await requireBackend();
    return store.read(id);
  }

  /**
   * 删除一个凭据。
   *
   * 先删凭据库里的条目，再删索引里的引用。反过来会在索引里留下一个指向
   * 已不存在条目的引用。
   */
  async function remove(id) {
    if (!CREDENTIAL_ID.test(String(id))) {
      const error = new Error('CREDENTIAL_NOT_FOUND');
      error.code = 'CREDENTIAL_NOT_FOUND';
      throw error;
    }
    const index = loadCredentialIndex(indexFile);
    const entry = index.credentials.find((c) => c.id === id);
    if (!entry) {
      const error = new Error('CREDENTIAL_NOT_FOUND');
      error.code = 'CREDENTIAL_NOT_FOUND';
      throw error;
    }
    const store = await requireBackend();
    await store.remove(id);
    index.credentials = index.credentials.filter((c) => c.id !== id);
    saveCredentialIndex(indexFile, index);
    return describeCredentialReference(entry);
  }

  return Object.freeze({
    contract: CREDENTIAL_STORE_CONTRACT_VERSION,
    list,
    describe,
    put,
    resolve,
    remove,
    /** 后端的可用性——界面上要显示「系统凭据库是否可用」。 */
    available: async () => {
      if (!resolvedBackend) return false;
      if (typeof resolvedBackend.available !== 'function') return true;
      return Boolean(await resolvedBackend.available());
    },
    /** 后端的名字（界面上要显示「密钥存在哪里」）。 */
    provider: () => (resolvedBackend ? resolvedBackend.name : null),
  });
}

/** 凭据索引的默认路径：数据目录下的一份独立文件。 */
export function credentialIndexPath(dataDir) {
  return path.join(dataDir, CREDENTIAL_INDEX_FILE);
}

/** 供诊断使用的后端信息（不含任何秘密）。 */
export function describeCredentialStore(store) {
  return {
    contract: CREDENTIAL_STORE_CONTRACT_VERSION,
    provider: store.provider(),
    purposes: [...CREDENTIAL_PURPOSES],
    errorCodes: [...CREDENTIAL_ERROR_CODES],
    note: 'Secrets live in the OS credential store. The index file holds references only; no secret is ever written to disk.',
  };
}
