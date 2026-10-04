'use strict';

/**
 * WoodWing Elvis / Assets REST client — protocol only.
 *
 * Nothing in here touches Electron or the network directly: every request
 * goes through an injected `transport`, so this file can be exercised against
 * a mock server from plain Node (see scripts/test-elvis.mjs) as well as run
 * for real over Electron's `net` module (see elvisTransport.cjs).
 *
 * How Elvis authenticates, which is the part the first version got wrong:
 * there is no static API key. A client POSTs `username` + `password` to
 * `<base>/login` and gets back JSON with `loginSuccess`. Elvis 6 and WoodWing
 * Assets return an `authToken`, sent afterwards as `Authorization: Bearer`.
 * Elvis 5 returns a `csrfToken` instead and keeps the session in a cookie;
 * every later call then needs that cookie plus an `X-CSRF-TOKEN` header.
 * Both shapes are handled — the transport keeps cookies, this keeps tokens.
 *
 * Writes are form parameters, not a JSON body: `update` takes `id` and
 * `metadata` (a JSON-encoded string); `updatebulk` takes a query `q` in place
 * of `id`. A login also consumes one of the server's API licences, so the
 * session is cached and reused rather than logging in per request.
 */

const DEFAULT_TIMEOUT_NOTE = 'no response within 20 seconds';

/**
 * Normalise what someone typed into a base URL that ends at `/services`.
 * People reasonably paste the address they use in a browser
 * (`https://dam.company.com`), and every API path lives under `/services`.
 */
function resolveBase(endpoint) {
  const trimmed = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!trimmed) return { ok: false, error: 'No server address entered.' };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: `"${trimmed}" is not a valid web address.` };
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/services';
  return { ok: true, base: url.toString().replace(/\/+$/, '') };
}

const formBody = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Turn a low-level failure into something a person can act on. */
function explainNetworkError(message, url) {
  const m = String(message);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(m)) {
    return (
      `This Mac can't find a server called "${host}". Check the spelling. If this machine is ` +
      `air-gapped, the Elvis server has to be on that same isolated network — a WoodWing-hosted ` +
      `(cloud) server can't be reached from it at all.`
    );
  }
  if (/CONNECTION_REFUSED|ECONNREFUSED/i.test(m)) {
    return `"${host}" exists but refused the connection. The port may be wrong, or Elvis isn't running there.`;
  }
  if (/TIMED_OUT|ETIMEDOUT|ADDRESS_UNREACHABLE|NETWORK_UNREACHABLE|INTERNET_DISCONNECTED|timed out/i.test(m)) {
    return (
      `Nothing answered from "${host}" (${DEFAULT_TIMEOUT_NOTE}). This machine probably has no network ` +
      `route to it — a firewall, a VPN that isn't connected, or the air gap itself.`
    );
  }
  if (/CERT|certificate|SSL|self.signed|unable to verify/i.test(m)) {
    return (
      `The server's HTTPS certificate isn't trusted by this Mac. If your company issues its own ` +
      `certificates, install its root certificate in Keychain Access (System keychain, set to Always ` +
      `Trust) — the same fix Safari would need.`
    );
  }
  if (/PROXY|TUNNEL_CONNECTION_FAILED/i.test(m)) {
    return (
      `This Mac sends web traffic through a proxy, and the proxy couldn't reach "${host}". Either the ` +
      `name is wrong, or the server is internal and the proxy shouldn't be used for it — ask IT to add it ` +
      `to the proxy bypass list (System Preferences → Network → Advanced → Proxies).`
    );
  }
  return null;
}

function explainHttpStatus(status, stage) {
  if (status === 404) {
    return (
      'The server answered but has no Elvis API at that address. The address should normally end in ' +
      '"/services" — e.g. https://dam.company.com/services — and the search/update paths should be ' +
      '"/search" and "/update".'
    );
  }
  if (status === 401 || status === 403) {
    return stage === 'login'
      ? 'The server rejected the login. Check the username and password.'
      : 'The server rejected the request as not logged in, or this account lacks permission for it.';
  }
  if (status >= 500) return 'The Elvis server reported an internal error. Its administrator can see the cause in the server log.';
  return null;
}

