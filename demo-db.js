// Demo backend: same interface as the Supabase adapter in app.js, but everything
// lives in this browser. Used only when the page is opened with ?demo=1.
(function () {
  'use strict';
  const KEY = 'vitalpath_demo_db_v1';
  const TABLES = ['profiles', 'bp_readings', 'glucose_readings', 'medical_history', 'lab_reports', 'lab_results', 'report_files', 'share_links'];
  const files = new Map(); // path -> data URL (kept in memory; persisted when it fits)

  function load() {
    let db = null;
    try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { db = null; }
    db = db || { users: {}, session: null, tables: {}, files: {} };
    TABLES.forEach(t => { if (!Array.isArray(db.tables[t])) db.tables[t] = []; });
    Object.entries(db.files || {}).forEach(([k, v]) => files.set(k, v));
    return db;
  }
  let db = load();
  function save() {
    db.files = Object.fromEntries(files);
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { db.files = {}; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e2) { /* demo only */ } }
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());
  const me = () => db.session;
  const mine = t => db.tables[t].filter(r => r.user_id === me());
  const listeners = [];
  const emit = (ev) => listeners.forEach(cb => cb(ev, me() ? { id: me(), email: db.users[Object.keys(db.users).find(e => db.users[e].id === me())]?.email } : null));
  const fail = msg => { const e = new Error(msg); throw e; };
  const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

  window.VitalPathDemoDB = {
    mode: 'demo',
    async currentUser() {
      if (!me()) return null;
      const email = Object.keys(db.users).find(e => db.users[e].id === me());
      return { id: me(), email };
    },
    onAuth(cb) { listeners.push(cb); },
    async signIn(email, password) {
      const u = db.users[email.toLowerCase()];
      if (!u || u.password !== password) fail('Invalid login credentials');
      db.session = u.id; save(); emit('SIGNED_IN');
    },
    async signUp(email, password) {
      email = email.toLowerCase();
      if (db.users[email]) fail('User already registered');
      db.users[email] = { id: uuid(), email, password };
      db.session = db.users[email].id; save(); emit('SIGNED_IN');
      return true;
    },
    async resetPassword() { /* no email in demo */ },
    async verifyPassword(email, password) {
      const u = db.users[String(email).toLowerCase()];
      if (!u || u.password !== password) fail('Invalid login credentials');
    },
    async updatePassword(password) {
      const email = Object.keys(db.users).find(e => db.users[e].id === me());
      if (email) { db.users[email].password = password; save(); }
    },
    async signOut() { db.session = null; save(); emit('SIGNED_OUT'); return true; },
    async getProfile(uid) { return db.tables.profiles.find(p => p.id === uid) || null; },
    async saveProfile(row) {
      const i = db.tables.profiles.findIndex(p => p.id === row.id);
      if (i >= 0) db.tables.profiles[i] = { ...db.tables.profiles[i], ...row }; else db.tables.profiles.push(row);
      save(); return db.tables.profiles.find(p => p.id === row.id);
    },
    async list(table, order) {
      return mine(table).slice().sort((a, b) => String(a[order]).localeCompare(String(b[order])));
    },
    async insert(table, rows) {
      const out = rows.map(r => ({ id: uuid(), created_at: new Date().toISOString(), ...r, user_id: me() }));
      db.tables[table].push(...out); save(); return out;
    },
    async update(table, id, patch) {
      const r = db.tables[table].find(x => x.id === id && (table === 'profiles' ? x.id : x.user_id) === me());
      if (!r) fail('Not found');
      Object.assign(r, patch); save(); return r;
    },
    async remove(table, ids) {
      const set = new Set(ids);
      const gone = db.tables[table].filter(r => set.has(r.id) && r.user_id === me()).map(r => r.id);
      db.tables[table] = db.tables[table].filter(r => !(set.has(r.id) && r.user_id === me()));
      if (table === 'lab_reports') {
        const g = new Set(gone);
        db.tables.lab_results = db.tables.lab_results.filter(r => !g.has(r.report_id));
        db.tables.report_files = db.tables.report_files.filter(r => !g.has(r.report_id));
      }
      save();
    },
    async wipe() {
      mine('report_files').forEach(f => files.delete(f.path));
      TABLES.forEach(t => { db.tables[t] = db.tables[t].filter(r => (t === 'profiles' ? r.id : r.user_id) !== me()); });
      save();
    },
    async upload(path, blob) { files.set(path, await blobToDataUrl(blob)); save(); },
    async signedUrls(paths) { return Object.fromEntries(paths.map(p => [p, files.get(p) || ''])); },
    async removeFiles(paths) { paths.forEach(p => files.delete(p)); save(); },
    async sharedReport(token) {
      const s = db.tables.share_links.find(x => x.token === token && !x.revoked && new Date(x.expires_at) > new Date());
      if (!s) return null;
      const uid = s.user_id, p = db.tables.profiles.find(x => x.id === uid) || {};
      const strip = r => { const c = { ...r }; delete c.user_id; return c; };
      const inT = (t, col) => db.tables[t].filter(r => r.user_id === uid && r[col] >= s.from_at && r[col] < s.to_at)
        .sort((a, b) => a[col].localeCompare(b[col])).map(strip);
      return {
        period: { label: s.period_label, fromAt: s.from_at, toAt: s.to_at, fromDate: s.from_date, toDate: s.to_date, expiresAt: s.expires_at },
        profile: { name: p.name, age: p.age, sex: p.sex, condition: p.condition },
        bp: inT('bp_readings', 'taken_at'),
        glucose: inT('glucose_readings', 'taken_at'),
        medical: inT('medical_history', 'event_at'),
        reports: db.tables.lab_reports.filter(r => r.user_id === uid && r.report_date >= s.from_date && r.report_date <= s.to_date)
          .sort((a, b) => a.report_date.localeCompare(b.report_date))
          .map(r => ({ ...strip(r), results: db.tables.lab_results.filter(x => x.report_id === r.id).sort((a, b) => a.sort_order - b.sort_order).map(strip),
                       file_count: db.tables.report_files.filter(f => f.report_id === r.id).length }))
      };
    }
  };
})();
