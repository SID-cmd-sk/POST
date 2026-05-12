# Secure Submission Refactor (GitHub Pages Safe)

## Architecture

Frontend (static GitHub Pages)
→ Submission Gateway (serverless, holds GitHub token in server-side env)
→ GitHub Repo commit to `submissions/`
→ Existing GitHub Action (`process_submission.yml`)
→ Google Drive upload + `database.xlsx` update
→ Repo moves `submissions/` → `processed/`

## What Changed

- Removed all browser-side GitHub authentication and repository write operations.
- Replaced direct GitHub API calls with a single server-side submission gateway call.
- Added optional KV-backed rate limiting and duplicate submission prevention.
- Added a status endpoint so the frontend can show workflow status without GitHub auth.
- Hardened the workflow to avoid recursive runs and to serialize processing.

## Files Added/Modified

- Frontend
  - [index.html](file:///workspace/index.html)
- GitHub Actions
  - [process_submission.yml](file:///workspace/.github/workflows/process_submission.yml)
- Submission Gateway (Cloudflare Worker)
  - [worker.mjs](file:///workspace/backend/cloudflare-worker/src/worker.mjs)
  - [wrangler.toml](file:///workspace/backend/cloudflare-worker/wrangler.toml)

## Configuration (Frontend)

In [index.html](file:///workspace/index.html), set:

- `SKS_SUBMISSION_GATEWAY_BASE` to your deployed gateway base URL (no trailing slash)

No secrets are required (or allowed) in the frontend.

## Configuration (Submission Gateway)

### Required environment variables

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_BRANCH` (default: `main`)
- `GITHUB_TOKEN` (server-side only)
- `ALLOWED_ORIGINS` (comma-separated GitHub Pages origins allowed to call the gateway)

### Recommended (security)

- Bind a KV namespace named `SUBMISSION_KV`:
  - Enables rate limiting, idempotency/duplicate prevention, and status lookups.
- `RATE_LIMIT_PER_MINUTE` (default: `8`)
- `MAX_ZIP_BYTES` (default: `15728640` = 15MB)

### GitHub token guidance

Use a fine-grained PAT or (preferred) a GitHub App installation token with:

- Repository permissions:
  - Contents: Read and write
  - Actions: Read-only (needed only if you use `/status`)

Do not reuse user PATs; create a dedicated automation identity.

## GitHub Actions Secrets (Existing)

No changes required to existing Google Drive secrets:

- `GDRIVE_CREDENTIALS`
- `GDRIVE_FOLDER_ID`

## Deployment Steps

1. Revoke the exposed PAT
   - Revoke the previously embedded PAT immediately (it is now compromised by definition).
2. Deploy the submission gateway
   - Deploy [worker.mjs](file:///workspace/backend/cloudflare-worker/src/worker.mjs) to a serverless runtime (Cloudflare Workers recommended).
   - Configure the environment variables and KV binding.
3. Configure the frontend
   - Set `SKS_SUBMISSION_GATEWAY_BASE` in [index.html](file:///workspace/index.html).
   - Deploy GitHub Pages as before.
4. Verify end-to-end
   - Submit a test ZIP from the UI.
   - Confirm a new ZIP appears in `submissions/`.
   - Confirm the Action run processes the ZIP and moves it to `processed/`.
   - Confirm Google Drive receives the ZIP and `database.xlsx` updates.

## Testing Checklist

- Frontend
  - No token present in view-source or network requests.
  - Successful submission shows upload progress.
  - Duplicate submission returns a clean, user-friendly result.
  - Workflow status updates from queued → in_progress → completed.
- Gateway
  - Rejects missing/invalid `multipart/form-data`.
  - Rejects non-zip payloads by size guard (and optional MIME checks by deployment platform).
  - Enforces `ALLOWED_ORIGINS`.
  - Enforces rate limiting (KV enabled).
- Actions
  - Runs only on new uploads (no recursive processing runs from bot commits).
  - Serializes concurrent submissions (concurrency group).
- Drive
  - ZIP uploads succeed.
  - `database.xlsx` updates and retains formatting and log sheet.

## Rollback Plan

1. Disable the gateway (or change `SKS_SUBMISSION_GATEWAY_BASE` to empty) to stop intake.
2. Revert [index.html](file:///workspace/index.html) and [process_submission.yml](file:///workspace/.github/workflows/process_submission.yml) to the previous commit.
3. Rotate all GitHub and Drive credentials that were used during the incident window.

Do not roll back to a frontend-embedded token design. If rollback is required, use a server-side gateway with reduced functionality (for example, accept uploads but hold processing) rather than re-exposing secrets.

