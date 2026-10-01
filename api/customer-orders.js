// api/customer-orders.js
//
// Order lookup for the custom account dashboard -- reads orders straight from
// Shopify (Admin GraphQL API). No database needed.
//
// Flow:  customer_token --(Shiprocket customer-data)--> phone
//        phone --(Shopify customers query)--> customer id(s) --> their orders
//        + a fallback search for guest orders whose phone is on the order/address.
// Every order is only returned if it belongs to that phone's customer or its
// own phone fields match the last 10 digits.
//
// Required environment variables (Vercel):
//   SHOPIFY_SHOP_DOMAIN (or SHOPIFY_STORE_DOMAIN)  your-store.myshopify.com   (NOT claura.in)
//   EITHER  SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET   (Dev Dashboard app)
//   OR      SHOPIFY_ADMIN_TOKEN                         (legacy shpat_ token)
// Optional:
//   SHOPIFY_API_VERSION     defaults to 2026-07

const SHIPROCKET_BASE_URL =
  process.env.SHIPROCKET_ENV === 'production'
    ? 'https://checkout-api.shiprocket.com'
    : 'https://fastrr-api-dev.pickrr.com';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

// Accept SHOPIFY_SHOP_DOMAIN or SHOPIFY_STORE_DOMAIN; strip https:// and trailing slash.
const SHOP_DOMAIN = String(process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN || '')
  .trim()
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');

