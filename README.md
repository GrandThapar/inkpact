# Inkpact

Send any document (PDF) for digital signature. The signer signs on phone/laptop; signed PDF with a signature certificate is emailed to the signer and to you.

## Settings (Netlify → Site configuration → Environment variables)
| Name | Value |
|---|---|
| ADMIN_PASSWORD | Password to open the admin page |
| ADMIN_EMAIL | Where signed copies go (comma-separate for several) |
| SMTP_USER | Gmail / Google Workspace address that sends the emails |
| SMTP_PASS | 16-letter Google App Password for that account |
| FROM_NAME | Sender name shown in emails, e.g. "Lavana Lifestyle Solutions" |

| CLOUDCONVERT_API_KEY | (Optional) lets you upload Word files – API key from cloudconvert.com |

Optional: SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465), SITE_URL (custom domain).

Local test: `npm install && ADMIN_PASSWORD=test node dev-server.mjs` (emails are only logged).
