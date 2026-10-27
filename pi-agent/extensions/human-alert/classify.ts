/**
 * Pure classification helpers for the human-alert extension.
 *
 * Kept separate from index.ts so the fixture self-test can run without pi.
 *
 * Two precision rules, learned from false-positive churn on live hunts:
 *
 *  1. The HEURISTIC path (scanning raw `browser_live_*` results) is strict.
 *     A captcha alert now requires a vendor/challenge-infrastructure *marker*
 *     (`recaptcha`, `turnstile`, `cdn-cgi/challenge-platform`, …), never a bare
 *     English phrase. "verify you are human" / "just a moment" / "checking your
 *     browser" on their own are the main false-positive source — they show up
 *     in docs, in normal login UI, and in transient Cloudflare interstitials
 *     that the browser auto-passes — so alone they no longer fire. OTP/code
 *     entry and explicit manual-handoff phrases stay (they are valued and work).
 *
 *  2. The EXPLICIT path (`NEED_HUMAN: <reason>` in assistant text) stays loose.
 *     There the model has deliberately declared a block, so a bare keyword in
 *     the reason ("solve CAPTCHA") is enough to recognise it as a browser wall.
 *     That is `namesBrowserWall`, used only by `shouldAlertNeedHuman`.
 */

export const NEED_HUMAN_RE = /NEED[_ ]HUMAN[:\s-]*([^\n]*)/i;

// Vendor / challenge-infrastructure markers. These are widget or challenge
// identifiers that essentially never appear in ordinary editorial page text,
// so on a live browser result they are high-confidence and fire on their own.
const CHALLENGE_MARKER_RE =
  /(?:\bre[- ]?captcha\b|\bh[- ]?captcha\b|\bg[- ]?recaptcha\b|\bgrecaptcha\b|\bturnstile\b|cdn-cgi\/challenge-platform|challenges\.cloudflare\.com|\bcf[-_]chl\b|__cf_chl|data-sitekey|hcaptcha\.com|recaptcha\/api2|google\.com\/recaptcha)/i;

// Soft English wall phrases. LOW precision on a live result (docs, login UI,
// auto-resolving Cloudflare interstitials), so in the heuristic path they fire
// ONLY when a CHALLENGE_MARKER is also present. Used alone only to recognise an
// explicit model-declared NEED_HUMAN reason.
const SOFT_WALL_RE =
  /(?:\bcaptcha\b|just a moment\.{0,3}|checking your browser|\bverify (?:that )?you(?:'re| are) (?:a )?human\b|\bare you a robot\b|\bhuman verification\b|\bcomplete (?:the )?(?:security check|captcha)\b|enable javascript and cookies to continue)/i;

// OTP / code-entry signals. Bare "2fa" is intentionally NOT matched.
const OTP_RE =
  /\b(?:one[- ]time (?:code|password)|otp|verification code|security code|authentication code|passcode|code (?:was )?sent to|two[- ]factor (?:code|authentication)|2fa code|two[- ]step verification)\b|\benter (?:the )?(?:code|otp)\b/i;

// Explicit manual browser handoff, not a generic form field.
const MANUAL_RE =
  /\b(?:manual (?:verification|review) (?:required|needed)|operator (?:must|needs to) (?:enter|fill|complete)|complete the (?:required )?(?:form|fields) manually)\b/i;

// Reasons that are clearly not a live-browser handoff. This is a safety net
// for a model that disobeys the steering and emits NEED_HUMAN after browsing.
const NON_BROWSER_RE =
  /\b(?:api[\s_-]?key|quota|credentials?|rate[\s-]?limit|legal|scope|billing|payment|subscription|proxy|ip[\s-]?(?:block|ban)|network|token)\b/i;

export function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b: any) => b.text || "")
      .join("\n");
  }
  return "";
}

export function isBrowserTool(name: unknown): boolean {
  return typeof name === "string" && name.startsWith("browser_live_");
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * STRICT heuristic for raw browser results. Returns a short wall description,
 * or null. Captcha requires a CHALLENGE_MARKER; OTP/manual are phrase-based.
 */
export function detectBrowserWall(text: string): string | null {
  if (!text) return null;
  let m = text.match(CHALLENGE_MARKER_RE);
  if (m) return norm(m[0]);
  for (const re of [OTP_RE, MANUAL_RE]) {
    m = text.match(re);
    if (m) return norm(m[0]);
  }
  // Soft wall phrases alone do not fire (false-positive class). If a marker had
  // been present it would have matched above.
  return null;
}

/**
 * Kind of wall for alert routing. "captcha" walls are transient-prone
 * (Cloudflare interstitials auto-resolve), so index.ts confirms them before
 * alarming; "otp"/"manual" fire immediately.
 */
export function wallKind(text: string): "captcha" | "otp" | "manual" | null {
  if (!text) return null;
  if (CHALLENGE_MARKER_RE.test(text)) return "captcha";
  if (OTP_RE.test(text)) return "otp";
  if (MANUAL_RE.test(text)) return "manual";
  return null;
}

/**
 * LOOSE check used only for an explicit NEED_HUMAN reason: the model declared a
 * block, so a bare keyword ("solve CAPTCHA") is enough to call it a browser wall.
 */
export function namesBrowserWall(reason: string): boolean {
  if (!reason) return false;
  return (
    CHALLENGE_MARKER_RE.test(reason) ||
    SOFT_WALL_RE.test(reason) ||
    OTP_RE.test(reason) ||
    MANUAL_RE.test(reason)
  );
}

export function extractNeedHuman(text: string): string | null {
  const m = (text || "").match(NEED_HUMAN_RE);
  if (!m) return null;
  return (m[1] || "").trim();
}

/**
 * Explicit NEED_HUMAN is only actionable when it came from a live-browser
 * flow. A browser tool in the same turn or a recent browser result counts;
 * a reason that itself names a browser wall also counts so a coordinator can
 * surface a subagent's browser blocker.
 */
export function shouldAlertNeedHuman(
  reason: string,
  browserInTurn: boolean,
  lastBrowserAt: number,
  now: number,
  windowMs: number,
): boolean {
  // A named browser wall is always actionable, even if the browser tool result
  // happened in an earlier turn/process.
  if (namesBrowserWall(reason)) return true;
  // Obvious non-browser blockers stay silent even if a browser was touched.
  if (NON_BROWSER_RE.test(reason)) return false;
  if (browserInTurn) return true;
  if (lastBrowserAt > 0 && now - lastBrowserAt <= windowMs) return true;
  return false;
}
