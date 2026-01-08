
const DEFAULT_TIKTOK_ENDPOINTS = [];

const DEFAULT_SESSION_CACHE_TTL_SECONDS = 60;
const TEXT_CHUNK_LIMIT_BYTES = 300;

// Global state
const sessionCache = {
  ids: [],
  fetchedAt: 0,
  cursor: 0,
};

const bannedSessions = new Map();
const sessionFailures = new Map();
const deviceIdentityCache = new Map();

// Basic in-memory abuse controls (best-effort per colo)
const ipCounters = new Map();
const ipInFlight = new Map();

let cachedAuthToken = null;
let cachedAuthPassword = null;
const encoder = new TextEncoder();
let startupPrefetchPromise = null;
const SESSION_ID_RE = /^[a-f0-9]{32}$/i;
let sessionDbReady = false;

export default {
  async fetch(request, env, ctx) {
    if (!startupPrefetchPromise) {
      startupPrefetchPromise = (async () => {
        console.log('[Startup] prefetching sessions');
        await getSessionIds(env);
      })();
      if (ctx?.waitUntil) ctx.waitUntil(startupPrefetchPromise);
    }
    await startupPrefetchPromise;
    const url = new URL(request.url);
    console.log(`[Request] ${request.method} ${url.pathname}`);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/api/status') {
      const authResp = await requireApiAuth(request, env);
      if (authResp) {
        console.log('[Auth] /api/status unauthorized');
        return withCors(authResp, corsHeaders);
      }

      const limited = rateLimit(request, env, 'status');
      if (limited) return withCors(limited, corsHeaders);

      const sessions = await getSessionIds(env);
      console.log(`[Status] sessions=${sessions.length}`);
      const headers = new Headers(corsHeaders);
      headers.set('Cache-Control', 'no-store');
      return new Response(null, {
        status: sessions.length > 0 ? 200 : 503,
        headers
      });
    }

    if (url.pathname === '/api/generate' && request.method === 'POST') {
      const authResp = await requireApiAuth(request, env);
      if (authResp) {
        console.log('[Auth] /api/generate unauthorized');
        return withCors(authResp, corsHeaders);
      }

      const limited = rateLimit(request, env, 'generate');
      if (limited) return withCors(limited, corsHeaders);

      const inFlightLimited = limitConcurrency(request, env);
      if (inFlightLimited) return withCors(inFlightLimited, corsHeaders);

      try {
        const response = await handleGenerate(request, env);
        return withCors(response, corsHeaders);
      } catch (e) {
        console.log(`[Generate] unhandled error: ${e?.message || String(e)}`);
        return withCors(new Response(e?.message || 'Internal error', { status: 500 }), corsHeaders);
      } finally {
        releaseConcurrency(request);
      }
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    if (!useD1(env)) return;
    if (ctx?.waitUntil) ctx.waitUntil(refreshSessionsToDb(env));
    else await refreshSessionsToDb(env);
  }
};


async function handleGenerate(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    console.log('[Generate] invalid JSON');
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!payload.text || !payload.voice) {
    console.log('[Generate] missing text or voice');
    return new Response('Missing text or voice', { status: 400 });
  }

  const voice = String(payload.voice || '').trim();
  if (!/^[a-z0-9_]{2,64}$/i.test(voice)) {
    console.log('[Generate] invalid voice');
    return new Response('Invalid voice', { status: 400 });
  }

  const text = String(payload.text || '');
  const totalBytes = encoder.encode(text).length;
  if (totalBytes === 0) return new Response('Missing text', { status: 400 });
  if (totalBytes > 2000) return new Response('Text too long', { status: 413 });
  console.log(`[Generate] voice=${voice} bytes=${totalBytes}`);

  // Split text by byte size to avoid hammering TikTok with huge payloads
  const chunks = splitTextByBytes(text, TEXT_CHUNK_LIMIT_BYTES, 10);

  const sessionIds = await getSessionIds(env);
  if (sessionIds.length === 0) {
    console.log('[Generate] no sessions available');
    return new Response('No sessions available', { status: 503 });
  }

  // We use one session for all chunks to be consistent
  let sessionId = pickRandomSessionId(sessionIds);
  
  // Retry loop for the entire generation
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const results = [];
      for (const chunk of chunks) {
        const r = await requestChunk(chunk, voice, sessionId);
        if (!r.ok) throw new Error(r.message || 'Chunk request failed');
        results.push(r);
      }

      // Success!
      resetSessionFailures(sessionId);
      
      // Combine audio
      const totalLength = results.reduce((acc, r) => acc + r.data.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const r of results) {
        combined.set(r.data, offset);
        offset += r.data.length;
      }

      if (payload.base64) {
        return new Response(bytesToBase64(combined), {
          headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store'
          }
        });
      }

      return new Response(combined, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store'
        }
      });

    } catch (error) {
      console.log(`[Attempt ${attempt+1} Failed] Session: redacted Error: ${error?.message || String(error)}`);
      
      // Record failure
      recordSessionFailure(sessionId, env);
      
      // Pick a new session for next attempt
      const newSessionId = pickRandomSessionId(sessionIds);
      if (newSessionId === sessionId) {
        // If we only have one session, we might be stuck, but try again anyway
      }
      sessionId = newSessionId;
    }
  }

  return new Response('Failed to generate audio after 3 attempts', { status: 500 });
}

