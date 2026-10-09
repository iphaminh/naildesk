// Thin PostgREST client for the Dream Nails salon's Supabase project.
//
// This key is the database's master key — it must NEVER reach a browser and must
// never be committed. It is read from the environment, or from lib/secrets.json,
// which is gitignored and shipped only inside the deploy archive.
if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = require('undici').fetch;
}

let fileSecrets = {};
try { fileSecrets = require('./secrets.json'); } catch (e) { /* env-only deployments */ }

const SUPABASE_URL = process.env.SUPABASE_URL || fileSecrets.SUPABASE_URL || 'https://maqsptfpfdgcxielnnrz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || fileSecrets.SUPABASE_KEY;
if (!SUPABASE_KEY) {
  throw new Error('Supabase key missing: set SUPABASE_KEY or create cloud/lib/secrets.json');
}

const REST = `${SUPABASE_URL}/rest/v1`;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function parse(r) {
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && data.message) || (typeof data === 'string' && data) || `Supabase error ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return { data, headers: r.headers };
}

// q('customers', 'status=eq.ACTIVE&order=id.asc&limit=50', {count:true})
async function q(table, query = '', opts = {}) {
  const r = await fetch(`${REST}/${table}${query ? '?' + query : ''}`, {
    headers: headers(opts.count ? { Prefer: 'count=exact' } : {})
  });
  const { data, headers: h } = await parse(r);
  if (opts.count) {
    const range = h.get('content-range') || '';
    const total = Number(range.split('/')[1]) || 0;
    return { rows: data, total };
  }
  return data;
}

async function ins(table, rows, opts = {}) {
  const prefer = ['return=representation'];
  if (opts.ignoreDuplicates) prefer.push('resolution=ignore-duplicates');
  else if (opts.merge) prefer.push('resolution=merge-duplicates');
  const qs = opts.onConflict ? `?on_conflict=${opts.onConflict}` : '';
  const r = await fetch(`${REST}/${table}${qs}`, {
    method: 'POST',
    headers: headers({ Prefer: prefer.join(',') }),
    body: JSON.stringify(rows)
  });
  const { data } = await parse(r);
  return data;
}

async function upd(table, query, patch) {
  const r = await fetch(`${REST}/${table}?${query}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch)
  });
  const { data } = await parse(r);
  return data;
}

async function del(table, query) {
  const r = await fetch(`${REST}/${table}?${query}`, { method: 'DELETE', headers: headers() });
  await parse(r);
  return true;
}

// Upload a binary object to Supabase Storage; returns the public URL
async function uploadBinary(bucket, objectPath, buffer, contentType) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) throw new Error(`Photo upload failed: ${r.status} ${await r.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath}`;
}

// Fetch a private object's bytes. The secret key means private buckets work —
// which is the point: reference images must never have a public URL at all.
async function downloadBinary(bucket, objectPath) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) throw new Error(`Object download failed: ${r.status}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') };
}

async function deleteBinary(bucket, objectPath) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok && r.status !== 404) throw new Error(`Object delete failed: ${r.status}`);
  return true;
}

async function rpc(fn, args = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(args)
  });
  const { data } = await parse(r);
  return data;
}

module.exports = { q, ins, upd, del, rpc, uploadBinary, downloadBinary, deleteBinary, SUPABASE_URL };
