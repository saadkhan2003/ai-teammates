# Protect `/admin` with Cloudflare Access (dashboard steps)

This is a manual checklist for Saad. Nothing here calls the Cloudflare API, and the repo never holds Cloudflare credentials. It assumes the production overlay (`deploy/compose.production.yml`) and the optional named tunnel (`cloudflared`, compose profile `tunnel`).

Why: `/api/admin/*` and the admin pages are already behind the owner login, but a public edge should add a second, independent gate (SSO + MFA, no brute-forcing the app login from the open internet). Access evaluates the request at Cloudflare's edge before it reaches the tunnel.

Paths to protect (hostname = your public hostname, for example `teammates.example.com`):

| Destination | Why |
|---|---|
| `teammates.example.com/admin*` | Admin pages |
| `teammates.example.com/api/admin*` | Admin API (users, health) |
| `teammates.example.com/system*` | System page |

Do NOT put Access in front of `/api/events`, `/vnc/*` or the whole site unless you also accept that every browser and API client must carry an Access cookie; keep the rule limited to the paths above.

## 1. Create the named tunnel and run it
1. Cloudflare dashboard -> **Zero Trust** (first visit asks for a team name and plan). Cloudflare lists the Free plan for teams under 50 users ([pricing](https://www.cloudflare.com/sase/products/access/), checked 2026-10-25); confirm the current limit before onboarding because plan terms can change.
2. **Networks -> Tunnels -> Create a tunnel** -> connector **Cloudflared** -> name it `ai-teammates` -> **Save tunnel**.
3. Copy the token from the install command (the long string after `--token`). Put it only in the host environment as `CLOUDFLARED_TUNNEL_TOKEN`; do not commit it.
4. On the **Public hostname** tab add: subdomain `teammates`, domain `example.com`, service type `HTTP`, URL `caddy:80` (the Caddy container name on the compose network; use the plain-HTTP listener, TLS terminates at Cloudflare). Save.
5. Start it: `CLOUDFLARED_TUNNEL_TOKEN=... docker compose -f docker-compose.yml -f deploy/compose.production.yml --profile tunnel up -d cloudflared`. The tunnel shows **Healthy** in the dashboard.

## 2. Add the Access application
1. **Zero Trust -> Access controls (or Access) -> Applications -> Add an application -> Self-hosted**.
2. Application name `AI Teammates admin`. Session duration `8 hours` (shorter is safer).
3. **Add public hostname** three times, one per row in the table above: Input method *Default*, Subdomain `teammates`, Domain `example.com`, Path `admin*` (then `api/admin*`, then `system*`).
4. Under **Identity providers** keep only the ones you use (One-time PIN works with no setup; add Google or GitHub later). Turn **Instant Auth** on only if a single provider is enabled.
5. Click **Next** to policies.

## 3. Policy (default deny, then allow only you)
1. **Add a policy** -> name `Owner only`, **Action: Allow**.
2. **Include** -> selector **Emails** -> your owner email address(es) only. Do not use "Everyone" or an email-domain rule.
3. Optional hardening: **Require** -> **Authentication method** -> `mfa` (needs an IdP that supports MFA, for example Google), and **Require** -> **Country** (your country).
4. Do not add a **Bypass** policy. Cloudflare Access denies requests that match no Allow policy, which is the default-deny behaviour we want.
5. **Next** -> leave CORS settings off -> **Add application**.

## 4. Verify
1. Open a private window and visit `https://teammates.example.com/admin`. You must land on the Cloudflare Access login page, not on the app.
2. Sign in with the allowed email and a one-time PIN. You then reach the admin page and still have to use the app's own owner login.
3. Visit `https://teammates.example.com/api/admin/health` without the cookie (for example with `curl -i`): expect a `302` to `*.cloudflareaccess.com` or a `403`, never `200`.
4. Sign in with a non-listed email: expect "That account does not have access".
5. The user-facing app (`/`, `/api/*`, `/vnc/*`) must still work without an Access login.
6. **Zero Trust -> Logs -> Access** shows allow and deny events; check that your denied test appears.

## 5. Make the origin refuse traffic that skipped Access (recommended)
Access only helps if requests cannot reach the origin another way.
- Keep Caddy bound to the internal Docker network or `127.0.0.1` only; the tunnel dials out, so no inbound port on the host needs to be open. Close `18080/18443` on the public interface in production.
- Optional JWT check: in the Access application open **Overview** and copy the **Application Audience (AUD) tag**. Later the API can verify the `Cf-Access-Jwt-Assertion` header against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and the AUD tag. This repo does not enforce it yet; treat the dashboard policy plus a closed origin as the control for now.

## 6. Rollback
**Access -> Applications -> AI Teammates admin -> Delete** removes the gate. The app's owner login still protects `/admin`. Deleting or stopping the tunnel (`docker compose ... stop cloudflared`) takes the public hostname offline.

Dashboard labels move around between Cloudflare releases ("Access" versus "Access controls"). The settings above are the ones that matter: self-hosted application, the three path destinations, one Allow policy for your email, no Bypass.
