/**
 * A Node stand-in for Electron's `net` transport (electron/elvisTransport.cjs),
 * with the cookie handling Chromium's session would provide — so the Elvis
 * client and the sync built on it can run against the mock server in tests.
 */
import http from 'node:http';

export function nodeTransport() {
  const jar = new Map();
  return ({ url, method, headers, body }) =>
    new Promise((resolve, reject) => {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const req = http.request(url, { method, headers: cookie ? { ...headers, Cookie: cookie } : headers }, (res) => {
        for (const line of [].concat(res.headers['set-cookie'] || [])) {
          const [pair] = line.split(';');
          const [k, v] = pair.split('=');
          jar.set(k.trim(), v);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks) }),
        );
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
}
