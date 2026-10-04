'use strict';

/**
 * The real network transport for elvisClient.cjs: Electron's `net` module.
 *
 * `net` runs on Chromium's network stack rather than Node's, which matters
 * twice over for a DAM on a company network. It trusts the certificates in
 * the macOS Keychain — Node's `https` ships its own fixed CA list and rejects
 * a company-issued certificate even when Safari accepts it — and it honours
 * the system proxy settings, which Node ignores.
 *
 * Cookies live in a dedicated in-memory session (not the window's), which is
 * what carries an Elvis 5 login between calls. It is cleared when the app
 * quits, so no Elvis session lingers on disk.
 */

const { net, session } = require('electron');

const TIMEOUT_MS = 20_000;

let elvisSession = null;
function getSession() {
  if (!elvisSession) elvisSession = session.fromPartition('elvis');
  return elvisSession;
}

function electronTransport({ url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    let request;
    try {
      request = net.request({ url, method, session: getSession(), useSessionCookies: true, redirect: 'follow' });
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        /* already finished */
      }
      finish(reject, new Error('net::ERR_TIMED_OUT (request timed out)'));
    }, TIMEOUT_MS);

    for (const [name, value] of Object.entries(headers || {})) request.setHeader(name, value);

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        finish(resolve, {
          status: response.statusCode,
          contentType: [].concat(response.headers['content-type'] || [])[0] || '',
          body: Buffer.concat(chunks),
        }),
      );
      response.on('error', (error) => finish(reject, error));
    });
    request.on('error', (error) => finish(reject, error));

    if (body) request.write(body);
    request.end();
  });
}

module.exports = { electronTransport };