// ---------- helpers ----------
function last10(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}
function numericId(gid) {
  const m = String(gid || '').match(/(\d+)\s*$/);
  return m ? m[1] : String(gid || '');
}
function money(amount, currency) {
  const n = Number(amount);
  if (!isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR' }).format(n);
  } catch (e) {
    return (currency ? currency + ' ' : '') + n.toFixed(2);
  }
}
function pretty(s) {
  return String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ---------- Shiprocket: token -> phone (same call as customer-data.js) ----------
async function resolvePhone(customerToken) {
  const bodyString = JSON.stringify({ token: customerToken });
  const sr = await fetch(`${SHIPROCKET_BASE_URL}/api/v1/customer-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.SHIPROCKET_API_KEY },
    body: bodyString,
  });
  let data = {};
  try { data = await sr.json(); } catch (e) {}
  if (!sr.ok || data.error || !data.result) {
    console.error('Shiprocket customer-data (orders) failed', sr.status, JSON.stringify(data).slice(0, 300));
    throw new Error(typeof data.error === 'string' ? data.error : 'Could not resolve customer from Shiprocket');
  }
  return last10(data.result.phone);
}

// ---------- Shopify auth ----------
let cached = { token: null, exp: 0 };

async function getAdminToken(forceRefresh) {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  if (!forceRefresh && cached.token && Date.now() < cached.exp - 60000) return cached.token;

  const r = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SHOPIFY_CLIENT_ID || '',
      client_secret: process.env.SHOPIFY_CLIENT_SECRET || '',
      grant_type: 'client_credentials',
    }),
  });
  let d = {};
  try { d = await r.json(); } catch (e) {}
  if (!r.ok || !d.access_token) {
    console.error('Shopify token exchange failed', r.status, JSON.stringify(d).slice(0, 300));
    throw new Error('Could not authenticate with Shopify');
  }
  cached = { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 86399) * 1000 };
  return cached.token;
}

async function gql(query, variables, retried) {
  const token = await getAdminToken(!!retried);
  const r = await fetch(`https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 401 && !retried && !process.env.SHOPIFY_ADMIN_TOKEN) return gql(query, variables, true);
  let d = {};
  try { d = await r.json(); } catch (e) {}
  if (!r.ok || d.errors) {
    console.error('Shopify GraphQL failed', r.status, JSON.stringify(d.errors || d).slice(0, 600));
    throw new Error('Could not fetch orders from Shopify');
  }
  return d.data;
}

// ---------- queries ----------
const CUSTOMERS_Q = `
  query ($q: String!) {
    customers(first: 5, query: $q) { nodes { id } }
  }`;

const ORDERS_Q = `
  query ($q: String!) {
    orders(first: 50, query: $q, sortKey: PROCESSED_AT, reverse: true) {
      nodes {
        id
        name
        processedAt
        createdAt
        cancelledAt
        phone
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress { phone }
        billingAddress { phone }
        fulfillments(first: 5) { displayStatus }
        lineItems(first: 20) {
          nodes {
            title
            variantTitle
            quantity
            originalUnitPriceSet { shopMoney { amount currencyCode } }
            image { url }
          }
        }
      }
    }
  }`;

function phoneMatches(o, p10) {
  return [o.phone, o.shippingAddress && o.shippingAddress.phone, o.billingAddress && o.billingAddress.phone]
    .some((x) => last10(x) === p10);
}

async function findOrders(p10) {
  const found = new Map();

  // 1) Orders of the customer record(s) that have this phone number
  const c = await gql(CUSTOMERS_Q, { q: `phone:+91${p10} OR phone:${p10}` });
  const ids = ((c.customers && c.customers.nodes) || []).map((n) => numericId(n.id));
  if (ids.length) {
    const o = await gql(ORDERS_Q, { q: ids.map((i) => `customer_id:${i}`).join(' OR ') });
    o.orders.nodes.forEach((n) => found.set(n.id, n));
  }

  // 2) Fallback for guest orders: search the number, keep only exact phone matches
  try {
    const o2 = await gql(ORDERS_Q, { q: p10 });
    o2.orders.nodes.forEach((n) => { if (phoneMatches(n, p10)) found.set(n.id, n); });
  } catch (e) {
    // fallback is best-effort; the customer-based result above is still returned
  }

  return Array.from(found.values());
}

// ---------- map to what the dashboard expects ----------
function toDashboardOrder(n) {
  const fulfil = n.fulfillments || [];
  let status = 'Processing';
  if (n.cancelledAt) status = 'Cancelled';
  else if (fulfil.some((f) => f.displayStatus === 'DELIVERED')) status = 'Delivered';
  else if (n.displayFulfillmentStatus === 'FULFILLED') status = 'Shipped';
  else if (n.displayFulfillmentStatus === 'PARTIALLY_FULFILLED') status = 'Partially shipped';

  const when = n.processedAt || n.createdAt;
  const total = n.totalPriceSet && n.totalPriceSet.shopMoney;

  return {
    id: numericId(n.id),
    name: n.name,
    status,
    date: when
      ? new Date(when).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      : '',
    price: total ? money(total.amount, total.currencyCode) : '',
    payment_status: pretty(n.displayFinancialStatus),
    url: '#',
    items: ((n.lineItems && n.lineItems.nodes) || []).map((li) => {
      const p = li.originalUnitPriceSet && li.originalUnitPriceSet.shopMoney;
      const variant = li.variantTitle && li.variantTitle !== 'Default Title' ? ' - ' + li.variantTitle : '';
      return {
        name: (li.title || '') + variant,
        image: (li.image && li.image.url) || '',
        price: p ? money(p.amount, p.currencyCode) : '',
        qty: li.quantity,
      };
    }),
    _when: when,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://claura.in');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { customer_token } = req.body || {};
  if (!customer_token || customer_token === 'undefined' || customer_token === 'null') {
    return res.status(400).json({ error: 'Missing customer token' });
  }

  if (!SHOP_DOMAIN ||
      (!process.env.SHOPIFY_ADMIN_TOKEN && !(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET))) {
    console.error('customer-orders: missing env ->',
      'domain:', !!SHOP_DOMAIN,
      '| admin token:', !!process.env.SHOPIFY_ADMIN_TOKEN,
      '| client id:', !!process.env.SHOPIFY_CLIENT_ID,
      '| client secret:', !!process.env.SHOPIFY_CLIENT_SECRET);
    return res.status(500).json({ error: 'Orders are not configured yet' });
  }

  try {
    const phone = await resolvePhone(customer_token);
    if (!phone) return res.status(200).json({ orders: [] });

    const orders = (await findOrders(phone))
      .map(toDashboardOrder)
      .sort((a, b) => new Date(b._when) - new Date(a._when))
      .map(({ _when, ...rest }) => rest);

    console.log('customer-orders ok. orders found:', orders.length);
    return res.status(200).json({ orders });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Could not fetch orders right now' });
  }
};
