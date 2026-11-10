import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

// Deploy behind HTTPS in a region where Bybit permits this account's API access.
// BYBIT_API_SECRET never leaves Apps Script. Do not enable request-body logging.
const token = process.env.RELAY_TOKEN;
if (!token || token.length < 32) throw new Error('RELAY_TOKEN must contain at least 32 characters');
const allowed = new Set(['/v5/user/query-api', '/v5/position/closed-pnl']);
const headersAllowed = ['X-BAPI-API-KEY', 'X-BAPI-TIMESTAMP', 'X-BAPI-RECV-WINDOW', 'X-BAPI-SIGN'];
const equal = (a, b) => {
  const x = Buffer.from(a || ''), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const server = http.createServer(async (req, res) => {
  const reply = (code, obj) => {
    res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/health') return reply(200, {status: 'ready'});
  if (req.method !== 'POST' || req.url !== '/bybit') return reply(404, {error: 'Not found'});
  if (!equal(req.headers.authorization, 'Bearer ' + token)) return reply(401, {error: 'Unauthorized'});
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 8192) return reply(413, {error: 'Request too large'});
    }
    const input = JSON.parse(body);
    if (!allowed.has(input.path) || typeof input.query !== 'string') return reply(400, {error: 'Invalid path or query'});
    if (/[#\r\n]/.test(input.query)) return reply(400, {error: 'Invalid query'});
    const params = new URLSearchParams(input.query);
    const keys = new Set(['category', 'startTime', 'endTime', 'cursor', 'limit', 'symbol']);
    if ([...params.keys()].some(k => !keys.has(k))) return reply(400, {error: 'Unknown query parameter'});
    if (input.path === '/v5/user/query-api' && input.query !== '') return reply(400, {error: 'Query must be empty'});
    if (input.path === '/v5/position/closed-pnl' && !['linear', 'inverse'].includes(params.get('category'))) return reply(400, {error: 'Invalid category'});
    const headers = {};
    for (const name of headersAllowed) {
      const value = input.headers?.[name];
      if (typeof value !== 'string' || !value || value.length > 512 || /[\r\n]/.test(value)) return reply(400, {error: 'Invalid signing headers'});
      headers[name] = value;
    }
    if (Math.abs(Date.now() - Number(headers['X-BAPI-TIMESTAMP'])) > 30000 || !Number.isFinite(Number(headers['X-BAPI-TIMESTAMP']))) return reply(400, {error: 'Expired timestamp'});
    const upstream = await fetch('https://api.bybit.com' + input.path + (input.query ? '?' + input.query : ''), {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    const text = await upstream.text();
    // Propagate status but never write credentials, signed requests, or trade data to logs.
    res.writeHead(upstream.status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(text);
  } catch {
    reply(502, {error: 'Relay request failed'});
  }
});
server.requestTimeout = 25000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 8080), process.env.BIND_ADDRESS || '127.0.0.1');
