const crypto = require('crypto');

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
  res.setHeader('Access-Control-Allow-Origin', 'https://claura.in');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { customer_token } = req.body || {};
  if (!customer_token) {
    return res.status(400).json({ error: 'Missing customer token' });
  }

  // Note: per the Postman docs this endpoint does NOT require the
  // X-Api-HMAC-SHA256 header — only customer-data with just the token.
  const bodyString = JSON.stringify({ token: customer_token });

  try {
    const sr = await fetch(`${BASE_URL}/api/v1/customer-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.SHIPROCKET_API_KEY,
      },
      body: bodyString,
    });
    const data = await sr.json();

    if (!sr.ok || data.error) {
      return res.status(sr.status || 400).json({ error: data.error || 'Could not fetch account data' });
    }

    return res.status(200).json({
      country_code: data.result.country_code,
      phone: data.result.phone,
      addresses: data.result.addresses || [],
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Shiprocket right now' });
  }
};