/** An Elvis error envelope can arrive with HTTP 200, so the body is checked too. */
function bodyError(json) {
  if (json && typeof json === 'object' && json.errorcode) {
    return { status: Number(json.errorcode) || 0, message: json.message || `Elvis error ${json.errorcode}` };
  }
  return null;
}

function createElvisClient(transport) {
  /** Cached sessions, keyed by server + user, so each sync isn't a fresh login. */
  const sessions = new Map();

  const sessionKey = (base, config) => `${base}|${config.authMode}|${config.username || ''}`;

  function staticAuthHeaders(config) {
    if (config.authMode === 'apikey' && config.apiKey) return { Authorization: `Bearer ${config.apiKey}` };
    if (config.authMode === 'basic' && config.username) {
      const token = Buffer.from(`${config.username}:${config.password || ''}`).toString('base64');
      return { Authorization: `Basic ${token}` };
    }
    return {};
  }

  /** One HTTP exchange, with every failure turned into a uniform result. */
  async function exchange(stage, url, { method = 'POST', headers = {}, params } = {}) {
    let target = url;
    let body;
    const sendHeaders = { Accept: 'application/json', ...headers };
    if (params) {
      if (method === 'GET') {
        target = `${url}${url.includes('?') ? '&' : '?'}${formBody(params)}`;
      } else {
        body = formBody(params);
        sendHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      }
    }

    let response;
    try {
      response = await transport({ url: target, method, headers: sendHeaders, body });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      return { ok: false, stage, url, error: message, hint: explainNetworkError(message, url) };
    }

    const json = parseJson(response.bodyText);
    const inBody = bodyError(json);
    const status = inBody ? inBody.status : response.status;
    const ok = !inBody && response.status >= 200 && response.status < 300;
    if (!ok) {
      const snippet = inBody ? inBody.message : String(response.bodyText || '').slice(0, 300);
      return {
        ok: false,
        stage,
        url,
        status,
        error: `HTTP ${status}${snippet ? ` — ${snippet}` : ''}`,
        hint: explainHttpStatus(status, stage),
      };
    }
    if (json === undefined) {
      return {
        ok: false,
        stage,
        url,
        status,
        error: 'The server answered, but not with JSON — this address is probably a web page, not the Elvis API.',
        hint: explainHttpStatus(404, stage),
      };
    }
    return { ok: true, stage, url, status, body: json };
  }

  async function login(base, config) {
    if (!config.username) {
      return { ok: false, stage: 'login', error: 'Enter the Elvis username and password to log in.' };
    }
    const result = await exchange('login', `${base}/login`, {
      params: { username: config.username, password: config.password || '' },
    });
    if (!result.ok) return result;

    const body = result.body || {};
    if (body.loginSuccess === false) {
      return {
        ok: false,
        stage: 'login',
        url: result.url,
        error: body.loginFaultMessage || 'Login refused.',
        hint:
          'Elvis refused this login. Besides a wrong username or password, this happens when the server ' +
          'has no free API licences — an Elvis administrator can check that.',
      };
    }

    const headers = {};
    if (body.authToken) headers.Authorization = `Bearer ${body.authToken}`;
    if (body.csrfToken) headers['X-CSRF-TOKEN'] = body.csrfToken;
    return {
      ok: true,
      stage: 'login',
      url: result.url,
      headers,
      scheme: body.authToken ? 'auth token (Elvis 6 / Assets)' : body.csrfToken ? 'session cookie + CSRF token (Elvis 5)' : 'session cookie',
    };
  }

  async function authHeadersFor(base, config, { fresh = false } = {}) {
    if (config.authMode !== 'login') return { ok: true, headers: staticAuthHeaders(config) };
    const key = sessionKey(base, config);
    if (!fresh && sessions.has(key)) return { ok: true, headers: sessions.get(key), cached: true };
    const result = await login(base, config);
    if (!result.ok) return result;
    sessions.set(key, result.headers);
    return { ok: true, headers: result.headers, scheme: result.scheme };
  }

  /** Make an authenticated call, logging in again once if the session expired. */
  async function authed(stage, base, config, path, options) {
    const auth = await authHeadersFor(base, config);
    if (!auth.ok) return auth;
    let result = await exchange(stage, `${base}${path}`, { ...options, headers: auth.headers });
    if (!result.ok && result.status === 401 && config.authMode === 'login' && auth.cached) {
      const again = await authHeadersFor(base, config, { fresh: true });
      if (!again.ok) return again;
      result = await exchange(stage, `${base}${path}`, { ...options, headers: again.headers });
    }
    return result;
  }

  function normalizeHits(body) {
    const rawHits = Array.isArray(body) ? body : Array.isArray(body && body.hits) ? body.hits : [];
    return rawHits.map((hit) => {
      const metadata = hit.metadata || hit;
      return {
        id: String(hit.id ?? metadata.id ?? ''),
        name: metadata.name ?? metadata.filename ?? hit.name,
        thumbnailUrl: hit.thumbnailUrl ?? metadata.thumbnailUrl,
        metadata,
      };
    });
  }

  async function search(config, { num = 200 } = {}) {
    const resolved = resolveBase(config.endpoint);
    if (!resolved.ok) return { ok: false, stage: 'address', error: resolved.error };
    const method = config.searchMethod === 'GET' ? 'GET' : 'POST';
    const result = await authed('search', resolved.base, config, config.searchPath || '/search', {
      method,
      params: { q: config.query || '*', num, metadataToReturn: 'all' },
    });
    if (!result.ok) return result;
    const hits = normalizeHits(result.body);
    const totalHits = result.body && typeof result.body.totalHits === 'number' ? result.body.totalHits : hits.length;
    return { ok: true, url: result.url, status: result.status, hits, totalHits };
  }

  async function update(config, assetId, metadata) {
    const resolved = resolveBase(config.endpoint);
    if (!resolved.ok) return { ok: false, stage: 'address', error: resolved.error };
    const path = config.updatePath || '/update';
    const params = /updatebulk\/?$/.test(path)
      ? { q: `id:${assetId}`, metadata: JSON.stringify(metadata) }
      : { id: assetId, metadata: JSON.stringify(metadata) };
    const result = await authed('update', resolved.base, config, path, { method: 'POST', params });
    if (!result.ok) return result;
    return { ok: true, url: result.url, status: result.status };
  }

  /**
   * Walk the connection one step at a time and report each, so a failure
   * says *where* it broke — address, network, login, or search — instead of
   * one undifferentiated "couldn't connect".
   */
  async function test(config) {
    const steps = [];
    const resolved = resolveBase(config.endpoint);
    if (!resolved.ok) {
      steps.push({ ok: false, label: 'Server address', detail: resolved.error });
      return { ok: false, steps };
    }
    steps.push({ ok: true, label: 'Server address', detail: resolved.base });

    if (config.authMode === 'login') {
      const auth = await authHeadersFor(resolved.base, config, { fresh: true });
      if (!auth.ok) {
        steps.push({ ok: false, label: 'Log in', detail: auth.error, hint: auth.hint, url: auth.url });
        return { ok: false, steps };
      }
      steps.push({ ok: true, label: 'Log in', detail: `Logged in as ${config.username} — ${auth.scheme}` });
    } else {
      steps.push({ ok: true, label: 'Log in', detail: config.authMode === 'none' ? 'Skipped — no authentication selected' : `Using ${config.authMode} credentials` });
    }

    const found = await search(config, { num: 1 });
    if (!found.ok) {
      steps.push({ ok: false, label: 'Search', detail: found.error, hint: found.hint, url: found.url });
      return { ok: false, steps };
    }
    steps.push({
      ok: true,
      label: 'Search',
      detail: `Query "${config.query || '*'}" matches ${found.totalHits} asset${found.totalHits === 1 ? '' : 's'}`,
    });
    return { ok: true, steps, totalHits: found.totalHits };
  }

  function forget() {
    sessions.clear();
  }

  return { test, search, update, forget };
}

module.exports = { createElvisClient, resolveBase };