async function requestChunk(text, voice, sessionId) {
  if (!isValidSessionId(sessionId)) {
    return { ok: false, message: 'Invalid session ID format' };
  }
  const identity = getRandomIdentity();
  const endpoints = getTikTokEndpoints(env);
  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
  const url = `${endpoint}/media/api/text/speech/invoke/`;
  console.log(`[Chunk] endpoint=${endpoint} voice=${voice} bytes=${encoder.encode(text).length} session=redacted`);

  // Exact params from working python script
  const params = new URLSearchParams();
  params.append('text_speaker', voice);
  params.append('req_text', text);
  params.append('speaker_map_type', '0');
  params.append('aid', '1233');
  
  const headers = {
    'User-Agent': identity.userAgent,
    'Cookie': `sessionid=${sessionId}`,
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-common-params-v2': identity.commonParams
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: params.toString()
    });
    console.log(`[Chunk] status=${response.status}`);

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      return { ok: false, message: `JSON Parse Error: ${text.substring(0, 100)}` };
    }

    if (body.status_code === 0 && body.data && body.data.v_str) {
      return { 
        ok: true, 
        data: base64ToBytes(body.data.v_str) 
      };
    }

    // Log full debug info on API failure
    console.log(`[API Fail] code=${body.status_code} msg=${body.message || body.status_msg || 'unknown'}`);

    return {
      ok: false,
      message: body.message || body.status_msg || `Status ${body.status_code}`
    };

  } catch (e) {
    return { ok: false, message: `Network Error: ${e.message}` };
  }
}

// --- Helpers ---

function withCors(response, corsHeaders) {
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
}

function getTikTokEndpoints(env) {
  if (Array.isArray(env?.TIKTOK_ENDPOINTS) && env.TIKTOK_ENDPOINTS.length > 0) {
    return env.TIKTOK_ENDPOINTS;
  }
  if (typeof env?.TIKTOK_ENDPOINTS === 'string') {
    const parsed = env.TIKTOK_ENDPOINTS.split(',').map((s) => s.trim()).filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_TIKTOK_ENDPOINTS;
}

function normalizeInternalUrl(urlStr) {
  if (typeof urlStr !== 'string') throw new Error('Invalid URL');
  if (/[\r\n]/.test(urlStr)) throw new Error('Invalid URL');
  const url = new URL(urlStr);
  if (url.username || url.password) throw new Error('Invalid URL');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid URL');
  return url.toString();
}

async function requireApiAuth(request, env) {
  // Optional API key (strongly recommended if you expose /api/*)
  if (env.API_KEY) {
    const got = request.headers.get('Authorization') || '';
    if (got !== `Bearer ${env.API_KEY}`) return new Response('Unauthorized', { status: 401 });
  }

  // Public API by default; optionally require the site password for /api/*
  if (env.SITE_PASSWORD && env.REQUIRE_AUTH_FOR_API) {
    const authed = await isAuthenticated(request, env);
    if (!authed) return new Response('Unauthorized', { status: 401 });
  }

  return null;
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

function rateLimit(request, env, route) {
  const ip = getClientIp(request);
  if (ip === 'unknown') return new Response('Missing client IP', { status: 400 });

  const now = Date.now();
  const windowMs = 60_000;
  const max = route === 'generate' ? Number(env.RATE_LIMIT_GENERATE_PER_MIN || 10) : Number(env.RATE_LIMIT_STATUS_PER_MIN || 60);

  const key = `${route}:${ip}:${Math.floor(now / windowMs)}`;
  const entry = ipCounters.get(key) || { count: 0, resetAt: (Math.floor(now / windowMs) + 1) * windowMs };
  entry.count += 1;
  ipCounters.set(key, entry);

  // Light cleanup to avoid unbounded growth
  if (Math.random() < 0.01) {
    for (const [k, v] of ipCounters) {
      if (v.resetAt < now - 5 * windowMs) ipCounters.delete(k);
    }
  }

  if (entry.count > max) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return new Response('Rate limited', {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) }
    });
  }

  return null;
}

