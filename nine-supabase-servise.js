// =====================================================================
//  NINE STORE · Supabase service layer (ES module)
//  Usage:  import * as N from './nine-supabase-service.js'
//  Must be served over https (Netlify, Vercel, GitHub Pages...), not file://
// =====================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export const SUPABASE_URL = 'https://sftsqpclebfluwrucgmd.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_bl2lzSULoEL2X8gCspqe0w_IFOB_k79'; // publishable key: safe in the browser, RLS protects the data
const BUCKET = 'product-images';

/* ---------- client (every request carries this browser's device id) ---------- */
export function deviceId() {
  let id = localStorage.getItem('nine_device_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('nine_device_id', id); }
  return id;
}
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { headers: { 'x-device-id': deviceId() } },
});
const ok = ({ data, error }) => { if (error) throw error; return data; };
const nn = (v) => (v === '' || v === undefined ? null : v);

/* ---------- AUTH (customers and owner) ---------- */
export const signUp = (email, password, { fullName = '', phone = '' } = {}) =>
  sb.auth.signUp({ email, password, options: { data: { full_name: fullName, phone } } }).then(ok);
export const signIn = (email, password) => sb.auth.signInWithPassword({ email, password }).then(ok);
export const signOut = () => sb.auth.signOut();
export const signOutOtherDevices = () => sb.auth.signOut({ scope: 'others' });
export const getSession = () => sb.auth.getSession().then((r) => r.data.session);
export const onAuthChange = (cb) => sb.auth.onAuthStateChange((event, session) => cb(event, session));

/* ---------- PASSWORD CHANGE BY E-MAIL (Gmail) ---------- */
// 1) sends a reset link to the account e-mail  2) the link opens your site -> event PASSWORD_RECOVERY -> updatePassword()
export const requestPasswordReset = (email, redirectTo = location.origin + location.pathname) =>
  sb.auth.resetPasswordForEmail(email, { redirectTo }).then(ok);
export const updatePassword = (newPassword) => sb.auth.updateUser({ password: newPassword }).then(ok);

/* ---------- OWNER ACCESS + DEVICES ---------- */
export const isOwnerAccount = () => sb.rpc('is_owner_account').then(ok); // right e-mail (confirmed)
export const isOwner = () => sb.rpc('is_owner').then(ok);                 // right e-mail AND this device is registered

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}
export async function registerDevice() {                // call right after a successful owner sign-in
  const { data: { user } } = await sb.auth.getUser();
  const row = { user_id: user.id, device_id: deviceId(), label: deviceLabel(), user_agent: navigator.userAgent, platform: navigator.platform || null };
  const { error } = await sb.from('owner_devices').insert(row);
  if (error && error.code !== '23505') throw error;      // 23505 = already registered
  if (error) await sb.from('owner_devices').update({ last_seen_at: new Date().toISOString(), label: row.label }).eq('device_id', row.device_id);
}
export async function listDevices() {
  const rows = ok(await sb.from('owner_devices').select('*').order('last_seen_at', { ascending: false }));
  return rows.map((d) => ({ ...d, current: d.device_id === deviceId() }));
}
export async function removeDevice(id) {                // owner removes a device; removing this one signs it out
  const { data } = await sb.from('owner_devices').select('device_id').eq('id', id).maybeSingle();
  ok(await sb.from('owner_devices').delete().eq('id', id));
  if (data && data.device_id === deviceId()) await sb.auth.signOut();
}
// Call every minute on the owner page. Returns false (and signs out) when this device was removed.
export async function heartbeat() {
  const { data, error } = await sb.from('owner_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_id', deviceId()).select('id');
  if (error || !data || !data.length) { await sb.auth.signOut(); return false; }
  return true;
}

/* ---------- PRODUCTS ---------- */
const imgUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
const mapProduct = (p) => ({
  ...p,
  images: (p.product_images || []).sort((a, b) => a.position - b.position).map((i) => ({ id: i.id, path: i.storage_path, url: imgUrl(i.storage_path) })),
});
export async function listProducts({ category, search, sort } = {}) {
  let q = sb.from('products').select('*, product_images(id, storage_path, position)');
  if (category && category !== 'All') q = q.eq('category', category);
  if (search) q = q.ilike('name', `%${search}%`);
  q = sort === 'price_asc' ? q.order('price') : sort === 'price_desc' ? q.order('price', { ascending: false }) : q.order('sort_order');
  return ok(await q).map(mapProduct);
}
export const getProduct = async (id) => mapProduct(ok(await sb.from('products').select('*, product_images(id, storage_path, position)').eq('id', id).single()));
const productRow = (p) => ({
  name: p.name, category: p.category || 'Other', price: Number(p.price), stock: Number(p.stock ?? 0),
  shape: nn(p.shape), badge: nn(p.badge), sizes: (p.sizes || []).map((s) => s.trim()).filter(Boolean), color: p.color || 'Black',
});
export async function createProduct(p, files = []) {    // shape ("type") is optional
  const row = ok(await sb.from('products').insert(productRow(p)).select().single());
  for (const f of files) await addProductImage(row.id, f);
  return getProduct(row.id);
}
export const updateProduct = (id, p) => sb.from('products').update(productRow(p)).eq('id', id).then(ok);
export const adjustStock = async (id, delta) => {
  const { stock } = ok(await sb.from('products').select('stock').eq('id', id).single());
  return sb.from('products').update({ stock: Math.max(0, stock + delta) }).eq('id', id).then(ok);
};
export const deleteProduct = async (id) => {
  const paths = ok(await sb.from('product_images').select('storage_path').eq('product_id', id)).map((i) => i.storage_path);
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  return sb.from('products').delete().eq('id', id).then(ok);
};

