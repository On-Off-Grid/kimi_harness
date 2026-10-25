---
name: race-patterns
description: "race patterns from recent writeups. Load when testing this class or chaining a finding toward higher impact."
---

### Single-endpoint race → admin access via email update
- Race the email update endpoint against itself — server processes email change before auth check completes.
- One request changes email to admin's email, concurrent request authenticates before rollback.
- Test: Email change endpoints with Turbo Intruder single-packet attack.

### Multi-endpoint race → buy items for free
- Race "apply coupon" and "checkout" endpoints simultaneously.
- Payment logic processes discount after price was already locked at checkout.
- Test: Any multi-step purchase flow — race between discount/coupon application and payment processing.

### OTP bypass via race condition
- Send all OTP attempts simultaneously — rate limiting checks happen per-request but don't lock the account fast enough.
- Test: OTP verification endpoints with 10-20 concurrent requests containing different codes.

### Subscription limit bypass
- Create multiple resources concurrently before the plan limit check is enforced.
- Test: Resource creation endpoints on free/basic plans — can you exceed the limit via concurrent requests?

### Sequential tokens in healthcare/sensitive platforms
- Healthcare systems often use sequential/predictable tokens for patient records.
- Combine IDOR enumeration with race condition for mass data exposure.
- Test: Token patterns in medical/health platforms, sequential IDs, UUID predictability + concurrent access.
