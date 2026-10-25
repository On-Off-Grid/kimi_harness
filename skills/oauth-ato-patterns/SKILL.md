---
name: oauth-ato-patterns
description: "ATO patterns from recent writeups. Load when testing this class or chaining a finding toward higher impact."
---

### Email verification bypass in alternate flows ($22.5k Shopify)
- POS systems, mobile apps, and secondary auth flows often have weaker email verification than the main web app.
- Test: Register via POS/mobile/API instead of web → check if email verification is enforced identically.

### Zero-click ATO via organization invite abuse
- Manipulate invite flow: accept invite for victim's org without victim interaction.
- Test: Organization/team/workspace invite endpoints — can invite be accepted with attacker-controlled email?

### SameSite=None cookie + missing CSRF → 1-step ATO
- If session cookie has `SameSite=None`, CSRF is possible even on modern browsers.
- Test: Check ALL cookies for `SameSite=None`. If found, test CSRF on email-change, password-change, and API-key-generation endpoints.

### SSO email domain bypass → full organization takeover
- SSO provider doesn't validate email domain → attacker registers with `attacker@evil.com` via SSO → gets org access.
- Test: SSO onboarding flow, email domain restrictions, role assignment during SSO registration.

### Server-side parameter pollution → admin ATO
- REST URL path parameter pollution (not just query strings): `/api/users/VICTIM_ID/profile` → inject extra path segments.
- Test: Double-encoding, path traversal in API routes, extra parameters in REST URL paths.

### Password reset token predictability
- Sequential tokens, timestamp-based tokens, low-entropy tokens → brute-force feasibility.
- Test: Request 5+ reset tokens, analyze entropy, check for time-based patterns, attempt enumeration.

### Auth0/SSO misconfiguration → business impact
- Test: Auth0 callback URL validation, token audience checks, RBAC rule enforcement, email domain restrictions.