function limitConcurrency(request, env) {
  const ip = getClientIp(request);
  const max = Number(env.MAX_CONCURRENT_PER_IP || 2);
  const cur = ipInFlight.get(ip) || 0;
  if (cur >= max) return new Response('Too many concurrent requests', { status: 429, headers: { 'Retry-After': '5' } });
  ipInFlight.set(ip, cur + 1);
  return null;
}

function releaseConcurrency(request) {
  const ip = getClientIp(request);
  const cur = ipInFlight.get(ip) || 0;
  if (cur <= 1) ipInFlight.delete(ip);
  else ipInFlight.set(ip, cur - 1);
}

function getRandomIdentity() {
  // Device configurations that match real TikTok app signatures
  const devices = [
    { model: 'Pixel 7', build: 'TD1A.220804.031', osVersion: '13' },
    { model: 'Pixel 7 Pro', build: 'TD1A.220804.031', osVersion: '13' },
    { model: 'Pixel 6', build: 'SD1A.210817.023', osVersion: '12' },
    { model: 'Pixel 6 Pro', build: 'SD1A.210817.023', osVersion: '12' },
    { model: 'SM-G998B', build: 'RP1A.200720.012', osVersion: '13' },
    { model: 'SM-G991B', build: 'RP1A.200720.012', osVersion: '14' },
    { model: 'SM-S908B', build: 'SP1A.210812.016', osVersion: '14' },
    { model: 'OnePlus9Pro', build: 'RKQ1.201105.002', osVersion: '13' },
    { model: 'IN2023', build: 'RKQ1.201105.002', osVersion: '12' },
  ];
  
  const languages = ['en_US', 'en_GB', 'es_ES', 'es_MX', 'pt_BR', 'de_DE', 'fr_FR'];
  
  // Version codes that work (tested)
  const versionCodes = [
    { code: '2022405010', semantic: '29.5.4' },
    { code: '2023400040', semantic: '31.4.4' },
    { code: '2024302010', semantic: '34.3.2' },
  ];
  
  const device = devices[Math.floor(Math.random() * devices.length)];
  const language = languages[Math.floor(Math.random() * languages.length)];
  const version = versionCodes[Math.floor(Math.random() * versionCodes.length)];
  
  // Format model for URL (replace spaces with +)
  const modelForUrl = device.model.replace(/ /g, '+');
  
  return {
    userAgent: `com.zhiliaoapp.musically/${version.code} (Linux; U; Android ${device.osVersion}; ${language}; ${device.model}; Build/${device.build}; Cronet/58.0.2991.0)`,
    commonParams: `version_code=${version.semantic}&app_name=musical_ly&channel=googleplay&device_platform=android&device_type=${modelForUrl}&os_version=${device.osVersion}`
  };
}

function getStickyDeviceIdentity(sessionId) {
  const now = Date.now();
  
  // Cleanup cache (5% chance)
  if (Math.random() < 0.05) {
    for (const [k, v] of deviceIdentityCache) {
      if (now > v.expiresAt) deviceIdentityCache.delete(k);
    }
  }

  if (deviceIdentityCache.has(sessionId)) {
    const entry = deviceIdentityCache.get(sessionId);
    if (now < entry.expiresAt) return entry.identity;
  }

  // Generate new
  const identity = generateIdentity(sessionId);
  deviceIdentityCache.set(sessionId, {
    identity,
    expiresAt: now + 3600 * 1000 // 1 hour
  });
  return identity;
}

function generateIdentity(seedStr) {
  // Seeded random
  let seed = 0;
  if (seedStr) {
    for (let i = 0; i < seedStr.length; i++) {
      seed = ((seed << 5) - seed) + seedStr.charCodeAt(i);
      seed |= 0;
    }
  }
  const random = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };
  const pick = (arr) => arr[Math.floor(random() * arr.length)];

  const models = [
    'SM-G988N', 'SM-G991B', 'SM-G998B', 'Pixel 6', 'Pixel 7 Pro',
    'M2102J20SG', '2201116SG', 'OnePlus9Pro', 'IN2023', 'CPH2413'
  ];
  const osVersions = ['Android 10', 'Android 11', 'Android 12', 'Android 13', 'Android 14'];
  // Use only the version code you specified
  const versionCode = '2024302010'; 
  const languages = ['en_US', 'en_GB', 'es_ES', 'es_MX', 'pt_BR', 'de_DE', 'fr_FR'];

  return {
    model: pick(models),
    osVersion: pick(osVersions),
    language: pick(languages),
    versionCode: versionCode
  };
}

