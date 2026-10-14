// Profile-scoped MCP credentials. Only hashes are persisted; ordinary sessions never accept them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './durable.js';

export const MCP_TOKEN_TTL = 90 * 86400000;
const digest = token => crypto.createHash('sha256').update(token).digest();
const metadata = ({ id, name, scopes, created, expires }) => ({ id, name, scopes, created, expires });

export function createMcpTokenStore(dir, now = Date.now) {
  const file = path.join(dir, 'tokens.json');
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.tokens) || data.tokens.some(t =>
        !t || typeof t.uid !== 'string' || typeof t.id !== 'string' || typeof t.name !== 'string' ||
        !/^[a-f0-9]{64}$/.test(t.hash) || !Number.isFinite(t.expires) || !Number.isFinite(t.created) ||
        !Number.isInteger(t.sv) || !Array.isArray(t.scopes) || !t.scopes.includes('read') ||
        t.scopes.some(s => s !== 'read' && s !== 'write'))) throw new Error('invalid token store');
      return data.tokens;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw Object.assign(new Error('MCP token store unreadable'), { status: 503 });
    }
  }
  const save = tokens => atomicWrite(file, JSON.stringify({ version: 1, tokens }), 0o600);
  const live = (t, user) => t.uid === user.id && t.expires > now() && t.sv === (user.sv || 0);
  return {
    list(user) { return read().filter(t => live(t, user)).map(metadata); },
    create(user, name, access) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || !['read', 'write'].includes(access)) {
        throw Object.assign(new Error('name and read/write access required'), { status: 400 });
      }
      const tokens = read().filter(t => t.expires > now());
      if (tokens.filter(t => live(t, user)).length >= 20) throw Object.assign(new Error('revoke a token before creating another'), { status: 400 });
      const id = crypto.randomBytes(12).toString('hex');
      const token = `ogmcp_${id}.${crypto.randomBytes(32).toString('base64url')}`;
      const record = { id, uid: user.id, name: name.trim(), scopes: access === 'write' ? ['read', 'write'] : ['read'],
        created: now(), expires: now() + MCP_TOKEN_TTL, sv: user.sv || 0, hash: digest(token).toString('hex') };
      save([...tokens, record]);
      return { ...metadata(record), token };
    },
    revoke(user, id) {
      const tokens = read();
      if (!tokens.some(t => t.uid === user.id && t.id === id)) return false;
      save(tokens.filter(t => !(t.uid === user.id && t.id === id)));
      return true;
    },
    authenticate(token, users) {
      const match = /^ogmcp_([a-f0-9]{24})\.[A-Za-z0-9_-]{43}$/.exec(token || '');
      if (!match) return null;
      const record = read().find(t => t.id === match[1]);
      if (!record || !crypto.timingSafeEqual(digest(token), Buffer.from(record.hash, 'hex'))) return null;
      const user = users.find(u => u.id === record.uid);
      if (!user || user.disabled || !live(record, user)) return null;
      return { user, scopes: record.scopes };
    }
  };
}
