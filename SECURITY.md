# Security

Replyfold reads and sends your team's email, so we treat security reports as the top priority.

## Report a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting on this repository: open the **Security** tab and click **Report a vulnerability**. Include the steps to reproduce the problem and the version or commit you tested.

We reply within 3 business days and keep you updated until the fix ships.

## Supported versions

Only the latest release and the `main` branch get security fixes.

## What Replyfold does to protect your data

- Mailbox credentials (OAuth tokens, app passwords) are encrypted with AES-256-GCM. The key comes from `REPLYFOLD_SECRET_KEY` and never leaves the server.
- OAuth uses the authorization code flow with PKCE and a single-use state bound to the signed-in user.
- Passwords are hashed with Bun's built-in `Bun.password` (argon2id).
- Session cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` when `PUBLIC_URL` uses HTTPS.
- The server refuses cross-site writes by checking the `Origin` header.
- Sign-in attempts are rate limited per address.
- Attachments are served with `Content-Security-Policy: sandbox` and `nosniff`. Only images open inline.
- The MCP endpoint is read-only and off until you set `MCP_TOKEN`.
- No mail goes out without a person pressing **Send**.

## What you are responsible for

- Run Replyfold behind HTTPS when people reach it over a network.
- Keep `.env`, `REPLYFOLD_SECRET_KEY` and the SQLite file private and backed up.
- Create your own Google and Microsoft OAuth apps and keep their secrets private.
