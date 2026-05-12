# SKS Questionnaire — GitHub + Google Drive Setup Guide

## What you need (all free)
- A GitHub account
- A Google account (your existing Drive)

---

## STEP 1 — Create the GitHub Repo

1. Go to https://github.com/new
2. Name it: `sks-submissions` (or anything you want)
3. Set it to **Private** (important for security)
4. Click **Create repository**

---

## STEP 2 — Enable GitHub Pages

1. In the repo → **Settings** → **Pages**
2. Source: **Deploy from branch** → `main` → `/ (root)`
3. Save. GitHub will give you a URL like:
   `https://YOUR_USERNAME.github.io/sks-submissions/`
4. Your form will be live at that URL + `questionnaire_post.html`

---

## STEP 3 — Create a GitHub Fine-Grained PAT (for the HTML form)

This token lets the form upload ZIPs into your repo.

1. Go to https://github.com/settings/tokens?type=beta
2. Click **Generate new token**
3. Name: `SKS Form Upload`
4. Repository access: **Only select repositories** → pick `sks-submissions`
5. Permissions → **Contents**: `Read and Write`
6. Generate and COPY the token (you only see it once)
7. Open `questionnaire_post.html` and fill in:
   ```js
   const SKS_GITHUB_OWNER = 'your_github_username';
   const SKS_GITHUB_REPO  = 'sks-submissions';
   const SKS_GITHUB_TOKEN = 'github_pat_XXXXXXXXXXXX';
   ```

> ⚠️  IMPORTANT: Keep the repo **Private** so this token is not visible publicly.
> The token only has write access to this one repo — nothing else.

---

## STEP 4 — Set Up Google Drive API Service Account

This lets GitHub Actions write to your Drive automatically.

1. Go to https://console.cloud.google.com/
2. Create a new project: `SKS Automation`
3. **APIs & Services** → **Enable APIs** → search `Google Drive API` → Enable
4. **APIs & Services** → **Credentials** → **Create Credentials** → **Service Account**
   - Name: `sks-drive-writer`
   - Click **Done**
5. Click the new service account → **Keys** tab → **Add Key** → **JSON**
6. A `.json` file downloads — keep it safe, this is your `GDRIVE_CREDENTIALS`

---

## STEP 5 — Share Your Drive Folder with the Service Account

1. In Google Drive, create a folder: `SKS Submissions`
2. Note the folder ID from the URL:
   `https://drive.google.com/drive/folders/THIS_IS_THE_ID`
3. Right-click the folder → **Share**
4. Share with the service account email (looks like `sks-drive-writer@your-project.iam.gserviceaccount.com`)
5. Give it **Editor** access

---

## STEP 6 — Add Secrets to GitHub

1. In your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add:

| Secret Name        | Value                                      |
|--------------------|--------------------------------------------|
| `GDRIVE_CREDENTIALS` | Paste the entire content of the JSON file |
| `GDRIVE_FOLDER_ID`   | The Drive folder ID from Step 5           |

---

## STEP 7 — Upload All Files to the Repo

Upload these files maintaining the exact folder structure:

```
sks-submissions/
├── questionnaire_post.html          ← the form (with your token filled in)
├── .gitignore
├── submissions/
│   └── .gitkeep                     ← keeps folder tracked
├── processed/
│   └── .gitkeep
└── .github/
    └── workflows/
        └── process_submission.yml
└── scripts/
    ├── process_and_upload.py
    └── requirements.txt
```

---

## How it works after setup

1. Customer opens the GitHub Pages URL
2. Fills the form → clicks **Publish PDF**
3. ZIP downloads to their PC (same as before)
4. ZIP also uploads silently to `submissions/` in your repo
5. GitHub Actions fires automatically (within ~30 seconds)
6. Python script runs:
   - Reads `data.json` from ZIP
   - Downloads `database.xlsx` from your Drive
   - Adds a new row for the customer
   - Uploads updated `database.xlsx` back to Drive
   - Uploads the ZIP to Drive `/SKS Submissions` folder
   - Moves ZIP in repo from `submissions/` → `processed/`
7. Customer sees a green success banner on screen
8. You open Drive anytime and see the updated Excel + all ZIPs

---

## Security summary

| What                            | How it's protected                              |
|---------------------------------|-------------------------------------------------|
| GitHub repo                     | Private — nobody can browse it                 |
| GitHub PAT in HTML              | Scoped to contents:write on this repo only     |
| Google Drive credentials        | Stored as GitHub Secret — never in code        |
| Customer data                   | Never stored on any public server              |
| Browser cache                   | sessionStorage only — customer can clear it    |
| Drive folder                    | Shared only with service account + your email  |

---

## If something goes wrong

- Check **Actions** tab in GitHub repo to see logs
- Failed ZIPs stay in `submissions/` and won't be deleted
- Customer always gets the PDF download even if upload fails
- Error message shown on screen with instruction to email manually
