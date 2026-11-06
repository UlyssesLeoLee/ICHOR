/**
 * The deployable control-plane API, `/cp/v1` (ATS-506).
 *
 * This is the P2 control-plane surface of docs/19-REMOTE-RUNNER-PROTOCOL.md,
 * kept apart from the P1 desktop Bridge (`server/index.mjs`, `/api/*`):
 *
 *   - it imports NO local Bridge module, no Tauri API, no filesystem and no
 *     child_process (HB-1) -- tests/control-plane.test.mjs guards the imports;
 *   - it refuses the local Bridge credential and never serves `/api/*` (HB-7);
 *   - it refuses local paths, paths/repository addresses used instead of a
 *     UID, and the local session token shape on the way IN, and scans every
 *     response on the way OUT (HB-2/HB-3/HB-4);
 *   - the tenant comes from the session only, and another tenant's resource
 *     is indistinguishable from a missing one (docs/19 §5, ADR-018);
 *   - anything not explicitly allowed is REMOTE_POLICY_REJECTED (ADR-019).
 *
 * The ordered pipeline is docs/21-CONTROL-PLANE-API.md §4.
 */
import crypto from 'node:crypto';
import { LOCAL_CREDENTIAL_HEADERS, detectLocalPath, inspectValue, isLocalSessionTokenShape } from './boundary.mjs';
import { ControlPlaneError, errorBody } from './errors.mjs';

const PROJECT_UID = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUDIT_CAP = 1000;
const DISPLAY_NAME_MAX = 120;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PROJECT_FIELDS = new Set(['displayName', 'tenantId']);

/** What the control plane tells a client about its own boundary. */
const CONTRACT = Object.freeze({
  api: 'cp/v1',
  plane: 'control-plane',
  credential: { scheme: 'Bearer', header: 'Authorization', localCredentialAccepted: false },
  resourceReference: 'opaque_uid_only',
  tenantSource: 'server_assigned_from_session',
  forbiddenInRequests: ['local_absolute_path', 'path_traversal', 'path_field', 'repository_url', 'local_session_token', 'secret_value'],
  errorNamespace: 'REMOTE_',
  tauriRequired: false,
  localBridgeReachable: false,
});

const reject = (code, reason) => { throw new ControlPlaneError(code, reason); };

/** Split the RAW request target; `.`/`..` are never normalised away. */
function parseTarget(rawUrl) {
  const raw = typeof rawUrl === 'string' ? rawUrl : '';
  const q = raw.indexOf('?');
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const queryPart = q < 0 ? '' : raw.slice(q + 1);
  if (!pathPart.startsWith('/')) reject('REMOTE_POLICY_REJECTED', 'non_origin_form_target');
  const segments = [];
  for (const rawSegment of pathPart.slice(1).split('/')) {
    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      reject('REMOTE_POLICY_REJECTED', 'malformed_encoding');
    }
    if (segment === '.' || segment === '..') reject('REMOTE_PATH_FORBIDDEN', 'path_traversal');
    if (/[\\/]/.test(segment)) reject('REMOTE_PATH_FORBIDDEN', 'encoded_separator');
    const kind = detectLocalPath(segment);
    if (kind) reject('REMOTE_PATH_FORBIDDEN', kind);
    if (isLocalSessionTokenShape(segment)) reject('REMOTE_SECRET_INLINE_FORBIDDEN', 'local_session_token_shape');
    segments.push(segment);
  }
  const query = new URLSearchParams(queryPart);
  for (const [name, value] of query) {
    const found = inspectValue({ [name]: value });
    if (found) reject(found.code, found.kind);
  }
  return { segments, query };
}

/** Map the decoded segments to a route; null when no route has this shape. */
function route(segments) {
  if (segments[0] !== 'cp' || segments[1] !== 'v1') return null;
  const rest = segments.slice(2);
  if (rest.length === 1 && rest[0] === 'health') return { name: 'health', methods: ['GET'], auth: false };
  if (rest.length === 1 && rest[0] === 'contract') return { name: 'contract', methods: ['GET'], auth: true };
  if (rest.length === 1 && rest[0] === 'projects') return { name: 'projects', methods: ['GET', 'POST'], auth: true };
  if (rest.length === 2 && rest[0] === 'projects') return { name: 'project', methods: ['GET'], auth: true, uid: rest[1] };
  return null;
}

async function readJsonBody(req, maxBodyBytes) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') reject('REMOTE_POLICY_REJECTED', 'unsupported_content_type');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Keep draining an oversized body so the client receives the 413 instead
    // of a reset connection; a body far beyond the limit is cut off.
    if (size > maxBodyBytes * 16) {
      req.destroy();
      break;
    }
    if (size <= maxBodyBytes) chunks.push(chunk);
  }
  if (size > maxBodyBytes) reject('REMOTE_PAYLOAD_TOO_LARGE', 'body_limit');
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    reject('REMOTE_POLICY_REJECTED', 'invalid_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject('REMOTE_POLICY_REJECTED', 'body_not_object');
  return body;
}

