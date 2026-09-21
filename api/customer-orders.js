// api/customer-orders.js
//
// Real order lookup for the custom account dashboard -- Flow-based version.
//
// Orders land in Supabase via Shopify Flow pushing to
// api/shopify-order-sync.js whenever an order is created/updated. This
// endpoint just resolves the caller's phone number (same way
// customer-data.js does, via Shiprocket) and reads that phone's rows back
// out of Supabase.
//
// Required environment variables:
//   SUPABASE_URL                same project as shopify-order-sync.js
//   SUPABASE_SERVICE_ROLE_KEY   same as shopify-order-sync.js

const SHIPROCKET_BASE_URL =
  process.env.SHIPROCKET_ENV === 'production'
    ? 'https://checkout-api.shiprocket.com'
    : 'https://fastrr-api-dev.pickrr.com';

async function resolvePhone(customerToken) {
  const sr = await fetch(`${SHIPROCKET_BASE_URL}/api/v1/customer-data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.SHIPROCKET_API_KEY,
    },
    body: JSON.stringify({ token: customerToken }),
  });
  const data = await sr.json();
  if (!sr.ok || data.error || !data.result) {
    throw new Error(data.error || 'Could not resolve customer from Shiprocket');
  }
  return String(data.result.phone || '').replace(/\D/g, '').slice(-10);
}

function toDashboardOrder(row) {
  return {
    id: row.id,
    name: row.order_name,
    status: row.status,
    date: row.processed_at
      ? new Date(row.processed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '',
    price: row.total_price,
    payment_status: row.payment_status,
    url: '#',
    items: row.line_items || [],
  };
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

  try {
    const phone = await resolvePhone(customer_token);
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/claura_orders?phone=eq.${phone}&order=processed_at.desc`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!resp.ok) throw new Error('Could not read orders from Supabase');
    const rows = await resp.json();
    return res.status(200).json({ orders: rows.map(toDashboardOrder) });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Could not fetch orders right now' });
  }
};