/* ---------- PRODUCT PHOTOS (many per product) ---------- */
function shrink(file, max = 900) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = img.width * s; c.height = img.height * s;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => resolve(b || file), 'image/jpeg', 0.85);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}
export async function addProductImage(productId, file) {
  const blob = await shrink(file), path = `${productId}/${crypto.randomUUID()}.jpg`;
  ok(await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' }));
  const { count } = await sb.from('product_images').select('id', { count: 'exact', head: true }).eq('product_id', productId);
  return ok(await sb.from('product_images').insert({ product_id: productId, storage_path: path, position: count || 0 }).select().single());
}
export async function removeProductImage(imageId) {
  const { storage_path } = ok(await sb.from('product_images').select('storage_path').eq('id', imageId).single());
  await sb.storage.from(BUCKET).remove([storage_path]);
  return sb.from('product_images').delete().eq('id', imageId).then(ok);
}
export const setImageOrder = (orderedIds) => Promise.all(orderedIds.map((id, i) => sb.from('product_images').update({ position: i }).eq('id', id)));

/* ---------- ORDERS ---------- */
// customer = {customer_name, phone, email, city, address, latitude, longitude, payment_method: 'cod'|'bank'|'card', notes}
// items    = [{product_id, size, quantity}]   (prices + stock are handled by the database)
export async function placeOrder(customer, items) {
  const rows = ok(await sb.rpc('place_order', { p_order: customer, p_items: items }));
  const r = Array.isArray(rows) ? rows[0] : rows;
  return { id: r.o_id, orderNumber: r.o_number, total: r.o_total };
}
export const listMyOrders = () => sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).then(ok);
export async function ownerListOrders({ status, search } = {}) {
  let q = sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false });
  if (status && status !== 'All') q = q.eq('status', status);
  if (search) { const s = search.replace(/[%,]/g, ''); q = q.or(`customer_name.ilike.%${s}%,phone.ilike.%${s}%,order_number.ilike.%${s}%`); }
  return ok(await q);
}
export const updateOrderStatus = (id, status) => sb.from('orders').update({ status }).eq('id', id).then(ok);
export const deleteOrder = (id) => sb.from('orders').delete().eq('id', id).then(ok);
export function subscribeOrders(cb) {                   // live updates; returns an unsubscribe function
  const ch = sb.channel('orders-live').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, cb).subscribe();
  return () => sb.removeChannel(ch);
}

/* ---------- CUSTOMERS ---------- */
export const touchVisit = () => sb.rpc('touch_visit').then(ok);
export const getMyProfile = async () => { const { data: { user } } = await sb.auth.getUser(); return ok(await sb.from('profiles').select('*').eq('id', user.id).single()); };
export const updateMyProfile = async ({ full_name, phone }) => { const { data: { user } } = await sb.auth.getUser(); return sb.from('profiles').update({ full_name, phone }).eq('id', user.id).then(ok); };
export const listAddresses = () => sb.from('addresses').select('*').order('created_at').then(ok);
export const addAddress = async (a) => { const { data: { user } } = await sb.auth.getUser(); return sb.from('addresses').insert({ ...a, user_id: user.id }).select().single().then(ok); };
export const updateAddress = (id, a) => sb.from('addresses').update(a).eq('id', id).then(ok);
export const deleteAddress = (id) => sb.from('addresses').delete().eq('id', id).then(ok);
// owner: segment = 'buyer' (bought before) | 'never_purchased' | undefined (all)
export const ownerListCustomers = (segment) => { let q = sb.from('customer_segments').select('*').order('total_spent', { ascending: false }); if (segment) q = q.eq('segment', segment); return q.then(ok); };
export const ownerGuestBuyers = () => sb.from('guest_buyers').select('*').order('total_spent', { ascending: false }).then(ok);

/* ---------- SETTINGS + DASHBOARD ---------- */
export const getSettings = () => sb.from('store_settings').select('*').eq('id', 1).single().then(ok);
export const updateSettings = (s) => sb.from('store_settings').update(s).eq('id', 1).then(ok);
export const ownerDashboard = () => sb.rpc('owner_dashboard').then(ok);
