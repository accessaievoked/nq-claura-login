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
    let data = {};
    try {
      data = await sr.json();
    } catch (e) {
      // Shiprocket returned a non-JSON body
    }

    if (!sr.ok || data.error || !data.result) {
      // Visible in Vercel -> Logs. Never log the token or keys.
      console.error('Shiprocket customer-data failed', sr.status, JSON.stringify(data).slice(0, 500));
      return res
        .status(sr.ok ? 502 : sr.status || 502)
        .json({ error: typeof data.error === 'string' ? data.error : 'Could not fetch account data' });
    }

    // Logs only the FIELD NAMES (no personal data) so we can see what Shiprocket returns.
    const addrs = Array.isArray(data.result.addresses) ? data.result.addresses : [];
    console.log(
      'Shiprocket customer-data ok. result keys:',
      Object.keys(data.result).join(','),
      '| address count:', addrs.length,
      '| address keys:', addrs[0] ? Object.keys(addrs[0]).join(',') : '-'
    );

    return res.status(200).json({
      country_code: data.result.country_code || '91',
      phone: data.result.phone,
      addresses: addrs,
    });
  } catch (err) {
    console.error('Shiprocket customer-data request error', err && err.message);
    return res.status(502).json({ error: 'Could not reach Shiprocket right now' });
  }
};