function validDisplayName(value) {
  return typeof value === 'string' && value.length >= 1 && [...value].length <= DISPLAY_NAME_MAX && !CONTROL_CHARS.test(value);
}

/**
 * Create the control-plane handler.
 *
 * `authenticate(req)` returns `{ok:true, subject, tenantId}` or
 * `{ok:false, reason}`; the reason is audit-only. `store` and `audit` are
 * returned for tests and for the later persistence work; neither ever holds a
 * local path.
 */
export function createControlPlane({
  authenticate,
  authMode = 'none',
  now = () => new Date().toISOString(),
  newProjectUid = () => `prj_${crypto.randomUUID()}`,
  maxBodyBytes = 65536,
} = {}) {
  if (typeof authenticate !== 'function') throw new TypeError('authenticate must be a function');
  const store = new Map();
  const audit = [];

  function record(event) {
    audit.push({ at: now(), ...event });
    if (audit.length > AUDIT_CAP) audit.splice(0, audit.length - AUDIT_CAP);
  }

  function writeJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }

  /** Egress guard: a response that would carry a local path or token shape is never sent. */
  function send(res, status, body, context) {
    const leak = inspectValue(body, { fieldNames: false });
    if (leak) {
      record({ ...context, code: 'REMOTE_INTERNAL', reason: 'egress_boundary_blocked' });
      writeJson(res, 500, errorBody('REMOTE_INTERNAL'));
      return;
    }
    writeJson(res, status, body);
  }

  function tenantProjects(tenantId) {
    if (!store.has(tenantId)) store.set(tenantId, new Map());
    return store.get(tenantId);
  }

  async function handle(req, res, context) {
    const { segments, query } = parseTarget(req.url);
    for (const header of LOCAL_CREDENTIAL_HEADERS) {
      if (req.headers[header] !== undefined) reject('REMOTE_UNAUTHENTICATED', 'local_credential_presented');
    }
    if (req.headers.origin !== undefined) reject('REMOTE_POLICY_REJECTED', 'origin_not_supported');
    const r = route(segments);
    if (!r) reject('REMOTE_POLICY_REJECTED', 'unknown_route');
    if (!r.methods.includes(req.method)) reject('REMOTE_POLICY_REJECTED', 'method_not_allowed');
    context.action = `${req.method} ${r.name}`;

    if (r.name === 'health') return send(res, 200, { ok: true, plane: 'control-plane', api: 'cp/v1', auth: authMode }, context);

    const session = authenticate(req);
    if (!session || session.ok !== true) reject('REMOTE_UNAUTHENTICATED', (session && session.reason) || 'unauthenticated');
    const tenantId = session.tenantId;
    if (typeof tenantId !== 'string' || tenantId === '') reject('REMOTE_TENANT_REQUIRED', 'session_without_tenant');
    context.tenantId = tenantId;
    const hinted = [req.headers['x-ats-tenant'], query.get('tenantId')];
    for (const hint of hinted) if (hint !== undefined && hint !== null && hint !== tenantId) reject('REMOTE_TENANT_MISMATCH', 'client_tenant_differs');

    if (r.name === 'contract') return send(res, 200, CONTRACT, context);

    if (r.name === 'projects' && req.method === 'GET') {
      return send(res, 200, { projects: [...tenantProjects(tenantId).values()] }, context);
    }

    if (r.name === 'projects') {
      const body = await readJsonBody(req, maxBodyBytes);
      const found = inspectValue(body);
      if (found) reject(found.code, found.kind);
      if (body.tenantId !== undefined && body.tenantId !== tenantId) reject('REMOTE_TENANT_MISMATCH', 'client_tenant_differs');
      if (Object.keys(body).some((k) => !PROJECT_FIELDS.has(k))) reject('REMOTE_POLICY_REJECTED', 'unknown_field');
      if (!validDisplayName(body.displayName)) reject('REMOTE_POLICY_REJECTED', 'invalid_display_name');
      const project = { projectUid: newProjectUid(), displayName: body.displayName, createdAt: now() };
      tenantProjects(tenantId).set(project.projectUid, project);
      return send(res, 201, { project }, context);
    }

    // r.name === 'project': unknown, malformed and foreign UIDs look the same.
    const project = PROJECT_UID.test(r.uid) ? tenantProjects(tenantId).get(r.uid) : undefined;
    if (!project) reject('REMOTE_RESOURCE_NOT_FOUND', 'project_not_visible');
    return send(res, 200, { project }, context);
  }

  async function handler(req, res) {
    const context = { tenantId: null, action: 'unrouted' };
    try {
      await handle(req, res, context);
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        record({ ...context, code: e.code, reason: e.reason });
        writeJson(res, e.http, errorBody(e.code));
        return;
      }
      // Never echo an unexpected exception: its message may hold anything.
      record({ ...context, code: 'REMOTE_INTERNAL', reason: 'unexpected_exception' });
      writeJson(res, 500, errorBody('REMOTE_INTERNAL'));
    }
  }

  return { handler, store, audit };
}