async function getSessionIds(env, options = {}) {
  const now = Date.now();
  if (!options.force && sessionCache.ids.length > 0 && now - sessionCache.fetchedAt < 60000) {
    console.log('[Sessions] cache hit');
    return sessionCache.ids;
  }

  if (!options.force && useD1(env)) {
    const cached = await readSessionsFromDb(env);
    if (cached.fresh && cached.ids.length > 0) {
      sessionCache.ids = cached.ids.filter(id => !isSessionBanned(id));
      sessionCache.fetchedAt = now;
      console.log(`[Sessions] d1 ids=${sessionCache.ids.length}`);
      return sessionCache.ids;
    }
  }

  if (!env.ADMIN_SESSION_API_URL) {
    console.log('[Sessions] ADMIN_SESSION_API_URL missing');
    sessionCache.ids = [];
    sessionCache.fetchedAt = now;
    console.log('[Sessions] ids=0');
    return sessionCache.ids;
  }

  try {
    let ids = await fetchAdminSessionIds(env);
    // Filter banned (with expiry)
    ids = ids.filter(id => !isSessionBanned(id));

    sessionCache.ids = ids;
    sessionCache.fetchedAt = now;
    console.log(`[Sessions] ids=${ids.length}`);
    if (useD1(env)) await writeSessionsToDb(env, ids);
    return ids;
  } catch (e) {
    return sessionCache.ids; // Return stale if fetch fails
  }
}

