/* Cloudflare Worker: receipt vision proxy (diagnostic build).
   Holds your Anthropic key server-side and now REPORTS upstream errors
   instead of swallowing them, so a failed read tells you why.

   Secret required:  ANTHROPIC_API_KEY = sk-ant-...
   Then put this worker's URL in app.js -> CONFIG.EXTRACT_URL
*/

const MODEL = "claude-haiku-4-5-20251001";  // exact dated string; swap to "claude-sonnet-4-6" for tougher receipts
const ALLOW_ORIGIN = "*";                    // set to "https://<you>.github.io" once the app has a final URL

const PROMPT =
  'Read this receipt. Respond with ONLY a JSON object, no prose, no markdown fences: ' +
  '{"date":"YYYY-MM-DD","merchant":"store name","amount":"grand total as a plain number",' +
  '"last4":"last 4 digits of the payment card, else empty","category":"one of: Medical, Food, Groceries, Travel, Vehicle, Shopping, Utilities, Other"}. ' +
  'Use the purchase date and the final total paid. For category, pick the single best fit based on the merchant and items; use Other if unclear. ' +
  'CRITICAL for last4: only fill it when digits are CLEARLY a masked payment card number \u2014 shown with masking like ****1234, XXXX1234, or ending-in wording, or right next to a card network word (VISA, MASTERCARD, AMEX, DISCOVER) or a wallet (Apple Pay, Google Pay, Samsung Pay). ' +
  'NEVER use digits from a phone number, order/transaction/receipt number, store number, date, time, item count, or the dollar amount. If you are not sure the digits are a card number, return an empty string. ' +
  'If any field is unreadable, use an empty string.';

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors() } });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    if (!env.ANTHROPIC_API_KEY) return json({ error: "no_api_key_secret", hint: "Add a Secret named ANTHROPIC_API_KEY" }, 500);

    let image;
    try { ({ image } = await request.json()); }
    catch { return json({ error: "bad_request_body" }, 400); }
    if (!image) return json({ error: "no_image_field" }, 400);

    let r, data;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
              { type: "text", text: PROMPT }
            ]
          }]
        })
      });
      data = await r.json();
    } catch (e) {
      return json({ error: "fetch_failed", detail: String(e) }, 502);
    }

    // Surface Anthropic's own error (bad model, low balance, auth, etc.) instead of hiding it.
    if (!r.ok || data.type === "error" || !Array.isArray(data.content)) {
      return json({ error: "anthropic_error", status: r.status, detail: data }, 502);
    }

    const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return json({ error: "parse_failed", raw: text }, 502); }
    return json(parsed, 200);
  }
};
