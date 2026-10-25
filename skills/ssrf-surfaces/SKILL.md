---
name: ssrf-surfaces
description: "SSRF surfaces from recent writeups. Load when testing this class or chaining a finding toward higher impact."
---

### Serverless function triggers (Azure Functions, AWS Lambda)
- HTTP triggers, queue triggers, blob triggers can all be SSRF vectors.
- Serverless functions often trust input from trigger sources without validation.
- Test: Any Azure Function/Lambda with HTTP trigger that processes URLs, webhook handlers, URL preview features.

### RSS/Atom/XML feed import features
- Any feature that fetches/parses RSS, Atom, or XML feeds is an SSRF candidate.
- Test: RSS importers, blog aggregators, news readers, podcast importers, feed URL fields.
- Detection: OOB DNS/HTTP callbacks.

### Avatar/image URL fetching
- Profile picture "import from URL" fields, avatar fetchers, image proxy endpoints.
- Often combined with path traversal: `http://internal/../../etc/passwd`.
- Test: Profile picture URL fields, any "fetch image from URL" feature.

### Legacy enterprise subdomains
- Oracle E-Business Suite, PeopleSoft, WebLogic, old CMS instances on forgotten subdomains.
- These often have unauthenticated SSRF + XSS chains.
- Test: Subdomain enumeration for `*.oracle.*`, `*.legacy.*`, `*.old.*` patterns.
