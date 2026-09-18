const crypto = require('crypto');

// Toggle with an env var when you go live: SHIPROCKET_ENV=production
const BASE_URL =
  process.env.SHIPROCKET_ENV === 'production'
    ? 'https://checkout-api.shiprocket.com'
    : 'https://fastrr-api-dev.pickrr.com';

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

  const { phone, country_code = '91' } = req.body || {};
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
  }

  const bodyString = JSON.stringify({
    country_code,
    phone,
    modes: ['SMS'],
    timestamp: new Date().toISOString(),
  });

  try {
    const sr = await fetch(`${BASE_URL}/api/v1/access-token/s2s-login/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.SHIPROCKET_API_KEY,
        'X-Api-HMAC-SHA256': sign(bodyString),
      },
      body: bodyString,
    });
    const data = await sr.json();

    if (!sr.ok || data.error) {
      return res.status(sr.status || 502).json({ error: data.error || 'Could not send OTP' });
    }

    // Only forward what the browser needs — nothing else from Shiprocket's response
    return res.status(200).json({
      login_token: data.result.token,
      expires_at: data.result.expires_at,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Shiprocket right now' });
  }
};