function pickRandomSessionId(ids) {
  if (!ids || ids.length === 0) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

async function fetchAdminSessionIds(env) {
  const url = getAdminSessionUrl(env);
  console.log(`[Sessions] fetching ${url}`);
  const headers = {};
  if (env.ADMIN_SESSION_API_TOKEN) headers.Authorization = `Bearer ${env.ADMIN_SESSION_API_TOKEN}`;
  if (env.CF_CLIENT_ID && env.CF_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = env.CF_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = env.CF_CLIENT_SECRET;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Admin session fetch failed (${res.status})`);

  const data = await res.json();
  let ids = [];
  if (data?.session_ids) ids = data.session_ids;
  else if (Array.isArray(data)) ids = data;
  const rawCount = Array.isArray(ids) ? ids.length : 0;
  const valid = (Array.isArray(ids) ? ids : []).filter(isValidSessionId);
  console.log(`[Sessions] admin raw=${rawCount} valid=${valid.length}`);
  return valid;
}

async function ensureSessionDb(env) {
  if (sessionDbReady || !useD1(env)) return;
  await env.SESSION_DB.exec(
    'CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, updated_at INTEGER);'
    + 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);'
  );
  sessionDbReady = true;
}

async function readSessionsFromDb(env) {
  await ensureSessionDb(env);
  const db = env.SESSION_DB;
  const meta = await db.prepare('SELECT value FROM meta WHERE key = ?')
    .bind('last_refresh')
    .first();
  const lastRefresh = meta?.value ? Number(meta.value) : 0;
  const rows = await db.prepare('SELECT session_id FROM sessions').all();
  const ids = (rows?.results || []).map((row) => row.session_id).filter(isValidSessionId);
  const freshWindowMs = 30 * 60 * 1000;
  return {
    ids,
    fresh: lastRefresh > 0 && (Date.now() - lastRefresh) < freshWindowMs
  };
}

async function refreshSessionsToDb(env) {
  if (!useD1(env)) return;
  if (!env.ADMIN_SESSION_API_URL) return;

  try {
    const ids = await fetchAdminSessionIds(env);
    await writeSessionsToDb(env, ids);
  } catch (e) {
    console.log(`[D1] refresh failed: ${e?.message || String(e)}`);
  }
}

async function writeSessionsToDb(env, ids) {
  await ensureSessionDb(env);
  const db = env.SESSION_DB;
  const now = Date.now();
  const uniqueIds = Array.from(new Set(ids));

  if (uniqueIds.length === 0) {
    await db.prepare('DELETE FROM sessions').run();
    await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .bind('last_refresh', String(now))
      .run();
    console.log('[D1] sessions cleared');
    return;
  }

  const statements = uniqueIds.map((id) =>
    db.prepare('INSERT OR REPLACE INTO sessions (session_id, updated_at) VALUES (?, ?)')
      .bind(id, now)
  );

  const placeholders = uniqueIds.map(() => '?').join(',');
  statements.push(
    db.prepare(`DELETE FROM sessions WHERE session_id NOT IN (${placeholders})`)
      .bind(...uniqueIds)
  );
  statements.push(
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .bind('last_refresh', String(now))
  );

  await db.batch(statements);
  console.log(`[D1] sessions upserted=${uniqueIds.length}`);
}

function isSessionBanned(sessionId) {
  const until = bannedSessions.get(sessionId);
  if (!until) return false;
  if (Date.now() < until) return true;
  bannedSessions.delete(sessionId);
  return false;
}

function recordSessionFailure(sessionId, env) {
  const now = Date.now();
  const WINDOW = 24 * 3600 * 1000;
  const THRESHOLD = 20;

  let failures = sessionFailures.get(sessionId) || [];
  failures = failures.filter(t => now - t < WINDOW);
  failures.push(now);
  sessionFailures.set(sessionId, failures);

  if (failures.length >= THRESHOLD) {
    console.log(`[BAN] Session redacted banned. ${failures.length} failures.`);
    bannedSessions.set(sessionId, now + 600 * 1000); // 10 min ban
    sessionFailures.delete(sessionId);
    // Update cache immediately
    sessionCache.ids = sessionCache.ids.filter(id => id !== sessionId);
  } else {
    console.log(`[WARN] Session redacted failures: ${failures.length}/${THRESHOLD}`);
  }
}

function resetSessionFailures(sessionId) {
  sessionFailures.delete(sessionId);
}

function splitTextByBytes(text, maxBytes, maxChunks) {
  const chunks = [];
  let current = '';

  for (const char of text) {
    const next = current + char;
    if (encoder.encode(next).length > maxBytes) {
      if (current) chunks.push(current);
      current = char;
      if (chunks.length >= maxChunks) break;
    } else {
      current = next;
    }
  }

  if (current && chunks.length < maxChunks) chunks.push(current);
  return chunks;
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Auth helpers
async function isAuthenticated(request, env) {
  if (!env.SITE_PASSWORD) return true;
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies.site_auth;
  if (!token) return false;
  const expected = await getAuthToken(env);
  return token === expected;
}

async function getAuthToken(env) {
  if (cachedAuthToken && cachedAuthPassword === env.SITE_PASSWORD) return cachedAuthToken;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.SITE_PASSWORD || ''));
  cachedAuthToken = toHex(digest);
  cachedAuthPassword = env.SITE_PASSWORD;
  return cachedAuthToken;
}

function parseCookies(header) {
  const cookies = {};
  header.split(';').forEach(pair => {
    const [name, value] = pair.trim().split('=');
    if (name && value) cookies[name] = decodeURIComponent(value);
  });
  return cookies;
}

function useD1(env) {
  return Boolean(env?.ENABLE_D1_CACHE && env?.SESSION_DB);
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleAuth(request, env) {
  if (!env.SITE_PASSWORD) return new Response('Not configured', { status: 500 });
  
  let password = '';
  let redirect = '/';
  
  try {
    const type = request.headers.get('content-type') || '';
    if (type.includes('form')) {
      const fd = await request.formData();
      password = fd.get('password');
      redirect = fd.get('redirect') || '/';
    } else {
      const json = await request.json();
      password = json.password;
      redirect = json.redirect || '/';
    }
  } catch (e) {}

  if (password !== env.SITE_PASSWORD) return renderLoginPage(new URL(request.url), 'Invalid password');

  const token = await getAuthToken(env);
  return new Response(null, {
    status: 302,
    headers: {
      'Set-Cookie': `site_auth=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
      'Location': redirect
    }
  });
}

function handleLogout(request) {
  return new Response(null, {
    status: 302,
    headers: {
      'Set-Cookie': 'site_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      'Location': '/'
    }
  });
}

function renderLoginPage(url, message) {
  const html = `<!DOCTYPE html>
<html><head><title>Login</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f0f0}
.card{background:white;padding:2rem;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
input{display:block;width:100%;margin:1rem 0;padding:0.5rem}
button{width:100%;padding:0.5rem;background:#333;color:white;border:none;border-radius:4px;cursor:pointer}</style>
</head><body><div class="card"><h1>Login</h1>
${message ? `<p style="color:red">${message}</p>` : ''}
<form method="POST" action="/__auth">
<input type="password" name="password" placeholder="Password" required>
<input type="hidden" name="redirect" value="${url.pathname}">
<button type="submit">Enter</button>
</form></div></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
