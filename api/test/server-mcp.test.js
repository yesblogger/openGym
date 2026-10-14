import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { request } from 'node:http';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
async function start(t, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-api-'));
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'secret'), secret);
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'a', name: 'Alice', admin: true }, { id: 'b', name: 'Bob' }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR: dir, PORT: '0', ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', MCP_ENABLED: enabled ? '1' : '0' } });
  let log = '';
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => log);
  const cookie = uid => {
    const payload = `${uid}:${Date.now() + 86400000}:0`;
    return { Cookie: `gymsid=${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}` };
  };
  const call = async (route, headers = {}, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  return { dir, cookie, call, url: `http://127.0.0.1:${port}` };
}
test('MCP HTTP access stays profile-scoped and shares conditional sync with browsers', async t => {
  const h = await start(t);
  assert.equal((await h.call('/api/config')).body.mcp_enabled, true);
  assert.equal((await h.call('/api/account/mcp-tokens')).status, 401);
  assert.equal((await h.call('/api/account/mcp-tokens', { ...h.cookie('a'), Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, 'POST', { name: 'bad', access: 'write' })).status, 403);
  const create = async access => (await h.call('/api/account/mcp-tokens', h.cookie('a'), 'POST', { name: 'Codex', access })).body;
  const write = await create('write'), read = await create('read');
  const bearer = { Authorization: 'Bearer ' + write.token };
  assert.deepEqual((await h.call('/api/account/mcp-tokens', h.cookie('b'))).body.tokens, []);
  assert.equal((await h.call('/api/account/mcp-tokens?id=' + write.id, h.cookie('b'), 'DELETE')).status, 404);
  for (const route of ['/api/me', '/api/admin/users', '/api/data', '/api/account/mcp-tokens']) assert.equal((await h.call(route, bearer)).status, 401);
  let snapshot = await h.call('/api/mcp/data?uid=b', bearer);
  assert.equal(snapshot.body.user.id, 'a');
  assert.equal(snapshot.body.state, null);
  const state = { unit: 'kg', workouts: [], routines: [], bodyweight: [], week: {}, dayPlan: {} };
  assert.equal((await h.call('/api/mcp/data', { Authorization: 'Bearer ' + read.token }, 'PUT', { state, baseRev: 0, baseWid: null })).status, 403);
  assert.equal((await h.call('/api/mcp/data', bearer, 'PUT', { state })).status, 400);
  const put = await h.call('/api/mcp/data', bearer, 'PUT', { state, baseRev: 0, baseWid: null });
  assert.equal(put.status, 200);
  assert.equal((await h.call('/api/mcp/data', bearer, 'PUT', { state, baseRev: 1, baseWid: null })).status, 409);
  snapshot = await h.call('/api/data', h.cookie('a'));
  const webState = { ...snapshot.body.state, targetW: 80 };
  assert.equal((await h.call('/api/data', h.cookie('a'), 'PUT', { state: webState, baseRev: 1, baseWid: put.body.wid })).status, 200);
  assert.equal((await h.call('/api/mcp/data', bearer, 'PUT', { state, baseRev: 1, baseWid: put.body.wid })).status, 409);
  assert.equal((await h.call('/api/mcp/data', bearer)).body.state.targetW, 80);
  for (const corrupt of ['{broken', 'null', '[]', '42']) {
    fs.writeFileSync(path.join(h.dir, 'state-a.json'), corrupt);
    assert.equal((await h.call('/api/mcp/data', bearer)).status, 503);
    assert.equal((await h.call('/api/mcp/data', bearer, 'PUT', { state, baseRev: 2, baseWid: put.body.wid })).status, 503);
    assert.equal(fs.readFileSync(path.join(h.dir, 'state-a.json'), 'utf8'), corrupt);
  }
  assert.equal((await h.call('/api/account/mcp-tokens?id=' + write.id, h.cookie('a'), 'DELETE')).status, 200);
  assert.equal((await h.call('/api/mcp/data', bearer)).status, 401);
  assert.equal((await h.call('/api/logout/all', h.cookie('a'), 'POST', {})).status, 200);
  assert.equal((await h.call('/api/mcp/data', { Authorization: 'Bearer ' + read.token })).status, 401);
});
test('MCP is absent unless enabled', async t => {
  const h = await start(t, false);
  assert.equal((await h.call('/api/config')).body.mcp_enabled, undefined);
  for (const route of ['/api/mcp/data', '/api/account/mcp-tokens']) assert.equal((await h.call(route, h.cookie('a'))).status, 404);
});

test('logout-all and token revocation also stop requests whose bodies are still streaming', async t => {
  const h = await start(t);
  const pending = (route, headers, method, prefix) => {
    let req;
    const done = new Promise((resolve, reject) => {
      req = request(h.url + route, { method, headers: { ...headers, 'Content-Type': 'application/json' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.write(prefix);
    });
    t.after(() => req.destroy());
    return { req, done };
  };
  const creation = pending('/api/account/mcp-tokens', h.cookie('a'), 'POST', '{"name":');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await h.call('/api/logout/all', h.cookie('a'), 'POST', {})).status, 200);
  creation.req.end('"Late token","access":"write"}');
  assert.equal(await creation.done, 401);
  assert.equal(fs.existsSync(path.join(h.dir, 'tokens.json')), false);

  const token = (await h.call('/api/account/mcp-tokens', h.cookie('b'), 'POST', { name: 'Revoked', access: 'write' })).body;
  const write = pending('/api/mcp/data', { Authorization: 'Bearer ' + token.token }, 'PUT', '{"baseRev":0,"baseWid":null,"state":');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await h.call('/api/account/mcp-tokens?id=' + token.id, h.cookie('b'), 'DELETE')).status, 200);
  write.req.end('{"unit":"kg","workouts":[]}}');
  assert.equal(await write.done, 401);
  assert.equal(fs.existsSync(path.join(h.dir, 'state-b.json')), false);
});
