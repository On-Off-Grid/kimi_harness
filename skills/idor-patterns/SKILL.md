---
name: idor-patterns
description: "IDOR patterns from recent writeups. Load when testing this class or chaining a finding toward higher impact."
---

### GraphQL chained IDORs → employee data exposure
- Multiple IDOR vulnerabilities chained via GraphQL nested queries: `{org(id:X){employees{name,email,wellness_data}}}`.
- Test: GraphQL `__schema` introspection first, then enumerate all object relationships, access nested objects cross-tenant.

### Firebase security rules misconfiguration
- Firebase RTDB: access `/.json` endpoint directly without auth. Firestore: query collections via REST API.
- Mobile apps especially have overly permissive rules (`".read": true, ".write": true`).
- Test: `https://PROJECT.firebaseio.com/.json`, Firestore REST API without Bearer token.

### BOLA in content moderation APIs
- Comment approval/rejection APIs often don't validate that the moderator owns the content.
- Test: `/api/comments/{id}/approve`, `/api/reviews/{id}/reject` with other users' content IDs.

### Sequential token IDOR in healthcare
- Healthcare platforms use sequential/predictable tokens for patient records.
- Test: Request own record token, increment/decrement to access other patients' records.
- Impact multiplier: millions of records exposed from one IDOR.

### IDOR → billing data exposure (recon-driven)
- Order and billing APIs rarely validate ownership properly.
- Test: `/api/orders/{id}`, `/api/invoices/{id}`, `/api/billing/{id}` with other users' IDs.

### E-commerce API misconfiguration → PII leak
- Product/order APIs on e-commerce sites often return customer PII without auth.
- Test: Order detail endpoints, customer list APIs, shipping detail endpoints.
