// Build the web image first, then: OPENGYM_WEB_IMAGE=opengym-web:test node --test web/test/nginx.test.mjs
// CONTAINER_ENGINE=podman also works. Exercises the actual entrypoint, DNS, TLS and nginx routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = process.env.CONTAINER_ENGINE || 'docker';
const image = process.env.OPENGYM_WEB_IMAGE || 'opengym-web:test';
const network = `opengym-web-test-${process.pid}`;
const containers = [];
let dir, local, railway, prefixed;
const run = (...args) => execFileSync(engine, args, { encoding: 'utf8', timeout: 60000 }).trim();
const mountPath = value => value.replaceAll('\\', '/');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startWeb(label, variables = {}, mounts = []) {
  const name = `${network}-${label}`;
  containers.push(name);
  run('run', '-d', '--name', name, '--network', network, '-p', '127.0.0.1::3000',
    '-e', 'NGINX_PORT=3000', '-e', 'PORT=3000', '-e', 'BACKEND=upstream', '-e', 'RESOLVER=auto',
    ...Object.entries(variables).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...mounts.flatMap(([from, to]) => ['-v', `${mountPath(from)}:${to}:ro`]), image);
  const binding = run('port', name, '3000/tcp').match(/:(\d+)\s*$/);
  if (!binding) throw new Error(`no published nginx port:\n${run('logs', name)}`);
  const port = binding[1];
  const base = `http://127.0.0.1:${port}${variables.BASE_PATH || ''}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return { name, base }; } catch {}
    await pause(200);
  }
  throw new Error(`nginx did not become ready:\n${run('logs', name)}`);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-web-'));
  fs.mkdirSync(path.join(dir, 'img'));
  fs.writeFileSync(path.join(dir, 'img/test.jpg'), 'local image');
  fs.copyFileSync(fileURLToPath(new URL('./upstream.mjs', import.meta.url)), path.join(dir, 'upstream.mjs'));
  // A short-lived local test CA. nginx must verify it and send the CDN hostname as SNI.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', '/CN=cdn', '-addext', 'subjectAltName=DNS:cdn'], { stdio: 'pipe' });
  run('network', 'create', network);
  const upstream = `${network}-upstream`;
  containers.push(upstream);
  run('run', '-d', '--name', upstream, '--network', network, '--network-alias', 'upstream',
    '--network-alias', 'cdn', '-v', `${mountPath(dir)}:/fixtures:ro`,
    'node:22-alpine', 'node', '/fixtures/upstream.mjs');
  local = await startWeb('local', {}, [[path.join(dir, 'img'), '/usr/share/nginx/html/img']]);
  const settings = { RESOLVER_IPV6: 'on', TRUST_RAILWAY_PROXY: '1', MEDIA_CDN_BASE: 'https://cdn:3443/dataset/' };
  const ca = [[path.join(dir, 'cert.pem'), '/etc/ssl/certs/ca-certificates.crt']];
  railway = await startWeb('railway', settings, ca);
  prefixed = await startWeb('prefixed', { ...settings, BASE_PATH: '/g+ym' }, ca);
});

after(() => {
  for (const name of containers.reverse()) spawnSync(engine, ['rm', '-f', name], { stdio: 'pipe' });
  spawnSync(engine, ['network', 'rm', network], { stdio: 'pipe' });
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('the unchanged Docker defaults render valid nginx with local media', () => {
  run('run', '--rm', image, 'nginx', '-t');
  assert.equal(run('exec', local.name, 'cat', '/etc/nginx/conf.d/media-cdn.locations'), '');
  const conf = run('exec', local.name, 'cat', '/etc/nginx/conf.d/default.conf');
  assert.match(conf, /ipv6=off;/);
  assert.match(conf, /map "0:/);
});

test('both Railway settings and a literal subpath render valid nginx', () => {
  for (const web of [railway, prefixed]) {
    run('exec', web.name, 'nginx', '-t');
    const conf = run('exec', web.name, 'cat', '/etc/nginx/conf.d/default.conf');
    assert.match(conf, /resolver (?!auto)[^;]+ipv6=on;/);
    assert.match(conf, /map "1:/);
  }
});

test('the public shell, PWA files and API routes are reachable', async () => {
  for (const resource of ['/', '/manifest.json', '/sw.js', '/api/config', '/api/health']) {
    const res = await fetch(railway.base + resource);
    assert.equal(res.status, 200, resource);
  }
  const html = await (await fetch(railway.base + '/')).text();
  const asset = html.match(/src="\.\/([^" ]+\.js)"/)[1];
  assert.equal((await fetch(railway.base + '/' + asset)).status, 200);
  const res = await fetch(prefixed.base + '/api/test.json?x=1');
  assert.equal((await res.json()).path, '/api/test.json?x=1');
});

test('local media still uses the existing immutable cache policy', async () => {
  const res = await fetch(local.base + '/img/test.jpg');
  assert.equal(await res.text(), 'local image');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000, immutable');
});

test('CDN images and GIFs keep same-origin URLs, exact paths, TLS host and security headers', async () => {
  for (const web of [railway, prefixed]) {
    for (const [folder, upstream, type] of [['img', 'images', 'image/jpeg'], ['gif', 'videos', 'image/gif']]) {
      const file = folder === 'img' ? 'test.jpg' : 'test.gif';
      const res = await fetch(`${web.base}/${folder}/${file}?v=1`, {
        headers: { Cookie: 'gymsid=private', Authorization: 'Bearer private', 'X-Real-IP': '203.0.113.17' }
      });
      if (res.status !== 200) throw new Error(`CDN returned ${res.status}:\n${run('logs', web.name)}`);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('x-upstream-path'), `/dataset/${upstream}/${file}?v=1`);
      assert.equal(res.headers.get('x-upstream-host'), 'cdn:3443');
      assert.equal(res.headers.get('x-upstream-sni'), 'cdn');
      assert.equal(res.headers.get('x-upstream-cookie'), '');
      assert.equal(res.headers.get('x-upstream-authorization'), '');
      assert.equal(res.headers.get('x-upstream-real-ip'), '');
      assert.equal(res.headers.get('set-cookie'), null);
      assert.equal(res.headers.get('expires'), null);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000, immutable');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'same-origin');
      assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
    }
  }
  assert.equal((await fetch(railway.base + '/img/missing.jpg')).status, 404);
});

test('untrusted TLS certificates are refused rather than serving CDN media', async () => {
  const untrusted = await startWeb('untrusted', { MEDIA_CDN_BASE: 'https://cdn:3443/dataset' });
  assert.equal((await fetch(untrusted.base + '/img/test.jpg')).status, 502);
});

test('only the Railway opt-in trusts edge IP and scheme; forwarding chains are replaced', async () => {
  const headers = { 'X-Real-IP': '203.0.113.17', 'X-Forwarded-For': '192.0.2.1', 'X-Forwarded-Proto': 'https',
    'CF-Connecting-IP': '192.0.2.2', Cookie: 'gymsid=keep-for-api' };
  for (const endpoint of ['/api/health', '/api/media/check']) {
    const direct = await (await fetch(local.base + endpoint, { headers })).json();
    assert.notEqual(direct.headers['x-real-ip'], headers['X-Real-IP']);
    assert.equal(direct.headers['x-real-ip'], direct.headers['x-forwarded-for']);
    assert.equal(direct.headers['x-forwarded-proto'], 'http');
    const trusted = await (await fetch(railway.base + endpoint, { headers })).json();
    assert.equal(trusted.headers['x-real-ip'], headers['X-Real-IP']);
    assert.equal(trusted.headers['x-forwarded-for'], headers['X-Real-IP']);
    assert.equal(trusted.headers['x-forwarded-proto'], 'https');
    assert.equal(trusted.headers['cf-connecting-ip'], undefined);
    assert.equal(trusted.headers.cookie, headers.Cookie);
    const fallback = await (await fetch(railway.base + endpoint)).json();
    assert.ok(fallback.headers['x-real-ip']);
    assert.equal(fallback.headers['x-forwarded-proto'], 'http');
  }
});

test('custom uploads retain their larger body limit and API destination', async () => {
  const body = 'x'.repeat(6 * 1024 * 1024);
  const upload = await fetch(railway.base + '/api/media/large?x=1', { method: 'PUT', body });
  assert.equal(upload.status, 200);
  const echo = await upload.json();
  assert.equal(echo.path, '/api/media/large?x=1');
  assert.equal(echo.bytes, body.length);
  assert.equal((await fetch(railway.base + '/api/data', { method: 'PUT', body })).status, 413);
});

test('automatic DNS brackets IPv6 nameservers and retains IPv4 ones', () => {
  const resolv = path.join(dir, 'resolv.conf');
  fs.writeFileSync(resolv, 'nameserver 192.0.2.53\nnameserver fd12::10\n');
  const conf = run('run', '--rm', '-e', 'RESOLVER=auto', '-e', 'RESOLVER_IPV6=on',
    '-v', `${mountPath(resolv)}:/etc/resolv.conf:ro`, image, 'nginx', '-T');
  assert.match(conf, /resolver 192\.0\.2\.53 \[fd12::10\]\s+valid=10s ipv6=on;/);
});

test('invalid runtime settings fail startup with an actionable message', () => {
  for (const [key, value, message] of [
    ['RESOLVER_IPV6', 'maybe', 'RESOLVER_IPV6 must be on or off'],
    ['TRUST_RAILWAY_PROXY', 'yes', 'TRUST_RAILWAY_PROXY must be 0 or 1'],
    ['MEDIA_CDN_BASE', 'http://cdn/dataset', 'MEDIA_CDN_BASE must be an HTTPS'],
    ['MEDIA_CDN_BASE', 'https://user:password@cdn/dataset', 'MEDIA_CDN_BASE must be an HTTPS'],
    ['MEDIA_CDN_BASE', 'https://cdn/dataset?x=1', 'MEDIA_CDN_BASE must be an HTTPS'],
    ['MEDIA_CDN_BASE', 'https://cdn/dataset;bad', 'MEDIA_CDN_BASE must be an HTTPS']
  ]) {
    const r = spawnSync(engine, ['run', '--rm', '-e', `${key}=${value}`, image, 'nginx', '-t'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, `${key}=${value}`);
    assert.ok((r.stdout + r.stderr).includes(message), `${key}: ${r.stdout}\n${r.stderr}`);
  }
});
