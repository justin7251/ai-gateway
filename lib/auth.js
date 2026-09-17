/**
 * Front-door auth: without the correct GATEWAY_SECRET no request is routed.
 *
 * Hardened vs the original plan:
 *  - constant-time comparison (crypto.timingSafeEqual) so response timing
 *    can't be used to brute-force the secret character by character
 *  - fails CLOSED if GATEWAY_SECRET is not configured at all
 */

const crypto = require("crypto");

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Burn a comparison anyway so short-guess attempts aren't faster.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(req) {
  const expected = process.env.GATEWAY_SECRET || "";
  if (!expected) {
    console.error("auth: GATEWAY_SECRET is not configured — failing closed");
    return false;
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return false;

  return safeEqual(token, expected);
}

module.exports = { checkAuth };
