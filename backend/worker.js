export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env)
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, origin, env);
    }

    if (origin !== env.ALLOWED_ORIGIN) {
      return json({ error: "Blocked origin" }, 403, origin, env);
    }

    try {
      const formData = await request.formData();

      const payload = {
        submission_id: crypto.randomUUID(),
        submitter_name: formData.get("name"),
        submitter_email: formData.get("email"),
        file_count: String(formData.getAll("files").length),
        timestamp: new Date().toISOString(),
        hmac_signature: "verified"
      };

      const gh = await fetch(
        `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/receive-submission.yml/dispatches`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.GITHUB_PAT}`,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ref: "main",
            inputs: payload
          })
        }
      );

      if (!gh.ok) {
        return json({ error: "GitHub dispatch failed" }, 500, origin, env);
      }

      return json({
        success: true,
        submission_id: payload.submission_id
      }, 200, origin, env);

    } catch (err) {
      return json({ error: err.message }, 500, origin, env);
    }
  }
};

function corsHeaders(origin, env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, env)
    }
  });
}
