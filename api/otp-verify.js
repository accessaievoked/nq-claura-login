const crypto = require('crypto');

// Set SHIPROCKET_ENV=production in Vercel to use the live Shiprocket API.
const BASE_URL =
  process.env.SHIPROCKET_ENV === 'production'
    ? 'https://checkout-api.shiprocket.com'
    : 'https://fastrr-api-dev.pickrr.com';

// Path confirmed against the Postman docs: POST /api/v1/access-token/s2s-login/verify
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

  // Body per docs: { token, otp, user_address_consent }
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

    // Per the Postman docs, the verify response is:
    //   result: { authorised_customer_token, expires_at }
    const customerToken = data.result.authorised_customer_token;
    if (!customerToken) {
      // Logs FIELD NAMES only, never values.
      console.error('Shiprocket verify OK but no authorised_customer_token. result keys:', Object.keys(data.result).join(','));
      return res.status(502).json({ error: 'Login succeeded but no session token was returned. Please try again.' });
    }

    return res.status(200).json({
      customer_token: customerToken,
      expires_at: data.result.expires_at || '',
    });
  } catch (err) {
    console.error('Shiprocket verify request error', err && err.message);
    return res.status(502).json({ error: 'Could not reach Shiprocket right now' });
  }
};
