const crypto = require('crypto');

// Set SHIPROCKET_ENV=production in Vercel to use the live Shiprocket API.
const BASE_URL =
  process.env.SHIPROCKET_ENV === 'production'
    ? 'https://checkout-api.shiprocket.com'
    : 'https://fastrr-api-dev.pickrr.com';

// TODO: confirm this path against the "Verify OTP" request in the Postman docs.
// It is modelled on the initiate endpoint (/api/v1/access-token/s2s-login/initiate).
const VERIFY_PATH = '/api/v1/access-token/s2s-login/verify';

function sign(bodyString) {
  return crypto
    .createHmac('sha256', process.env.SHIPROCKET_HMAC_SECRET)
    .update(bodyString)
    .digest('base64');
}

module.exports = async (req, res) => {
  // Lock this down to your storefront domain only
  res.setHeader('Access-Control-Allow-Origin', 'https://claura.in');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // These are the three fields the theme sends (custom-login-page.liquid)
  const { login_token, otp, user_address_consent } = req.body || {};

  if (!login_token) {
    return res.status(400).json({ error: 'Missing login token. Please request a new OTP.' });
  }
  if (!otp || !/^\d{6}$/.test(String(otp))) {
    return res.status(400).json({ error: 'Enter the 6-digit OTP' });
  }

  // TODO: confirm these field names against the Postman "Verify OTP" body.
  const bodyString = JSON.stringify({
    token: login_token,
    otp: String(otp),
    user_address_consent: user_address_consent === true,
    timestamp: new Date().toISOString(),
  });

  try {
    const sr = await fetch(`${BASE_URL}${VERIFY_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.SHIPROCKET_API_KEY,
        'X-Api-HMAC-SHA256': sign(bodyString),
      },
      body: bodyString,
    });

    let data = {};
    try {
      data = await sr.json();
    } catch (e) {
      // Shiprocket returned a non-JSON body
    }

    if (!sr.ok || data.error || !data.result) {
      // Shows up in Vercel -> Logs so you can see Shiprocket's real reason.
      // Never log the OTP, token or keys.
      console.error('Shiprocket verify failed', sr.status, JSON.stringify(data).slice(0, 500));
      return res
        .status(sr.ok ? 400 : sr.status || 502)
        .json({ error: typeof data.error === 'string' ? data.error : 'Invalid or expired OTP' });
    }

    // Shiprocket's verify response may not call the field `token`, so try the
    // likely names. If none match, log the FIELD NAMES (never values) so we can
    // see the real shape in Vercel -> Logs, and fail loudly instead of letting
    // the theme store "undefined" as the token.
    const r = data.result || {};
    const customerToken =
      r.token || r.access_token || r.customer_token || r.accessToken ||
      (r.data && (r.data.token || r.data.access_token)) || null;
    const expiresAt =
      r.expires_at || r.expiry || r.expires_in ||
      (r.data && r.data.expires_at) || '';

    if (!customerToken) {
      console.error(
        'Shiprocket verify OK but no token field found. result keys:',
        Object.keys(r).join(','),
        '| top-level keys:', Object.keys(data).join(',')
      );
      return res.status(502).json({ error: 'Login succeeded but no session token was returned. Please try again.' });
    }

    return res.status(200).json({
      customer_token: customerToken,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('Shiprocket verify request error', err && err.message);
    return res.status(502).json({ error: 'Could not reach Shiprocket right now' });
  }
};
