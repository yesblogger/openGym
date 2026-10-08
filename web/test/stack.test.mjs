// Real API + web images with a disposable /data volume. A seeded test session avoids requiring
// a hardware passkey in CI; the API's passkey suite checks the authentication ceremonies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const engine = process.env.CONTAINER_ENGINE || 'docker';
const webImage = process.env.OPENGYM_WEB_IMAGE || 'opengym-web:test';
const apiImage = process.env.OPENGYM_API_IMAGE || 'opengym-api:test';
const run = (...args) => execFileSync(engine, args, { encoding: 'utf8', timeout: 60000 }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('accounts, sessions, workouts and custom uploads survive API container replacement', async t => {
  const prefix = `opengym-stack-test-${process.pid}`;
  const network = prefix + '-network', volume = prefix + '-data';
  const api = prefix + '-api', web = prefix + '-web';
  t.after(() => {
    for (const name of [web, api]) spawnSync(engine, ['rm', '-f', name], { stdio: 'pipe' });
    spawnSync(engine, ['volume', 'rm', volume], { stdio: 'pipe' });
    spawnSync(engine, ['network', 'rm', network], { stdio: 'pipe' });
  });
  run('network', 'create', network);
  run('volume', 'create', volume);
  run('run', '--rm', '-v', `${volume}:/data`, apiImage, 'node', '--input-type=module', '-e', `
    import fs from 'node:fs'; import crypto from 'node:crypto';
    fs.writeFileSync('/data/secret', crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    fs.writeFileSync('/data/db.json', JSON.stringify({
      users: [{ id: 'railway-test', name: 'Railway test', created: new Date().toISOString() }],
      creds: [], subs: [], invites: []
    }), { mode: 0o600 });
  `);
  const startApi = () => run('run', '-d', '--name', api, '--network', network, '--network-alias', 'api',
    '-v', `${volume}:/data`, '-e', 'DATA_DIR=/data', '-e', 'PORT=3000', '-e', 'RP_ID=localhost',
    '-e', 'ORIGIN=http://localhost:3000', '-e', 'TRUST_PROXY=1', apiImage);
  startApi();
  run('run', '-d', '--name', web, '--network', network, '-p', '127.0.0.1::3000',
    '-e', 'NGINX_PORT=3000', '-e', 'PORT=3000', '-e', 'BACKEND=api', '-e', 'RESOLVER=auto',
    '-e', 'RESOLVER_IPV6=on', '-e', 'TRUST_RAILWAY_PROXY=1', webImage);
  const binding = run('port', web, '3000/tcp').match(/:(\d+)\s*$/);
  if (!binding) throw new Error(`no published nginx port:\n${run('logs', web)}`);
  const port = binding[1];
  const base = `http://127.0.0.1:${port}`;
  async function ready() {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
      await pause(200);
    }
    throw new Error(`stack did not become ready:\n${run('logs', api)}\n${run('logs', web)}`);
  }
  await ready();
  const session = run('exec', api, 'node', '--input-type=module', '-e', `
    import fs from 'node:fs'; import crypto from 'node:crypto';
    const payload = 'railway-test:' + (Date.now() + 86400000) + ':0';
    console.log(payload + '.' + crypto.createHmac('sha256', fs.readFileSync('/data/secret', 'utf8').trim()).update(payload).digest('base64url'));
  `);
  const headers = { Cookie: `gymsid=${session}`, Origin: 'http://localhost:3000' };
  assert.equal((await fetch(base + '/api/me', { headers })).status, 200);
  const state = { _ts: Date.now(), routines: [], workouts: [{ id: 'railway-workout', d: '2026-10-08' }] };
  const saved = await fetch(base + '/api/data', {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, baseRev: 0 })
  });
  assert.equal(saved.status, 200, await saved.text());
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const hash = createHash('sha256').update(gif).digest('hex');
  const uploaded = await fetch(base + '/api/media/' + hash, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'image/gif' }, body: gif
  });
  assert.equal(uploaded.status, 201, await uploaded.text());
  const pushKeys = run('exec', api, 'cat', '/data/vapid.json');

  // Stop, then remove and create a new API container, exactly where ephemeral data is lost
  // without the volume. nginx must reach its new address without a web restart as well.
  run('stop', api);
  run('rm', api);
  startApi();
  await ready();
  assert.equal((await fetch(base + '/api/me', { headers })).status, 200, 'the original session still works');
  const restored = await (await fetch(base + '/api/data', { headers })).json();
  assert.equal(restored.rev, 1);
  assert.deepEqual(restored.state.workouts, state.workouts);
  const media = await fetch(base + '/api/media/' + hash, { headers });
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), gif);
  assert.equal(run('exec', api, 'cat', '/data/vapid.json'), pushKeys);
});
