# Setup — Google Sheet + Apps Script Backend

This site has no server of its own. The public form and the admin CRM both talk
to a small Google Apps Script "Web App" that reads and writes a Google Sheet
you own. You only need to do this once.

## 1. Create the Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank
   spreadsheet. Name it something like **Seller Lead Form — Data**.
2. Leave it empty — the script creates its own tabs (`Leads`, `Notes`, and
   `Export ...` tabs) automatically the first time it runs.

## 2. Add the script

1. In the Sheet, go to **Extensions → Apps Script**.
2. Delete whatever is in the default `Code.gs` editor.
3. Copy the entire contents of [`backend/Code.gs`](backend/Code.gs) from this
   repo and paste it in.
4. Click the **Save** icon (or Ctrl/Cmd+S).

## 3. Set your secrets (Script Properties)

Still in the Apps Script editor: **Project Settings** (the gear icon on the
left) → scroll to **Script Properties** → **Add script property**. Add these
four, one at a time:

| Property | Value |
|---|---|
| `ADMIN_PASSWORD` | The password you'll log into the CRM with |
| `RECOVERY_CODE_WORD` | A word/phrase only you know, used to trigger a password-recovery email |
| `ADMIN_EMAIL` | `montanoemmanuel@gmail.com` (or whichever inbox should receive recovery emails) |
| `SESSION_SECRET` | Any long random string (e.g. mash the keyboard for 30+ characters) — this signs your login sessions |

None of these ever appear in the public GitHub repo or the browser — they live
only inside this Apps Script project.

## 4. Deploy as a Web App

1. Back in the editor, click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Settings:
   - **Execute as:** Me (your Google account)
   - **Who has access:** Anyone
4. Click **Deploy**.
5. The first time, Google will ask you to authorize the script (it needs
   permission to read/write the Sheet and send email on your behalf via
   `MailApp`). Click through the "unverified app" warning — it's your own
   script — and allow it.
6. Copy the **Web app URL** you're given (ends in `/exec`).

## 5. Wire it into the site

1. Open [`config.js`](config.js) in this repo.
2. Replace `PASTE_YOUR_DEPLOYED_WEB_APP_URL_HERE` with the URL you just
   copied.
3. Commit and push. GitHub Pages will pick up the change automatically.

To sanity-check the deployment on its own, paste the Web App URL into a
browser tab with `?action=ping` on the end — you should see
`{"ok":true,"message":"Seller Lead Form backend is alive."}`.

## Redeploying after a change

If you (or I) ever change `Code.gs`, you must redeploy for it to take effect:
**Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy**.
Simply saving the file is not enough.

## What each Script Property protects

- **ADMIN_PASSWORD** — gates the CRM. Never sent anywhere except compared
  server-side during login.
- **RECOVERY_CODE_WORD** — the only way to get the password emailed to you.
  Change it any time from Script Properties if you think someone else knows it.
- **ADMIN_EMAIL** — fixed server-side, so a recovery request can never be
  redirected to a different inbox by whoever calls the endpoint.
- **SESSION_SECRET** — signs the login session so it can't be forged. Rotating
  it instantly logs out any existing session.

## Data model

- **Leads** tab — one row per submission. Raw submitted fields are never
  edited or deleted from the admin panel; only a `Status` column can be
  changed, and notes are appended to a separate **Notes** tab (never edited or
  deleted either).
- **Export \<date-time\>** tabs — created each time you click "Export to
  Google Sheets" in the CRM. A full snapshot of leads + their notes at that
  moment, kept forever as a permanent record.
- Deleting all CRM data (from the admin panel) only clears the **Leads** and
  **Notes** tabs, and only works immediately after a successful export of
  everything currently in them — the server enforces this, not just the UI.
