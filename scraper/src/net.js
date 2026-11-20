import { lookup } from 'node:dns/promises';
import net from 'node:net';

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 HappeningsBot/1.0';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/** Refuse URLs that point at private/internal networks (users can submit any URL). */
export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Unsupported protocol: ${u.protocol}`);
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Non-standard ports are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error(`Refusing private address for ${host}`);
  }
}

export async function fetchText(url, { timeoutMs = 20000, accept = '*/*' } = {}) {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  return text.length > 5_000_000 ? text.slice(0, 5_000_000) : text;
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, { ...opts, accept: 'application/json' }));
}

/** Download a file (e.g. a PDF menu), up to maxBytes. Returns { buffer, contentType, url }. */
export async function fetchBuffer(url, { timeoutMs = 30000, maxBytes = 10_000_000 } = {}) {
  await assertPublicUrl(url);
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`File too large (${len} bytes)`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`File too large (${buffer.length} bytes)`);
  return { buffer, contentType: res.headers.get('content-type') || '', url: res.url };
}
