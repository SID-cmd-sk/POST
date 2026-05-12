function jsonResponse(obj, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(obj), { ...init, headers });
}

function textResponse(text, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(text, { ...init, headers });
}

function getAllowedOrigins(env) {
  const raw = (env.ALLOWED_ORIGINS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(origin, env) {
  const allowed = getAllowedOrigins(env);
  if (!origin || allowed.length === 0) return {};
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Idempotency-Key',
    'Access-Control-Max-Age': '86400'
  };
}

function sanitizeFileName(name) {
  return (name || 'submission.zip')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function githubRequest(env, method, path, body) {
  const url = `https://api.github.com${path}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sks-submission-gateway'
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function commitFileToRepo(env, { path, contentBase64, message }) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const refRes = await githubRequest(env, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    if (!refRes.ok) throw new Error(`GitHub ref fetch failed (${refRes.status})`);
    const headCommitSha = refRes.data.object.sha;

    const commitRes = await githubRequest(env, 'GET', `/repos/${owner}/${repo}/git/commits/${headCommitSha}`);
    if (!commitRes.ok) throw new Error(`GitHub commit fetch failed (${commitRes.status})`);
    const baseTreeSha = commitRes.data.tree.sha;

    const blobRes = await githubRequest(env, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: contentBase64,
      encoding: 'base64'
    });
    if (!blobRes.ok) throw new Error(`GitHub blob create failed (${blobRes.status})`);

    const treeRes = await githubRequest(env, 'POST', `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTreeSha,
      tree: [{ path, mode: '100644', type: 'blob', sha: blobRes.data.sha }]
    });
    if (!treeRes.ok) throw new Error(`GitHub tree create failed (${treeRes.status})`);

    const newCommitRes = await githubRequest(env, 'POST', `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: treeRes.data.sha,
      parents: [headCommitSha]
    });
    if (!newCommitRes.ok) throw new Error(`GitHub commit create failed (${newCommitRes.status})`);

    const updateRefRes = await githubRequest(env, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: newCommitRes.data.sha,
      force: false
    });

    if (updateRefRes.ok) return { commit_sha: newCommitRes.data.sha };
    lastErr = new Error(`GitHub ref update failed (${updateRefRes.status})`);
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  throw lastErr || new Error('Unknown commit error');
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
}

async function rateLimit(env, request) {
  if (!env.SUBMISSION_KV) return;
  const ip = getClientIp(request);
  if (!ip) return;

  const now = new Date();
  const bucket = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const key = `rl:${ip}:${bucket}`;
  const limit = Number(env.RATE_LIMIT_PER_MINUTE || 8);

  const cur = Number((await env.SUBMISSION_KV.get(key)) || 0);
  if (cur >= limit) throw new Error('RATE_LIMITED');
  await env.SUBMISSION_KV.put(key, String(cur + 1), { expirationTtl: 120 });
}

async function getWorkflowRunForCommit(env, commitSha) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;

  const runsRes = await githubRequest(env, 'GET', `/repos/${owner}/${repo}/actions/runs?head_sha=${commitSha}&per_page=5`);
  if (!runsRes.ok) throw new Error(`GitHub runs fetch failed (${runsRes.status})`);
  const runs = (runsRes.data && runsRes.data.workflow_runs) || [];
  if (runs.length === 0) return null;
  runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return runs[0];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/health') {
      return textResponse('ok', { status: 200, headers: cors });
    }

    if (url.pathname === '/submit' && request.method === 'POST') {
      try {
        if (origin && Object.keys(cors).length === 0) {
          return jsonResponse({ ok: false, error: 'origin_not_allowed' }, { status: 403 });
        }

        await rateLimit(env, request);

        const ct = request.headers.get('Content-Type') || '';
        if (!ct.toLowerCase().includes('multipart/form-data')) {
          return jsonResponse({ ok: false, error: 'invalid_content_type' }, { status: 415, headers: cors });
        }

        const form = await request.formData();
        const file = form.get('zip');
        const originalName = sanitizeFileName(form.get('zip_name'));

        if (!(file instanceof File)) {
          return jsonResponse({ ok: false, error: 'zip_missing' }, { status: 400, headers: cors });
        }

        const maxBytes = Number(env.MAX_ZIP_BYTES || 15 * 1024 * 1024);
        if (file.size <= 0 || file.size > maxBytes) {
          return jsonResponse({ ok: false, error: 'zip_size_invalid' }, { status: 400, headers: cors });
        }

        const buf = await file.arrayBuffer();
        const bodyHash = request.headers.get('X-Idempotency-Key') || '';
        const sha = bodyHash && /^[a-f0-9]{64}$/i.test(bodyHash) ? bodyHash.toLowerCase() : await sha256Hex(buf);

        if (env.SUBMISSION_KV) {
          const existingId = await env.SUBMISSION_KV.get(`sha:${sha}`);
          if (existingId) {
            return jsonResponse(
              { ok: false, error: 'duplicate', submission_id: existingId },
              { status: 409, headers: cors }
            );
          }
        }

        const submissionId = crypto.randomUUID();
        const storedName = `${submissionId}_${originalName}`;
        const storedPath = `submissions/${storedName}`;

        if (!env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_TOKEN) {
          return jsonResponse({ ok: false, error: 'server_not_configured' }, { status: 500, headers: cors });
        }

        const base64 = arrayBufferToBase64(buf);
        const commit = await commitFileToRepo(env, {
          path: storedPath,
          contentBase64: base64,
          message: `New submission: ${storedName}`
        });

        if (env.SUBMISSION_KV) {
          await env.SUBMISSION_KV.put(`sha:${sha}`, submissionId, { expirationTtl: 60 * 60 * 24 * 30 });
          await env.SUBMISSION_KV.put(
            `submission:${submissionId}`,
            JSON.stringify({ submission_id: submissionId, commit_sha: commit.commit_sha, stored_path: storedPath, sha }),
            { expirationTtl: 60 * 60 * 24 * 30 }
          );
        }

        return jsonResponse(
          { ok: true, submission_id: submissionId, commit_sha: commit.commit_sha, stored_path: storedPath },
          { status: 200, headers: cors }
        );
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (msg === 'RATE_LIMITED') {
          return jsonResponse({ ok: false, error: 'rate_limited' }, { status: 429, headers: cors });
        }
        return jsonResponse({ ok: false, error: 'internal_error' }, { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      try {
        if (origin && Object.keys(cors).length === 0) {
          return jsonResponse({ ok: false, error: 'origin_not_allowed' }, { status: 403 });
        }

        const submissionId = (url.searchParams.get('submission_id') || '').trim();
        if (!submissionId) return jsonResponse({ ok: false, error: 'submission_id_missing' }, { status: 400, headers: cors });
        if (!env.SUBMISSION_KV) return jsonResponse({ ok: false, error: 'status_not_supported' }, { status: 501, headers: cors });

        const raw = await env.SUBMISSION_KV.get(`submission:${submissionId}`);
        if (!raw) return jsonResponse({ ok: false, error: 'not_found' }, { status: 404, headers: cors });
        const rec = JSON.parse(raw);

        const run = await getWorkflowRunForCommit(env, rec.commit_sha);
        if (!run) {
          return jsonResponse(
            { ok: true, submission_id: submissionId, workflow: { status: 'queued', conclusion: null, run_url: null } },
            { status: 200, headers: cors }
          );
        }

        return jsonResponse(
          {
            ok: true,
            submission_id: submissionId,
            workflow: {
              status: run.status,
              conclusion: run.conclusion,
              run_url: run.html_url
            }
          },
          { status: 200, headers: cors }
        );
      } catch {
        return jsonResponse({ ok: false, error: 'internal_error' }, { status: 500, headers: cors });
      }
    }

    return jsonResponse({ ok: false, error: 'not_found' }, { status: 404, headers: cors });
  }
};

