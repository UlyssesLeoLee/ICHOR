// ATS-402 review round 1 — in-process counterexample probe for the credential store.
// Usage: node r1-inproc.mjs <tree> <scratch>
//        ATS402_REAL_CREDENTIAL_STORE=1 node r1-inproc.mjs <tree> <scratch>   (adds I4, real Windows store)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tree = path.resolve(process.argv[2]);
const scratch = path.resolve(process.argv[3]);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const { createCredentialStore } = await import(pathToFileURL(path.join(tree, 'server/security/credentials.mjs')).href);
const { createEgressConsentStore } = await import(pathToFileURL(path.join(tree, 'server/security/egress-consent.mjs')).href);
const results = [];
// NONBLOCK lines are reported but do not count towards RESULT.
const report = (id, holds, detail, nonblock = false) => { results.push(holds && !nonblock); console.log(`${holds ? (nonblock ? 'NONBLOCK' : 'HOLDS') : 'OK   '} ${id} -- ${detail}`); };

// A backend that behaves like the real helper: the write takes a while (a
// PowerShell child process takes ~0.5 s), during which the HTTP server keeps
// serving other requests.
function slowBackend() {
  const vault = new Map();
  return {
    vault,
    name: 'slow-fake',
    available: async () => true,
    write: async (id, secret) => { await new Promise((r) => setTimeout(r, 50)); vault.set(id, secret); },
    read: async (id) => vault.get(id),
    remove: async (id) => { vault.delete(id); },
  };
}

// I1 lost update: two concurrent puts with different names.
{
  const backend = slowBackend();
  const store = createCredentialStore({ indexFile: path.join(scratch, 'i1.json'), backend });
  await Promise.all([store.put({ name: 'key-a', secret: 'sk-a' }), store.put({ name: 'key-b', secret: 'sk-b' })]);
  const listed = await store.list();
  report('I1 two concurrent puts: one reference lost, its secret orphaned in the OS store', listed.length !== 2, `index=${listed.length} vault=${backend.vault.size}`);
}
// I2 duplicate name check bypassed by concurrency.
{
  const backend = slowBackend();
  const store = createCredentialStore({ indexFile: path.join(scratch, 'i2.json'), backend });
  const r = await Promise.allSettled([store.put({ name: 'same', secret: 'sk-1' }), store.put({ name: 'same', secret: 'sk-2' })]);
  report('I2 two concurrent puts with the same name both succeed (CREDENTIAL_DUPLICATE bypassed)', r.every((x) => x.status === 'fulfilled'), r.map((x) => x.status).join(','));
}
// I3 a preview never expires and the previews map never shrinks without a confirm.
{
  let t = Date.now();
  const recs = [];
  const consent = createEgressConsentStore({ list: async () => recs, persist: async (r) => { recs.splice(0, recs.length, ...r); }, now: () => t });
  const inputs = [{ kind: 'file', ref: 'a', digest: 'a'.repeat(64), bytes: 1 }];
  for (let i = 0; i < 10000; i++) consent.preview(inputs);
  const p = consent.preview(inputs);
  t += 400 * 24 * 3600 * 1000;
  let ok = false; try { await consent.confirm({ previewId: p.previewId, inputs }); ok = true; } catch {}
  report('I3 unconfirmed previews accumulate without bound and a 400-day-old preview still confirms (non-blocking)', consent.pendingPreviews() >= 10000 && ok, `pending=${consent.pendingPreviews()} confirmAfter400d=${ok}`, true);
}
// I4 non-ASCII secret round trip through the real Windows helper.
if (process.env.ATS402_REAL_CREDENTIAL_STORE === '1') {
  const store = createCredentialStore({ indexFile: path.join(scratch, 'i4.json') });
  const secret = 'sk-r1-fake-密钥-ü-😀-end\n';
  const ref = await store.put({ name: 'r1-unicode', secret });
  let back;
  try { back = await store.resolve(ref.id); } finally { await store.remove(ref.id); }
  report('I4 non-ASCII secret does not round-trip through the Windows helper', back !== secret, `equal=${back === secret} len ${secret.length}/${back?.length}`);
}
console.log(`\nRESULT: ${results.filter(Boolean).length === 0 ? 'OK' : `${results.filter(Boolean).length} counterexample(s) hold`} (${results.length} checks)`);
