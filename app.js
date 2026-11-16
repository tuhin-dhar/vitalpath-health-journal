// VitalPath Health Journal — multi-user app on Supabase (or the in-browser demo backend).
(function () {
'use strict';

// Read before the Supabase client is created: it consumes and clears the URL hash.
const RECOVERING = /type=recovery/.test(location.hash);

// ───────────────────────── Small helpers ─────────────────────────
const $ = id => document.getElementById(id);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const localInput = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const fmtDT = iso => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtD = ymd => parseDate(ymd).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const ms = iso => new Date(iso).getTime();
const numOrNull = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
const fmtNum = v => { const n = Number(v); return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100); };
const byTime = col => (a, b) => ms(a[col]) - ms(b[col]);

function msg(el, level, title, body) {
  $(el).innerHTML = `<div class="alert ${level}"><b>${esc(title)}</b> ${esc(body || '')}</div>`;
}
let toastTimer;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function friendly(err) {
  const m = (err && (err.message || err.error_description || err.msg)) || String(err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach the server. Check your internet connection and try again.';
  if (/Invalid login credentials/i.test(m)) return 'The email or password is not correct.';
  if (/Email not confirmed/i.test(m)) return 'Please open the confirmation email we sent you, then sign in.';
  if (/JWT expired|invalid JWT/i.test(m)) return 'Your session has expired. Please sign in again.';
  return m;
}

// ───────────────────────── Backend adapter (Supabase) ─────────────────────────
function supabaseAdapter(cfg) {
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const chk = ({ data, error }) => { if (error) throw error; return data; };
  const appUrl = () => location.origin + location.pathname;
  const BUCKET = 'reports';
  return {
    mode: 'live',
    async currentUser() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
    onAuth(cb) { sb.auth.onAuthStateChange((ev, session) => setTimeout(() => cb(ev, session ? session.user : null), 0)); },
    async signIn(email, password) { chk(await sb.auth.signInWithPassword({ email, password })); },
    async signUp(email, password) {
      const d = chk(await sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } }));
      // Supabase answers an already-registered address with an empty identity list and sends no email.
      if (d.user && Array.isArray(d.user.identities) && d.user.identities.length === 0) {
        throw new Error('An account with this email already exists. Sign in, or use “Forgot password?”.');
      }
      return !!d.session;
    },
    async resetPassword(email) { chk(await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() })); },
    async verifyPassword(email, password) { chk(await sb.auth.signInWithPassword({ email, password })); },
    async updatePassword(password) { chk(await sb.auth.updateUser({ password })); },
    async signOut() {
      const { error } = await sb.auth.signOut();
      if (error) { await sb.auth.signOut({ scope: 'local' }); return false; }
      return true;
    },
    async getProfile(uid) { return chk(await sb.from('profiles').select('*').eq('id', uid).maybeSingle()); },
    async saveProfile(row) { return chk(await sb.from('profiles').upsert(row).select().single()); },
    async list(table, order) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const page = chk(await sb.from(table).select('*').order(order, { ascending: true }).order('id').range(from, from + 999));
        out.push(...page);
        if (page.length < 1000) return out;
      }
    },
    async insert(table, rows) {
      const out = [];
      for (let i = 0; i < rows.length; i += 500) out.push(...chk(await sb.from(table).insert(rows.slice(i, i + 500)).select()));
      return out;
    },
    async update(table, id, patch) { return chk(await sb.from(table).update(patch).eq('id', id).select().single()); },
    async remove(table, ids) {
      for (let i = 0; i < ids.length; i += 200) chk(await sb.from(table).delete().in('id', ids.slice(i, i + 200)));
    },
    async wipe(uid) {
      // Remove every object in the user's folder, not only the ones report_files still points at.
      const listAll = async prefix => {
        const out = [];
        for (let offset = 0; ; offset += 100) {
          const page = chk(await sb.storage.from(BUCKET).list(prefix, { limit: 100, offset }));
          out.push(...page);
          if (page.length < 100) return out;
        }
      };
      const paths = [];
      for (const entry of await listAll(uid)) {
        if (entry.id) { paths.push(`${uid}/${entry.name}`); continue; }      // a file directly in the folder
        for (const f of await listAll(`${uid}/${entry.name}`)) if (f.id) paths.push(`${uid}/${entry.name}/${f.name}`);
      }
      const rows = await this.list('report_files', 'created_at');
      rows.forEach(r => { if (!paths.includes(r.path)) paths.push(r.path); });
      await this.removeFiles(paths);
      for (const t of ['share_links', 'lab_reports', 'bp_readings', 'glucose_readings', 'medical_history']) {
        chk(await sb.from(t).delete().eq('user_id', uid));
      }
      chk(await sb.from('profiles').delete().eq('id', uid));
    },
    async upload(path, blob, contentType) { chk(await sb.storage.from(BUCKET).upload(path, blob, { contentType, upsert: false })); },
    async signedUrls(paths) {
      if (!paths.length) return {};
      const d = chk(await sb.storage.from(BUCKET).createSignedUrls(paths, 3600));
      return Object.fromEntries(d.filter(x => x.signedUrl).map(x => [x.path, x.signedUrl]));
    },
    async removeFiles(paths) {
      for (let i = 0; i < paths.length; i += 100) chk(await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100)));
    },
    async sharedReport(token) { return chk(await sb.rpc('get_shared_report', { p_token: token })); }
  };
}

// ───────────────────────── Clinical interpretation ─────────────────────────
function bpCheck(s, d) {
  if (s > 180 || d > 120) return ['bad', 'Very high BP range', 'Repeat after at least one minute. If still very high, contact a healthcare professional urgently. With chest pain, breathlessness, weakness, vision change or speech difficulty, seek emergency help now.'];
  if (s >= 140 || d >= 90) return ['bad', 'High BP stage 2 range', 'Rest and repeat correctly. Arrange prompt clinical review if readings remain high. Do not change medication yourself.'];
  if (s >= 130 || d >= 80) return ['warn', 'High BP stage 1 range', 'Above the normal category. Track repeated readings and discuss the pattern with your clinician.'];
  if (s < 90 || d < 60) return ['warn', 'Low BP range', 'May be low, especially with dizziness or weakness. Sit or lie down safely and contact your clinician if persistent or symptomatic.'];
  if (s >= 120) return ['warn', 'Elevated BP range', 'Systolic pressure is elevated. Continue monitoring as advised.'];
  return ['good', 'Normal range', 'Within the general adult normal category. Continue monitoring as advised.'];
}
const toMgdl = (v, u) => u === 'mmol/L' ? v * 18.0182 : v;
function glCheck(v, u, t) {
  const n = toMgdl(v, u);
  if (t === 'HbA1c') {
    if (u !== '% (HbA1c)') return ['warn', 'Check HbA1c unit', 'HbA1c should be recorded as a percentage.'];
    return n >= 6.5 ? ['warn', 'Diabetes-range HbA1c', 'A laboratory HbA1c of 6.5% or above needs clinician assessment and confirmation.']
      : n >= 5.7 ? ['warn', 'Prediabetes-range HbA1c', 'Discuss this laboratory result with your clinician.']
      : ['good', 'Below prediabetes threshold', 'Interpret alongside your medical history and clinician advice.'];
  }
  if (n < 54) return ['bad', 'Clinically significant low glucose', 'Follow your hypo plan immediately. If unconscious, having a seizure or unable to swallow, seek emergency help; give nothing by mouth.'];
  if (n < 70) return ['bad', 'Low glucose', 'If awake and able to swallow, follow your clinician’s hypo plan. A common approach is 15 g fast-acting carbohydrate and recheck in 15 minutes.'];
  if (n >= 300) return ['bad', 'Very high glucose', 'Wash your hands and recheck now. If it is still this high, contact your doctor today. With vomiting, drowsiness, confusion, deep or fast breathing, severe thirst or feeling very unwell, seek emergency care now (108 / 112).'];
  if (n >= 250) return ['bad', 'High glucose — contact your doctor today', 'Recheck soon. Readings at this level need same-day advice from your clinician, especially if you feel unwell, have vomiting or are very thirsty.'];
  if (t === 'Fasting (8+ hours)') {
    if (n >= 126) return ['warn', 'Diabetes-range fasting value', 'A fasting laboratory result of 126 mg/dL or above may indicate diabetes. Home meter readings cannot diagnose it; seek laboratory confirmation.'];
    if (n >= 100) return ['warn', 'Impaired fasting glucose range', '100–125 mg/dL is the laboratory prediabetes range. Discuss repeated results with your clinician.'];
    return ['good', 'Below impaired-fasting threshold', 'Below 100 mg/dL is within the usual laboratory fasting reference range. Personal targets may differ.'];
  }
  if (t === 'Before meal') {
    if (n > 130) return ['warn', 'Above common pre-meal goal', 'Above the common 80–130 mg/dL goal for many adults with diabetes. Review repeated patterns with your clinician.'];
    if (n < 80) return ['warn', 'Below common pre-meal goal', 'Below the common target range. If below 70, follow your low-glucose plan.'];
    return ['good', 'Within common pre-meal goal', 'Within the common goal for many adults with diabetes.'];
  }
  if (t === '2 hours after meal' || t === '1 hour after meal') {
    if (n > 180) return ['warn', 'Above common post-meal goal', 'Above the common peak post-meal goal of below 180 mg/dL for many adults with diabetes. Discuss repeated readings with your clinician.'];
    return ['good', 'Within common post-meal goal', 'Below the common post-meal goal for many adults with diabetes.'];
  }
  if (n >= 200) return ['warn', 'High glucose reading', 'A result at or above 200 mg/dL can be significant, especially with symptoms. Contact your clinician for advice.'];
  return ['good', 'Recorded — consider timing', 'Interpret with meal timing, medicines and your personal target.'];
}

// Typical adult reference ranges. Labs differ; the form lets the user type their own report's range.
const LAB_PANELS = [
  { id: 'sugar', name: 'Sugar (diabetes)', tests: [
    ['hba1c', 'HbA1c', '%', 4.0, 5.6, '3-month average sugar. 5.7–6.4 prediabetes range; 6.5+ diabetes range'],
    ['fbs', 'Fasting blood sugar (FBS)', 'mg/dL', 70, 99],
    ['ppbs', 'Post-meal blood sugar (PPBS, 2 h)', 'mg/dL', 70, 139],
    ['rbs', 'Random blood sugar (RBS)', 'mg/dL', 70, 139],
    ['eag', 'Estimated average glucose (eAG)', 'mg/dL', null, null]] },
  { id: 'thyroid', name: 'Thyroid', tests: [
    ['tsh', 'TSH', 'µIU/mL', 0.4, 4.0],
    ['t3', 'Total T3', 'ng/dL', 80, 200],
    ['t4', 'Total T4', 'µg/dL', 5.0, 12.0],
    ['ft3', 'Free T3 (FT3)', 'pg/mL', 2.3, 4.2],
    ['ft4', 'Free T4 (FT4)', 'ng/dL', 0.8, 1.8]] },
  { id: 'liver', name: 'Liver function (LFT)', tests: [
    ['alt', 'SGPT / ALT', 'U/L', null, 40],
    ['ast', 'SGOT / AST', 'U/L', null, 40],
    ['alp', 'Alkaline phosphatase (ALP)', 'U/L', 44, 147],
    ['ggt', 'Gamma GT (GGT)', 'U/L', null, 55],
    ['tbil', 'Total bilirubin', 'mg/dL', 0.1, 1.2],
    ['dbil', 'Direct bilirubin', 'mg/dL', null, 0.3],
    ['alb', 'Albumin', 'g/dL', 3.5, 5.0],
    ['tp', 'Total protein', 'g/dL', 6.0, 8.3]] },
  { id: 'kidney', name: 'Kidney function (KFT)', tests: [
    ['creat', 'Creatinine', 'mg/dL', 0.6, 1.3],
    ['urea', 'Blood urea', 'mg/dL', 15, 40],
    ['bun', 'Blood urea nitrogen (BUN)', 'mg/dL', 7, 20],
    ['uric', 'Uric acid', 'mg/dL', 3.5, 7.2],
    ['egfr', 'eGFR', 'mL/min/1.73m²', 60, null]] },
  { id: 'lipid', name: 'Lipid profile (cholesterol)', tests: [
    ['tc', 'Total cholesterol', 'mg/dL', null, 199],
    ['ldl', 'LDL cholesterol', 'mg/dL', null, 99],
    ['hdl', 'HDL cholesterol', 'mg/dL', 40, null],
    ['tg', 'Triglycerides', 'mg/dL', null, 149],
    ['vldl', 'VLDL cholesterol', 'mg/dL', null, 30]] }
];
const TEST_INDEX = {};
LAB_PANELS.forEach(p => p.tests.forEach(([code, name, unit, lo, hi, hint]) => { TEST_INDEX[code] = { panel: p.id, panelName: p.name, code, name, unit, lo, hi, hint }; }));
// Tests whose usual range differs by sex. Values above in LAB_PANELS are the male ranges.
const FEMALE_RANGES = { creat: [0.5, 1.1], uric: [2.6, 6.0], hdl: [50, null] };
function defaultRange(code) {
  const t = TEST_INDEX[code], sex = S.profile && S.profile.sex;
  if (FEMALE_RANGES[code]) {
    if (sex === 'Female') return FEMALE_RANGES[code];
    if (sex !== 'Male') return [null, null];   // unknown sex: copy the range from the report
  }
  return [t.lo, t.hi];
}
const PANEL_NAME = Object.fromEntries(LAB_PANELS.map(p => [p.id, p.name]).concat([['other', 'Other tests']]));

function labFlag(r) {
  const v = Number(r.value), lo = numOrNull(r.ref_low), hi = numOrNull(r.ref_high);
  if (hi != null && v > hi) return 'HIGH';
  if (lo != null && v < lo) return 'LOW';
  return (lo != null || hi != null) ? 'Normal' : '';
}
const rangeText = r => {
  const lo = numOrNull(r.ref_low), hi = numOrNull(r.ref_high);
  if (lo != null && hi != null) return `${fmtNum(lo)}–${fmtNum(hi)}`;
  if (hi != null) return `up to ${fmtNum(hi)}`;
  if (lo != null) return `${fmtNum(lo)} or more`;
  return '';
};
const flagChip = f => f ? `<span class="chip ${esc(f)}">${esc(f)}</span>` : '';

// ───────────────────────── State ─────────────────────────
let DB = null;
const S = {
  user: null, profile: null,
  bp: [], glucose: [], medical: [], reports: [], results: [], files: [], shares: [],
  edit: { bp: null, glucose: null, medical: null, labs: null },
  pendingFiles: [], urls: {}, pendingShare: null, authMode: 'signin', entering: null, historyLimit: 60, saving: false
};

async function loadAll() {
  const [bp, glucose, medical, reports, results, files, shares] = await Promise.all([
    DB.list('bp_readings', 'taken_at'), DB.list('glucose_readings', 'taken_at'), DB.list('medical_history', 'event_at'),
    DB.list('lab_reports', 'report_date'), DB.list('lab_results', 'sort_order'), DB.list('report_files', 'created_at'),
    DB.list('share_links', 'created_at')]);
  Object.assign(S, { bp, glucose, medical, reports, results, files, shares });
}

// ───────────────────────── Auth ─────────────────────────
function setAuthMode(mode) {
  S.authMode = mode;
  const t = { signin: ['Sign in', 'Each person has a private account. Only you can see your records.', 'Sign in'],
    signup: ['Create your account', 'Use an email you can open — you may need to confirm it. Choose a password of at least 8 characters.', 'Create account'],
    reset: ['Reset your password', 'We will email you a link to choose a new password.', 'Send reset link'],
    newpass: ['Choose a new password', 'Enter a new password of at least 8 characters.', 'Save new password'] }[mode];
  $('authTitle').textContent = t[0]; $('authIntro').textContent = t[1]; $('authSubmit').textContent = t[2];
  $('authEmailWrap').hidden = mode === 'newpass';
  $('authPassWrap').hidden = mode === 'reset';
  $('authPass2Wrap').hidden = !(mode === 'signup' || mode === 'newpass');
  $('authPass').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  $('authLinks').innerHTML = mode === 'signin'
    ? '<a href="#" data-act="authMode" data-mode="signup">Create an account</a> · <a href="#" data-act="authMode" data-mode="reset">Forgot password?</a>'
    : '<a href="#" data-act="authMode" data-mode="signin">Back to sign in</a>';
  $('authMsg').innerHTML = '';
}
function showAuth() {
  $('app').hidden = true; $('profileGate').hidden = true; $('userbar').hidden = true;
  $('authGate').hidden = false;
}
async function submitAuth(e) {
  e.preventDefault();
  const email = $('authEmail').value.trim(), pass = $('authPass').value, pass2 = $('authPass2').value, mode = S.authMode;
  const btn = $('authSubmit'); btn.disabled = true;
  try {
    if (mode !== 'newpass' && !email) throw new Error('Please enter your email.');
    if ((mode === 'signup' || mode === 'newpass' || mode === 'signin') && pass.length < 8) throw new Error('The password must be at least 8 characters.');
    if ((mode === 'signup' || mode === 'newpass') && pass !== pass2) throw new Error('The two passwords do not match.');
    if (mode === 'signin') await DB.signIn(email, pass);
    else if (mode === 'signup') {
      const signedIn = await DB.signUp(email, pass);
      if (!signedIn) { msg('authMsg', 'good', 'Almost done.', 'We sent a confirmation link to ' + email + '. Open it, then sign in here.'); setTimeout(() => setAuthMode('signin'), 0); return; }
    } else if (mode === 'reset') {
      await DB.resetPassword(email);
      msg('authMsg', 'good', 'Check your email.', 'If an account exists for ' + email + ', a reset link is on its way.'); return;
    } else if (mode === 'newpass') {
      await DB.updatePassword(pass);
      history.replaceState(null, '', location.pathname + location.search);
      setAuthMode('signin'); toast('Password changed.');
      const u = await DB.currentUser(); if (u) { S.user = null; await enter(u); }
      return;
    }
  } catch (err) { msg('authMsg', 'bad', 'Could not continue.', friendly(err)); }
  finally { btn.disabled = false; }
}
async function enter(user) {
  if (S.authMode === 'newpass') return;   // keep the new-password form on screen
  if (S.user && S.user.id === user.id) return;
  if (S.entering) return S.entering;
  S.entering = (async () => {
    S.user = user;
    $('authGate').hidden = true; $('setupView').hidden = true;
    $('userbar').hidden = false; $('userEmail').textContent = user.email || '';
    try {
      $('loader').hidden = false;
      S.profile = await DB.getProfile(user.id);
      await loadAll();
    } catch (err) { S.user = null; showAuth(); msg('authMsg', 'bad', 'Could not load your records.', friendly(err)); return; }
    finally { $('loader').hidden = true; }
    if (!S.profile) { openProfile(true); return; }
    resetLabForm();   // lab reference ranges depend on the profile's sex
    $('app').hidden = false; renderAll();
  })();
  try { await S.entering; } finally { S.entering = null; }
}
// Reload so nothing from the previous user (share links, form contents, photos, files ready to share) survives.
function leave() {
  location.replace(location.pathname + location.search);
}

// ───────────────────────── Profile & contacts ─────────────────────────
function openProfile(first) {
  const p = S.profile || {};
  $('pName').value = p.name || ''; $('pAge').value = p.age || ''; $('pSex').value = p.sex || '';
  $('pHeight').value = p.height_cm ?? ''; $('pWeight').value = p.weight_kg ?? ''; $('pCondition').value = p.condition || 'Not specified';
  $('pBPTarget').value = p.bp_target || ''; $('pSugarTarget').value = p.sugar_target || '';
  $('profileMsg').innerHTML = ''; $('profileCancel').hidden = !!first;
  $('profileGate').hidden = false; $('app').hidden = true;
}
async function saveProfile() {
  const name = $('pName').value.trim(), age = Number($('pAge').value), sex = $('pSex').value;
  if (!name || !age || age < 1 || age > 120 || !sex) { msg('profileMsg', 'bad', 'Missing details.', 'Please enter your name, a valid age and sex.'); return; }
  const row = { id: S.user.id, name, age, sex, height_cm: numOrNull($('pHeight').value), weight_kg: numOrNull($('pWeight').value),
    condition: $('pCondition').value, bp_target: $('pBPTarget').value.trim(), sugar_target: $('pSugarTarget').value.trim(),
    contacts: (S.profile && S.profile.contacts) || { directory: [], ambulanceNumber: '108', nationalEmergencyNumber: '112' },
    updated_at: new Date().toISOString() };
  const sexChanged = !S.profile || S.profile.sex !== sex;
  S.profile = await DB.saveProfile(row);
  if (sexChanged && !labDirty()) resetLabForm();
  $('profileGate').hidden = true; $('app').hidden = false; renderAll();
}
function contacts() {
  const c = (S.profile && S.profile.contacts) || {};
  if (!Array.isArray(c.directory)) c.directory = [];
  return c;
}
// Copy whatever is typed in the contact cards back into memory, so a re-render or save never drops it.
function syncCareCards() {
  const c = contacts();
  c.directory.forEach((x, i) => {
    if (!$('careName' + i)) return;
    const v = id => $(id + i).value.trim();
    Object.assign(x, { kind: $('careKind' + i).value, name: v('careName'), speciality: v('careSpeciality'), phone: v('carePhone'),
      facility: v('careFacility'), address: v('careAddress'), notes: v('careNotes') });
  });
  return c;
}
async function saveContactsObj(c) {
  const clean = { ...c, directory: c.directory.filter(x => x.name) };
  S.profile = await DB.update('profiles', S.user.id, { contacts: clean, updated_at: new Date().toISOString() });
}
function loadContactsForm() {
  const c = contacts();
  $('ambulanceNumber').value = c.ambulanceNumber ?? '108';
  $('nationalEmergencyNumber').value = c.nationalEmergencyNumber ?? '112';
  $('contactNotes').value = c.contactNotes || '';
  renderCareDirectoryEditor(); $('contactResult').innerHTML = '';
}
function renderCareDirectoryEditor() {
  const list = contacts().directory, host = $('careDirectoryEditor');
  if (!list.length) { host.innerHTML = '<p class="muted">No doctors, hospitals or clinics added yet. Select “Add a contact / facility” to begin.</p>'; return; }
  const kinds = ['Doctor', 'Hospital', 'Clinic', 'Personal emergency contact', 'Other'];
  host.innerHTML = list.map((x, i) => `
  <div class="card inset">
   <div class="fields">
    <div><label for="careKind${i}">Entry type</label><select id="careKind${i}">${kinds.map(k => `<option ${x.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
    <div><label for="careName${i}">Name</label><input id="careName${i}" value="${esc(x.name)}" placeholder="Doctor / hospital / clinic name"></div>
    <div><label for="careSpeciality${i}">Speciality / department (optional)</label><input id="careSpeciality${i}" value="${esc(x.speciality)}" placeholder="e.g. Cardiologist / Emergency"></div>
    <div><label for="carePhone${i}">Phone number</label><input id="carePhone${i}" type="tel" value="${esc(x.phone)}" placeholder="Contact number"></div>
    <div><label for="careFacility${i}">Associated facility (optional)</label><input id="careFacility${i}" value="${esc(x.facility)}" placeholder="Hospital / clinic name"></div>
    <div><label for="careAddress${i}">Address / location (optional)</label><input id="careAddress${i}" value="${esc(x.address)}" placeholder="Full address or area"></div>
   </div>
   <label for="careNotes${i}">Notes (optional)</label><textarea id="careNotes${i}" placeholder="Visiting hours, department, relationship, etc.">${esc(x.notes)}</textarea>
   <div class="actions"><button class="primary" data-act="updateCareContact" data-i="${i}">Save changes</button><button class="danger" data-act="deleteCareContact" data-i="${i}">Delete entry</button></div>
  </div>`).join('');
}
function renderHomeContacts() {
  const c = contacts();
  const setNumber = (id, value) => { $(id).textContent = value || 'Not set'; $(id + 'Call').href = value ? 'tel:' + String(value).replace(/[^+0-9]/g, '') : '#'; };
  setNumber('homeAmbulance', c.ambulanceNumber || '108'); setNumber('homeEmergency', c.nationalEmergencyNumber || '112');
  const rows = c.directory.filter(x => x.name).map(x => {
    const phone = x.phone ? ` · <a href="tel:${esc(String(x.phone).replace(/[^+0-9]/g, ''))}">${esc(x.phone)}</a>` : '';
    const meta = [x.speciality, x.facility].filter(Boolean).map(esc).join(' • ');
    return `<p><b>${esc(x.kind || 'Contact')}:</b> ${esc(x.name)}${phone}${meta ? `<br><span class="muted">${meta}</span>` : ''}${x.address ? `<br><span class="muted">${esc(x.address)}</span>` : ''}${x.notes ? `<br><span class="muted">${esc(x.notes)}</span>` : ''}</p>`;
  });
  $('homeCareContacts').innerHTML = rows.length ? rows.join('') : 'No contacts added yet. Add doctors, hospitals and clinics under Profile & backup.';
  $('homeEmergencyNote').textContent = c.contactNotes ? c.contactNotes : 'Emergency numbers and instructions can be edited under Profile & backup.';
  const ec = c.directory.find(x => x.kind === 'Personal emergency contact' && x.name && x.phone);
  $('homeEmergencyContact').innerHTML = ec ? `<b>Emergency contact:</b> ${esc(ec.name)} · <a href="tel:${esc(String(ec.phone).replace(/[^+0-9]/g, ''))}">${esc(ec.phone)}</a>` : '';
}
// Turn the old app's fixed doctor/hospital fields into directory entries.
function migrateLegacyContacts(c) {
  c = { ...(c || {}) };
  if (Array.isArray(c.directory)) return c;
  const dir = [];
  [['doc1Name', 'doc1Speciality', 'doc1Phone', 'doc1Hospital'], ['doc2Name', 'doc2Speciality', 'doc2Phone', 'doc2Hospital']].forEach(a => {
    if (c[a[0]] || c[a[2]]) dir.push({ kind: 'Doctor', name: c[a[0]] || '', speciality: c[a[1]] || '', phone: c[a[2]] || '', facility: c[a[3]] || '', address: '', notes: '' });
  });
  if (c.hospitalName || c.hospitalPhone) dir.push({ kind: 'Hospital', name: c.hospitalName || '', speciality: '', phone: c.hospitalPhone || '', facility: '', address: c.hospitalAddress || '', notes: 'Preferred hospital' });
  if (c.emergencyContactName || c.emergencyContactPhone) dir.push({ kind: 'Personal emergency contact', name: c.emergencyContactName || '', speciality: '', phone: c.emergencyContactPhone || '', facility: '', address: '', notes: '' });
  c.directory = dir; return c;
}

// ───────────────────────── Rendering ─────────────────────────
const SECONDARY_PAGES = ['history', 'medical', 'share', 'settings'];
const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
// The More sheet on phones: it gets its own history entry so the phone's Back button closes it.
function openMore() {
  if (!$('moreSheet').hidden) return;
  $('moreSheet').hidden = false;
  document.documentElement.style.overflow = 'hidden';
  history.pushState({ page: (history.state && history.state.page) || 'home', sheet: true }, '');
  const first = $('moreSheet').querySelector('.tab'); if (first) first.focus();
}
// keepHistory: the caller is about to push its own entry (a page change), so just drop the sheet's entry.
function closeMore(keepHistory) {
  if ($('moreSheet').hidden) return;
  $('moreSheet').hidden = true;
  document.documentElement.style.overflow = '';
  if (history.state && history.state.sheet) {
    if (keepHistory) history.replaceState({ page: history.state.page }, '');
    else history.back();
  }
  $('moreTab').focus({ preventScroll: true });
}
function showPage(id, fromHistory) {
  if (!fromHistory && history.state) {
    // Picking a section from the open More sheet reuses the sheet's history entry, so Back returns to the previous section.
    if (history.state.sheet) history.replaceState({ page: id }, '');
    else if (history.state.page !== id) history.pushState({ page: id }, '');
  }
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('active', x.id === id));
  document.querySelectorAll('.tab[data-page]').forEach(x => {
    const on = x.dataset.page === id;
    x.classList.toggle('active', on);
    if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
  });
  const secondary = SECONDARY_PAGES.includes(id);
  $('moreTab').classList.toggle('active', secondary);
  if (secondary) $('moreTab').setAttribute('aria-current', 'page'); else $('moreTab').removeAttribute('aria-current');
  closeMore(true);
  if (id === 'history') renderHistory();
  if (id === 'labs') { renderLabList(); renderLabTrend(); }
  if (id === 'medical') renderMedicalList();
  if (id === 'settings') loadContactsForm();
  if (id === 'share') { updateExportSummary(); renderShareLinks(); }
  window.scrollTo({ top: 0, behavior: REDUCE_MOTION.matches ? 'auto' : 'smooth' });
}
const latestBy = (arr, col) => arr.reduce((a, b) => (!a || ms(b[col]) > ms(a[col])) ? b : a, null);
const gaugeColor = lvl => lvl === 'bad' ? '#b42318' : lvl === 'warn' ? '#c17b12' : '#18794e';

function renderAll() {
  renderHome(); renderHistory(); renderLabList(); renderLabTrend(); renderMedicalList(); renderShareLinks(); updateExportSummary();
}
function renderHome() {
  const p = S.profile;
  const hr = new Date().getHours();
  $('homeGreeting').textContent = (hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening') + ' 👋';
  $('homeName').textContent = p.name;
  $('homeMeta').textContent = ['Age ' + p.age, p.sex, p.condition].filter(Boolean).join(' • ');
  $('homeExtra').textContent = [p.height_cm ? 'Height ' + p.height_cm + ' cm' : '', p.weight_kg ? 'Weight ' + p.weight_kg + ' kg' : '',
    p.bp_target ? 'Doctor BP target: ' + p.bp_target : '', p.sugar_target ? 'Doctor glucose target: ' + p.sugar_target : ''].filter(Boolean).join('  |  ');
  const b = latestBy(S.bp, 'taken_at'), g = latestBy(S.glucose, 'taken_at'), parts = [];
  if (b) {
    const a = bpCheck(b.systolic, b.diastolic);
    $('bpValue').textContent = b.systolic + '/' + b.diastolic; $('bpStatus').textContent = a[1]; $('bpStatus').className = 'status ' + a[0];
    $('bpDate').textContent = fmtDT(b.taken_at); $('bpSummary').textContent = a[2];
    $('bpGauge').style.setProperty('--p', Math.min(100, b.systolic / 200 * 100)); $('bpGauge').style.setProperty('--g', gaugeColor(a[0]));
    parts.push('<b>BP:</b> ' + esc(a[2]));
  } else { $('bpValue').textContent = '—'; $('bpStatus').textContent = 'Awaiting reading'; $('bpStatus').className = 'status'; $('bpDate').textContent = 'No reading yet'; $('bpGauge').style.setProperty('--p', 0); }
  if (g) {
    const a = glCheck(Number(g.value), g.unit, g.measure_type), n = toMgdl(Number(g.value), g.unit);
    $('glucoseValue').textContent = fmtNum(g.value) + ' ' + g.unit; $('glucoseStatus').textContent = a[1]; $('glucoseStatus').className = 'status ' + a[0];
    $('glucoseDate').textContent = g.measure_type + ' • ' + fmtDT(g.taken_at); $('glucoseSummary').textContent = a[2];
    $('glucoseGauge').style.setProperty('--p', g.measure_type === 'HbA1c' ? Math.min(100, n / 12 * 100) : Math.min(100, n / 250 * 100)); $('glucoseGauge').style.setProperty('--g', gaugeColor(a[0]));
    parts.push('<b>Glucose:</b> ' + esc(a[2]));
  } else { $('glucoseValue').textContent = '—'; $('glucoseStatus').textContent = 'Awaiting reading'; $('glucoseStatus').className = 'status'; $('glucoseDate').textContent = 'No reading yet'; $('glucoseGauge').style.setProperty('--p', 0); }
  const flagged = latestLabValues().filter(x => x.flag === 'HIGH' || x.flag === 'LOW');
  if (flagged.length) parts.push('<b>Lab results outside the reference range:</b> ' + flagged.map(x => esc(x.test_name) + ' ' + esc(x.flag.toLowerCase())).join(', ') + '. Discuss these with your doctor.');
  $('homeAdvice').innerHTML = parts.length ? parts.join('<hr>') : 'Add your first BP or glucose reading to see a short interpretation.';
  const latest = latestLabValues();
  $('homeLabs').innerHTML = latest.length ? '<div class="labLatest">' + latest.map(x =>
    `<div><span class="sub">${esc(x.test_name)}</span><b>${esc(fmtNum(x.value))} <small class="sub">${esc(x.unit || '')}</small></b>${flagChip(x.flag)} <span class="sub">${esc(fmtD(x.report_date))}</span></div>`).join('') + '</div>'
    : 'Add a lab report to see HbA1c, thyroid, liver, kidney and cholesterol values here.';
  const mh = S.medical.slice().sort((a, b) => ms(b.event_at) - ms(a.event_at));
  $('homeMedicalSummary').innerHTML = mh.length ? `<b>${mh.length}</b> medical history entr${mh.length === 1 ? 'y' : 'ies'} recorded. Latest: ${esc(mh[0].event_type)} — ${esc(mh[0].reason)} (${esc(fmtD(localDate(new Date(mh[0].event_at))))}).`
    : 'No medical history entries yet. You can add surgeries, hospital admissions, consultations, tests and treatments.';
  renderHomeContacts();
}
function latestLabValues() {
  const reportDate = Object.fromEntries(S.reports.map(r => [r.id, r.report_date]));
  const best = {};
  S.results.forEach(r => {
    const d = reportDate[r.report_id]; if (!d) return;
    const key = r.test_code === 'other' ? 'other:' + r.test_name.toLowerCase() : r.test_code;
    if (!best[key] || d > best[key].report_date) best[key] = { ...r, report_date: d, flag: labFlag(r) };
  });
  const order = Object.keys(TEST_INDEX);
  return Object.entries(best).sort((a, b) => {
    const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  }).map(e => e[1]);
}

// Simple line chart on a canvas.
function drawChart(canvasId, series, xLabels, emptyText) {
  const c = $(canvasId), ctx = c.getContext('2d'), dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = c.clientWidth || c.parentElement.clientWidth || 600, h = w < 520 ? 210 : 240;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h); ctx.font = '13px system-ui, sans-serif';
  const values = series.flatMap(s => s.values).filter(v => v != null && !isNaN(v));
  if (!values.length) { ctx.fillStyle = '#617580'; ctx.font = '15px system-ui, sans-serif'; ctx.fillText(emptyText || 'No readings recorded yet', 20, 100); return; }
  let lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) { lo -= Math.max(1, Math.abs(lo) * 0.1); hi += Math.max(1, Math.abs(hi) * 0.1); }
  const L = 52, R = w - 15, T = 15, B = h - 32, n = Math.max(...series.map(s => s.values.length));
  const xAt = i => L + (R - L) * (n === 1 ? 0.5 : i / (n - 1)), yAt = v => B - (v - lo) / (hi - lo) * (B - T);
  ctx.strokeStyle = '#dce6e9'; ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = T + (B - T) * i / 4; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    ctx.fillStyle = '#617580'; const v = hi - (hi - lo) * i / 4; ctx.fillText(Math.abs(hi - lo) < 10 ? v.toFixed(1) : v.toFixed(0), 5, y + 4);
  }
  if (xLabels && xLabels.length) {
    ctx.fillStyle = '#617580';
    const idx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
    idx.forEach(i => { const t = xLabels[i] || ''; const tw = ctx.measureText(t).width; ctx.fillText(t, Math.min(R - tw, Math.max(L, xAt(i) - tw / 2)), h - 10); });
  }
  series.forEach(ss => {
    if (ss.values.length > 1) {   // soft fill under the line
      const grad = ctx.createLinearGradient(0, T, 0, B); grad.addColorStop(0, ss.color + '33'); grad.addColorStop(1, ss.color + '00');
      ctx.beginPath(); ss.values.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.lineTo(xAt(ss.values.length - 1), B); ctx.lineTo(xAt(0), B); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = ss.color; ctx.fillStyle = ss.color; ctx.lineWidth = 3; ctx.beginPath();
    ss.values.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ss.values.forEach((v, i) => { ctx.beginPath(); ctx.arc(xAt(i), yAt(v), 3.5, 0, Math.PI * 2); ctx.fill(); });
  });
}
const shortDate = iso => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

function renderHistoryCharts() {
  const bp = S.bp.slice().sort(byTime('taken_at')).slice(-30);
  drawChart('bpChart', [{ color: '#087e8b', values: bp.map(x => x.systolic) }, { color: '#d17b20', values: bp.map(x => x.diastolic) }], bp.map(x => shortDate(x.taken_at)));
  const t = $('filterType').value, gs = S.glucose.filter(x => x.measure_type === t).sort(byTime('taken_at')).slice(-30);
  drawChart('glChart', [{ color: '#087e8b', values: gs.map(x => toMgdl(Number(x.value), x.unit)) }], gs.map(x => shortDate(x.taken_at)), 'No ' + t.toLowerCase() + ' readings yet');
}
function renderHistory() {
  renderHistoryCharts();
  const all = [...S.bp.map(x => ({ at: x.taken_at, type: 'BP', value: x.systolic + '/' + x.diastolic + ' mmHg' + (x.pulse ? ' · pulse ' + x.pulse : ''), status: bpCheck(x.systolic, x.diastolic), kind: 'bp', id: x.id })),
    ...S.glucose.map(x => ({ at: x.taken_at, type: x.measure_type, value: fmtNum(x.value) + ' ' + x.unit, status: glCheck(Number(x.value), x.unit, x.measure_type), kind: 'glucose', id: x.id }))]
    .sort((a, b) => ms(b.at) - ms(a.at));
  const shown = all.slice(0, S.historyLimit);
  $('historyTable').innerHTML = all.length ? '<table><tr><th>Date/time</th><th>Type</th><th>Reading</th><th>Status</th><th>Actions</th></tr>' + shown.map(x =>
    `<tr><td>${esc(fmtDT(x.at))}</td><td>${esc(x.type)}</td><td>${esc(x.value)}</td><td class="${x.status[0]}">${esc(x.status[1])}</td><td><button class="small" data-act="editReading" data-kind="${x.kind}" data-id="${esc(x.id)}">Edit</button> <button class="small danger" data-act="deleteReading" data-kind="${x.kind}" data-id="${esc(x.id)}">Delete</button></td></tr>`).join('') + '</table>'
    + `<div class="actions"><span class="sub">Showing ${shown.length} of ${all.length}</span>${all.length > shown.length ? '<button data-act="showOlder">Show older readings</button>' : ''}</div>`
    : '<p class="muted">No readings yet.</p>';
}

// ───────────────────────── BP, glucose, medical forms ─────────────────────────
function resetBPForm() {
  S.edit.bp = null; $('bpWhen').value = localInput(); ['sys', 'dia', 'pulse', 'bpNote'].forEach(i => $(i).value = '');
  $('bpFormTitle').textContent = 'Record blood pressure'; $('bpSave').textContent = 'Save BP reading'; $('bpCancel').hidden = true;
}
async function saveBP() {
  const s = Number($('sys').value), d = Number($('dia').value);
  if (!$('bpWhen').value || !s || !d || s <= d || s > 300 || d > 200 || s < 40 || d < 20) { msg('bpResult', 'warn', 'Check entries.', 'Enter a valid date, systolic and diastolic values; systolic should be higher.'); return; }
  const pulse = numOrNull($('pulse').value);
  if (pulse != null && (pulse < 20 || pulse > 250)) { msg('bpResult', 'warn', 'Check pulse.', 'Pulse should be between 20 and 250.'); return; }
  const row = { taken_at: new Date($('bpWhen').value).toISOString(), systolic: s, diastolic: d, pulse, position: $('bpPosition').value, context: $('bpContext').value, note: $('bpNote').value.trim() };
  if (S.edit.bp) { const r = await DB.update('bp_readings', S.edit.bp, row); S.bp = S.bp.map(x => x.id === r.id ? r : x); }
  else S.bp.push(...await DB.insert('bp_readings', [row]));
  const a = bpCheck(s, d); msg('bpResult', a[0], a[1], a[2]); resetBPForm(); renderAll();
}
function resetGlucoseForm() {
  S.edit.glucose = null; $('glWhen').value = localInput(); $('glValue').value = ''; $('glNote').value = '';
  if ($('glType').value === 'HbA1c') $('glType').value = 'Fasting (8+ hours)';
  $('glUnit').value = 'mg/dL';
  $('glFormTitle').textContent = 'Record blood glucose'; $('glSave').textContent = 'Save glucose reading'; $('glCancel').hidden = true;
}
// Plausible ranges per unit; outside them the unit was almost certainly chosen wrongly.
const GL_RANGE = { 'mg/dL': [20, 600], 'mmol/L': [1.1, 33.3], '% (HbA1c)': [3, 20] };
async function saveGlucose() {
  const v = Number($('glValue').value), u = $('glUnit').value, t = $('glType').value;
  if (!$('glWhen').value || !v || v <= 0 || (t === 'HbA1c') !== (u === '% (HbA1c)')) { msg('glResult', 'warn', 'Check entries.', 'Enter a valid result and date. HbA1c uses the % unit; other types use mg/dL or mmol/L.'); return; }
  const [lo, hi] = GL_RANGE[u];
  if (v < lo || v > hi) {
    const hint = u === 'mg/dL' && v <= 33.3 ? ' Did you mean mmol/L?' : u === 'mmol/L' && v > 33.3 ? ' Did you mean mg/dL?' : '';
    msg('glResult', 'warn', 'Please check the value and unit.', `${fmtNum(v)} ${u} is outside the usual range for this unit (${lo}–${hi}).${hint}`); return;
  }
  const row = { taken_at: new Date($('glWhen').value).toISOString(), value: v, unit: u, measure_type: t, note: $('glNote').value.trim() };
  if (S.edit.glucose) { const r = await DB.update('glucose_readings', S.edit.glucose, row); S.glucose = S.glucose.map(x => x.id === r.id ? r : x); }
  else S.glucose.push(...await DB.insert('glucose_readings', [row]));
  const a = glCheck(v, u, t); msg('glResult', a[0], a[1], a[2]); resetGlucoseForm(); renderAll();
}
const filled = ids => ids.some(i => $(i).value.trim());
const bpDirty = () => !S.edit.bp && filled(['sys', 'dia', 'pulse', 'bpNote']);
const glDirty = () => !S.edit.glucose && filled(['glValue', 'glNote']);
const mhDirty = () => !S.edit.medical && filled(['mhDoctor', 'mhFacility', 'mhReason', 'mhOutcome', 'mhNotes']);
function labDirty() {
  if (!$('lrDate')) return false;
  return S.pendingFiles.length > 0 || filled(['lrLab', 'lrDoctor', 'lrNotes'])
    || [...document.querySelectorAll('#labPanels input, #otherTests input')].some(i => i.value.trim());
}
const okToDiscard = (dirty, what) => !dirty || confirm(`You have an unsaved ${what}. Discard it?`);
function editReading(kind, id) {
  if (kind === 'bp') {
    const r = S.bp.find(x => x.id === id); if (!r) return;
    if (!okToDiscard(bpDirty(), 'blood pressure reading')) return;
    S.edit.bp = id; $('bpWhen').value = localInput(new Date(r.taken_at)); $('sys').value = r.systolic; $('dia').value = r.diastolic; $('pulse').value = r.pulse ?? '';
    $('bpPosition').value = r.position || 'Seated'; $('bpContext').value = r.context || 'Routine reading'; $('bpNote').value = r.note || '';
    $('bpFormTitle').textContent = 'Edit blood pressure reading'; $('bpSave').textContent = 'Update reading'; $('bpCancel').hidden = false; $('bpResult').innerHTML = '';
    showPage('bp');
  } else {
    const r = S.glucose.find(x => x.id === id); if (!r) return;
    if (!okToDiscard(glDirty(), 'glucose reading')) return;
    S.edit.glucose = id; $('glWhen').value = localInput(new Date(r.taken_at)); $('glValue').value = r.value; $('glUnit').value = r.unit; $('glType').value = r.measure_type; $('glNote').value = r.note || '';
    $('glFormTitle').textContent = 'Edit glucose reading'; $('glSave').textContent = 'Update reading'; $('glCancel').hidden = false; $('glResult').innerHTML = '';
    showPage('glucose');
  }
}
async function deleteReading(kind, id) {
  if (!confirm('Permanently delete this reading?')) return;
  if (kind === 'bp') { await DB.remove('bp_readings', [id]); S.bp = S.bp.filter(x => x.id !== id); if (S.edit.bp === id) resetBPForm(); }
  else { await DB.remove('glucose_readings', [id]); S.glucose = S.glucose.filter(x => x.id !== id); if (S.edit.glucose === id) resetGlucoseForm(); }
  renderAll(); toast('Reading deleted.');
}
function resetMedicalForm() {
  S.edit.medical = null; ['mhDoctor', 'mhFacility', 'mhReason', 'mhOutcome', 'mhNotes'].forEach(id => $(id).value = '');
  $('mhType').value = 'Surgery / procedure'; $('mhDate').value = localInput();
  $('mhFormTitle').textContent = 'Add a medical history entry'; $('mhSave').textContent = 'Save medical history'; $('mhCancel').textContent = 'Clear form';
}
async function saveMedical() {
  const row = { event_type: $('mhType').value, event_at: $('mhDate').value ? new Date($('mhDate').value).toISOString() : '', doctor: $('mhDoctor').value.trim(),
    facility: $('mhFacility').value.trim(), reason: $('mhReason').value.trim(), outcome: $('mhOutcome').value.trim(), notes: $('mhNotes').value.trim() };
  if (!row.event_at || !row.reason) { msg('mhResult', 'warn', 'Required details missing.', 'Please enter the date and a brief reason, diagnosis or procedure.'); return; }
  if (S.edit.medical) { const r = await DB.update('medical_history', S.edit.medical, row); S.medical = S.medical.map(x => x.id === r.id ? r : x); }
  else S.medical.push(...await DB.insert('medical_history', [row]));
  msg('mhResult', 'good', 'Saved.', 'Your medical history entry has been recorded.'); resetMedicalForm(); renderAll();
}
function renderMedicalList() {
  const list = S.medical.slice().sort((a, b) => ms(b.event_at) - ms(a.event_at));
  $('medicalHistoryList').innerHTML = list.length ? list.map(x => `<div class="card inset">
   <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>${esc(x.event_type)}</b><span class="muted">${esc(fmtDT(x.event_at))}</span></div>
   <p><b>${esc(x.reason)}</b></p>
   ${x.doctor ? '<p>Doctor: ' + esc(x.doctor) + '</p>' : ''}${x.facility ? '<p>Hospital / clinic: ' + esc(x.facility) + '</p>' : ''}
   ${x.outcome ? '<p>Outcome / treatment: ' + esc(x.outcome) + '</p>' : ''}${x.notes ? '<p>Notes: ' + esc(x.notes) + '</p>' : ''}
   <div class="actions"><button class="small" data-act="editMedical" data-id="${esc(x.id)}">Edit</button><button class="small danger" data-act="deleteMedical" data-id="${esc(x.id)}">Delete</button></div>
  </div>`).join('') : '<p class="muted">No medical history entries have been added yet.</p>';
}
function editMedical(id) {
  const x = S.medical.find(r => r.id === id); if (!x) return;
  if (!okToDiscard(mhDirty(), 'medical history entry')) return;
  S.edit.medical = id; $('mhType').value = x.event_type; $('mhDate').value = localInput(new Date(x.event_at)); $('mhDoctor').value = x.doctor || '';
  $('mhFacility').value = x.facility || ''; $('mhReason').value = x.reason || ''; $('mhOutcome').value = x.outcome || ''; $('mhNotes').value = x.notes || '';
  $('mhFormTitle').textContent = 'Edit medical history entry'; $('mhSave').textContent = 'Update entry'; $('mhCancel').textContent = 'Cancel editing'; $('mhResult').innerHTML = '';
  showPage('medical');
}
async function deleteMedical(id) {
  if (!confirm('Permanently delete this medical history entry?')) return;
  await DB.remove('medical_history', [id]); S.medical = S.medical.filter(x => x.id !== id);
  if (S.edit.medical === id) resetMedicalForm();
  renderAll(); toast('Entry deleted.');
}

// ───────────────────────── Lab reports ─────────────────────────
function renderLabForm() {
  $('labPanels').innerHTML = LAB_PANELS.map(p => `<details class="panel" data-panel="${p.id}"><summary>${esc(p.name)}</summary><div class="body">` +
    p.tests.map(([code, name, unit, , , hint]) => { const [lo, hi] = defaultRange(code); return `<div class="testRow">
      <div class="tname">${esc(name)}${hint ? `<small>${esc(hint)}</small>` : ''}</div>
      <div><input id="lt_${code}_v" type="number" inputmode="decimal" step="any" placeholder="Result (${esc(unit)})" aria-label="${esc(name)} result in ${esc(unit)}"></div>
      <div class="range"><input id="lt_${code}_lo" type="number" step="any" placeholder="${lo ?? 'low'}" aria-label="${esc(name)} reference low"><span>–</span><input id="lt_${code}_hi" type="number" step="any" placeholder="${hi ?? 'high'}" aria-label="${esc(name)} reference high"><span>${esc(unit)}</span></div>
    </div>`; }).join('') + '</div></details>').join('');
}
function addOtherTestRow(r = {}) {
  const div = document.createElement('div');
  div.className = 'testRow otherRow';
  div.innerHTML = `<div><input class="o_name" placeholder="Test name" value="${esc(r.test_name || '')}" aria-label="Test name"></div>
    <div style="display:flex;gap:4px"><input class="o_val" type="number" step="any" placeholder="Result" value="${esc(r.value ?? '')}" aria-label="Result"><input class="o_unit" placeholder="Unit" value="${esc(r.unit || '')}" aria-label="Unit"></div>
    <div class="range"><input class="o_lo" type="number" step="any" placeholder="low" value="${esc(r.ref_low ?? '')}" aria-label="Reference low"><span>–</span><input class="o_hi" type="number" step="any" placeholder="high" value="${esc(r.ref_high ?? '')}" aria-label="Reference high"><button class="small danger" data-act="removeOtherTest" title="Remove">✕</button></div>`;
  $('otherTests').appendChild(div);
}
function resetLabForm() {
  S.edit.labs = null; S.pendingFiles.forEach(p => URL.revokeObjectURL(p.url)); S.pendingFiles = [];
  $('lrDate').value = localDate(); ['lrLab', 'lrDoctor', 'lrNotes'].forEach(i => $(i).value = ''); $('lrFiles').value = '';
  renderLabForm(); $('otherTests').innerHTML = ''; $('otherPanel').open = false;
  $('labFormTitle').textContent = 'Add a lab report'; $('lrSave').textContent = 'Save lab report'; $('lrCancel').hidden = true;
  renderPendingFiles(); $('lrExisting').innerHTML = '';
}
function collectLabResults() {
  const out = []; let order = 0;
  LAB_PANELS.forEach(p => p.tests.forEach(([code, name, unit]) => {
    const v = numOrNull($(`lt_${code}_v`).value); if (v == null) return;
    const l = numOrNull($(`lt_${code}_lo`).value), h = numOrNull($(`lt_${code}_hi`).value);
    // The typical range applies only when both bounds are left blank; a typed bound is used exactly as typed.
    const [lo, hi] = (l == null && h == null) ? defaultRange(code) : [l, h];
    out.push({ panel: p.id, test_code: code, test_name: name, value: v, unit, ref_low: lo, ref_high: hi, sort_order: order++ });
  }));
  document.querySelectorAll('#otherTests .otherRow').forEach(row => {
    const name = row.querySelector('.o_name').value.trim(), v = numOrNull(row.querySelector('.o_val').value);
    if (!name || v == null) return;
    out.push({ panel: 'other', test_code: 'other', test_name: name, value: v, unit: row.querySelector('.o_unit').value.trim(),
      ref_low: numOrNull(row.querySelector('.o_lo').value), ref_high: numOrNull(row.querySelector('.o_hi').value), sort_order: 1000 + order++ });
  });
  return out;
}
function renderPendingFiles() {
  $('lrPending').innerHTML = S.pendingFiles.map((p, i) => `<div class="thumb">${p.file.type.startsWith('image/') ? `<img src="${esc(p.url)}" alt="${esc(p.file.name)}">` : `PDF<br>${esc(p.file.name.slice(0, 20))}`}<button class="danger" data-act="removePending" data-i="${i}" title="Remove">✕</button></div>`).join('');
}
function addPendingFiles(list) {
  for (const f of list) {
    if (!(f.type.startsWith('image/') || f.type === 'application/pdf')) { toast(f.name + ' is not a photo or PDF.'); continue; }
    if (f.type === 'application/pdf' && f.size > 10 * 1024 * 1024) { toast(f.name + ' is larger than 10 MB.'); continue; }
    S.pendingFiles.push({ file: f, url: URL.createObjectURL(f) });
  }
  $('lrFiles').value = ''; renderPendingFiles();
}
function loadImage(src) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('Could not read image')); img.src = src; });
}
// Must match allowed_mime_types of the "reports" bucket in supabase/schema.sql.
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
async function prepareUpload(file) {
  if (file.type === 'application/pdf') return { blob: file, mime: 'application/pdf', ext: 'pdf' };
  try {
    const url = URL.createObjectURL(file), img = await loadImage(url); URL.revokeObjectURL(url);
    const k = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    if (blob && blob.size < file.size * 1.1) return { blob, mime: 'image/jpeg', ext: 'jpg' };
  } catch (e) { /* fall back to the original file */ }
  if (file.size > 10 * 1024 * 1024) throw new Error(file.name + ' is larger than 10 MB.');
  if (!UPLOAD_TYPES.includes(file.type)) throw new Error('this photo format cannot be stored — please save it as JPEG or PNG and attach it again');
  return { blob: file, mime: file.type, ext: (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') };
}
async function saveLabReport() {
  const date = $('lrDate').value;
  if (!date) { msg('lrResult', 'warn', 'Report date missing.', 'Please enter the date printed on the report.'); return; }
  const results = collectLabResults();
  const existingFiles = S.edit.labs ? S.files.filter(f => f.report_id === S.edit.labs).length : 0;
  if (!results.length && !S.pendingFiles.length && !existingFiles) { msg('lrResult', 'warn', 'Nothing to save.', 'Type in at least one result or attach a photo of the report.'); return; }
  const meta = { report_date: date, lab_name: $('lrLab').value.trim(), doctor: $('lrDoctor').value.trim(), notes: $('lrNotes').value.trim() };
  const pending = S.pendingFiles.slice();   // snapshot: the form may be changed while uploads run
  msg('lrResult', '', 'Saving…', pending.length ? 'Uploading ' + pending.length + ' file(s). Keep this page open.' : '');
  S.saving = true;
  const failed = [];
  try {
    let report;
    if (S.edit.labs) {
      report = await DB.update('lab_reports', S.edit.labs, meta);
      S.reports = S.reports.map(r => r.id === report.id ? report : r);
      // Insert the new results first and delete the old ones only afterwards, so a failure never loses results.
      const old = S.results.filter(r => r.report_id === report.id).map(r => r.id);
      const added = results.length ? await DB.insert('lab_results', results.map(r => ({ ...r, report_id: report.id }))) : [];
      if (old.length) await DB.remove('lab_results', old);
      S.results = S.results.filter(r => r.report_id !== report.id).concat(added);
    } else {
      [report] = await DB.insert('lab_reports', [meta]); S.reports.push(report);
      S.edit.labs = report.id;   // a retry after a later failure updates this report instead of making a duplicate
      $('labFormTitle').textContent = 'Edit lab report'; $('lrSave').textContent = 'Update lab report'; $('lrCancel').hidden = false;
      if (results.length) S.results.push(...await DB.insert('lab_results', results.map(r => ({ ...r, report_id: report.id }))));
    }
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i].file;
      let path = null;
      try {
        const up = await prepareUpload(f);
        path = `${S.user.id}/${report.id}/${Date.now()}-${i}.${up.ext}`;
        await DB.upload(path, up.blob, up.mime);
        S.files.push(...await DB.insert('report_files', [{ report_id: report.id, path, file_name: f.name, mime: up.mime, size_bytes: up.blob.size }]));
      } catch (err) {
        if (path) { try { await DB.removeFiles([path]); } catch (e) { /* best effort */ } }
        failed.push(f.name + ' (' + friendly(err) + ')');
      }
    }
  } finally { S.saving = false; }
  resetLabForm(); renderAll();
  const flags = results.filter(r => ['HIGH', 'LOW'].includes(labFlag(r)));
  if (failed.length) msg('lrResult', 'warn', 'Report saved, but some files did not upload:', failed.join('; ') + '. Open the report with Edit and attach them again.');
  else msg('lrResult', flags.length ? 'warn' : 'good', 'Lab report saved.', flags.length ? 'Outside the reference range: ' + flags.map(r => r.test_name + ' ' + labFlag(r).toLowerCase()).join(', ') + '. Discuss these with your doctor.' : results.length ? 'All entered results are within the reference ranges used.' : '');
}
async function ensureUrls(paths) {
  const need = paths.filter(p => !S.urls[p] || S.urls[p].exp < Date.now());
  if (need.length) {
    const got = await DB.signedUrls(need);
    Object.entries(got).forEach(([p, url]) => { S.urls[p] = { url, exp: Date.now() + 50 * 60 * 1000 }; });
  }
  return Object.fromEntries(paths.map(p => [p, S.urls[p] ? S.urls[p].url : '']));
}
function fileTiles(files, urls, removable) {
  return files.map(f => {
    const url = urls[f.path] || '';
    const del = removable ? `<button class="danger" data-act="deleteFile" data-id="${esc(f.id)}" title="Delete file">✕</button>` : '';
    if ((f.mime || '').startsWith('image/') && f.mime !== 'image/heic') return `<div class="thumb"><img src="${esc(url)}" alt="${esc(f.file_name || 'Report photo')}" data-act="openImage" data-src="${esc(url)}" loading="lazy">${del}</div>`;
    return `<div class="thumb"><a href="${esc(url)}" target="_blank" rel="noopener">${(f.mime || '').includes('pdf') ? 'PDF' : 'File'}<br>${esc((f.file_name || '').slice(0, 20))}</a>${del}</div>`;
  }).join('');
}
async function renderLabList() {
  const host = $('labReportList');
  const list = S.reports.slice().sort((a, b) => b.report_date.localeCompare(a.report_date));
  if (!list.length) { host.innerHTML = '<p class="muted">No lab reports yet.</p>'; return; }
  const draw = urls => {
    host.innerHTML = list.map(r => {
      const res = S.results.filter(x => x.report_id === r.id).sort((a, b) => a.sort_order - b.sort_order);
      const files = S.files.filter(f => f.report_id === r.id);
      return `<div class="card inset">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>${esc(fmtD(r.report_date))}${r.lab_name ? ' — ' + esc(r.lab_name) : ''}</b><span class="muted">${res.length} result${res.length === 1 ? '' : 's'} · ${files.length} file${files.length === 1 ? '' : 's'}</span></div>
        ${r.doctor ? `<div class="sub">Referred by ${esc(r.doctor)}</div>` : ''}
        ${res.length ? `<div class="scroll"><table><tr><th>Test</th><th>Result</th><th>Reference</th><th>Flag</th></tr>${res.map(x => `<tr><td>${esc(x.test_name)}<br><span class="sub">${esc(PANEL_NAME[x.panel] || '')}</span></td><td><b>${esc(fmtNum(x.value))}</b> ${esc(x.unit || '')}</td><td>${esc(rangeText(x))}</td><td>${flagChip(labFlag(x))}</td></tr>`).join('')}</table></div>` : ''}
        ${files.length ? `<div class="thumbs">${fileTiles(files, urls, false)}</div>` : ''}
        ${r.notes ? `<p class="muted">${esc(r.notes)}</p>` : ''}
        <div class="actions"><button class="small" data-act="editLabReport" data-id="${esc(r.id)}">Edit</button><button class="small danger" data-act="deleteLabReport" data-id="${esc(r.id)}">Delete report</button></div>
      </div>`;
    }).join('');
  };
  draw({});
  const paths = S.files.map(f => f.path);
  if (paths.length) { try { draw(await ensureUrls(paths)); } catch (e) { /* tiles stay without previews */ } }
}
async function editLabReport(id) {
  const r = S.reports.find(x => x.id === id); if (!r) return;
  if (S.saving) { toast('Please wait until the current report has finished saving.'); return; }
  if (!okToDiscard(S.edit.labs ? S.pendingFiles.length > 0 : labDirty(), 'lab report')) return;
  resetLabForm(); S.edit.labs = id;
  $('lrDate').value = r.report_date; $('lrLab').value = r.lab_name || ''; $('lrDoctor').value = r.doctor || ''; $('lrNotes').value = r.notes || '';
  S.results.filter(x => x.report_id === id).sort((a, b) => a.sort_order - b.sort_order).forEach(x => {
    if (x.test_code !== 'other' && TEST_INDEX[x.test_code]) {
      $(`lt_${x.test_code}_v`).value = x.value; $(`lt_${x.test_code}_lo`).value = x.ref_low ?? ''; $(`lt_${x.test_code}_hi`).value = x.ref_high ?? '';
      document.querySelector(`details[data-panel="${TEST_INDEX[x.test_code].panel}"]`).open = true;
    } else { addOtherTestRow(x); $('otherPanel').open = true; }
  });
  $('labFormTitle').textContent = 'Edit lab report'; $('lrSave').textContent = 'Update lab report'; $('lrCancel').hidden = false; $('lrResult').innerHTML = '';
  await renderExistingFiles();
  showPage('labs');
}
async function renderExistingFiles() {
  const files = S.files.filter(f => f.report_id === S.edit.labs);
  if (!files.length) { $('lrExisting').innerHTML = ''; return; }
  let urls = {}; try { urls = await ensureUrls(files.map(f => f.path)); } catch (e) { /* no previews */ }
  $('lrExisting').innerHTML = fileTiles(files, urls, true);
}
async function deleteFile(id) {
  const f = S.files.find(x => x.id === id); if (!f || !confirm('Delete this file from the report?')) return;
  await DB.removeFiles([f.path]); await DB.remove('report_files', [id]);
  S.files = S.files.filter(x => x.id !== id); await renderExistingFiles(); renderLabList(); toast('File deleted.');
}
async function deleteLabReport(id) {
  if (!confirm('Permanently delete this lab report, its results and its photos?')) return;
  const files = S.files.filter(f => f.report_id === id);
  await DB.removeFiles(files.map(f => f.path));
  await DB.remove('lab_reports', [id]);
  S.reports = S.reports.filter(r => r.id !== id); S.results = S.results.filter(r => r.report_id !== id); S.files = S.files.filter(f => f.report_id !== id);
  if (S.edit.labs === id) resetLabForm();
  renderAll(); toast('Lab report deleted.');
}
function renderLabTrend() {
  const sel = $('labTrendTest'), keep = sel.value;
  const tests = {};
  S.results.forEach(r => { const k = r.test_code === 'other' ? 'other:' + r.test_name : r.test_code; tests[k] = tests[k] || { label: r.test_name + (r.unit ? ' (' + r.unit + ')' : ''), n: 0 }; tests[k].n++; });
  const keys = Object.keys(tests).sort((a, b) => { const o = Object.keys(TEST_INDEX); return ((o.indexOf(a) + 1) || 999) - ((o.indexOf(b) + 1) || 999); });
  sel.innerHTML = keys.length ? keys.map(k => `<option value="${esc(k)}">${esc(tests[k].label)} — ${tests[k].n} result${tests[k].n === 1 ? '' : 's'}</option>`).join('') : '<option value="">No lab results yet</option>';
  if (keys.includes(keep)) sel.value = keep;
  const k = sel.value, dates = Object.fromEntries(S.reports.map(r => [r.id, r.report_date]));
  const pts = S.results.filter(r => (r.test_code === 'other' ? 'other:' + r.test_name : r.test_code) === k && dates[r.report_id])
    .map(r => ({ d: dates[r.report_id], v: Number(r.value), r })).sort((a, b) => a.d.localeCompare(b.d));
  drawChart('labChart', [{ color: '#087e8b', values: pts.map(p => p.v) }], pts.map(p => fmtD(p.d)), 'No lab results yet');
  const last = pts[pts.length - 1];
  $('labTrendNote').textContent = last ? `Latest ${fmtNum(last.v)} on ${fmtD(last.d)}${rangeText(last.r) ? ' · reference ' + rangeText(last.r) : ''}${labFlag(last.r) ? ' · ' + labFlag(last.r) : ''}` : '';
}

// ───────────────────────── Periods & datasets for export ─────────────────────────
function currentPeriod() {
  const kind = $('exKind').value; let from, to, label;
  if (kind === 'day') {
    if (!$('exDay').value) return null;
    from = parseDate($('exDay').value); to = addDays(from, 1); label = 'Daily report — ' + fmtD(localDate(from));
  } else if (kind === 'week') {
    if (!$('exDay').value) return null;
    const d = parseDate($('exDay').value); from = addDays(d, -((d.getDay() + 6) % 7)); to = addDays(from, 7);
    label = 'Weekly report — ' + fmtD(localDate(from)) + ' to ' + fmtD(localDate(addDays(to, -1)));
  } else if (kind === 'month') {
    if (!$('exMonth').value) return null;
    const [y, m] = $('exMonth').value.split('-').map(Number); from = new Date(y, m - 1, 1); to = new Date(y, m, 1);
    label = 'Monthly report — ' + from.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  } else {
    if (!$('exFrom').value || !$('exTo').value) return null;
    from = parseDate($('exFrom').value); to = addDays(parseDate($('exTo').value), 1);
    if (to <= from) return null;
    label = 'Report — ' + fmtD(localDate(from)) + ' to ' + fmtD(localDate(addDays(to, -1)));
  }
  return { kind, label, fromAt: from.toISOString(), toAt: to.toISOString(), fromDate: localDate(from), toDate: localDate(addDays(to, -1)) };
}
function ownDataset(period) {
  const a = ms(period.fromAt), b = ms(period.toAt), inR = iso => { const t = ms(iso); return t >= a && t < b; };
  const p = S.profile || {};
  return {
    period, profile: { name: p.name, age: p.age, sex: p.sex, condition: p.condition },
    bp: S.bp.filter(x => inR(x.taken_at)).sort(byTime('taken_at')),
    glucose: S.glucose.filter(x => inR(x.taken_at)).sort(byTime('taken_at')),
    medical: S.medical.filter(x => inR(x.event_at)).sort(byTime('event_at')),
    reports: S.reports.filter(r => r.report_date >= period.fromDate && r.report_date <= period.toDate).sort((x, y) => x.report_date.localeCompare(y.report_date))
      .map(r => ({ ...r, results: S.results.filter(x => x.report_id === r.id).sort((x, y) => x.sort_order - y.sort_order), files: S.files.filter(f => f.report_id === r.id), file_count: S.files.filter(f => f.report_id === r.id).length }))
  };
}
function datasetCounts(ds) {
  const res = ds.reports.reduce((n, r) => n + r.results.length, 0), files = ds.reports.reduce((n, r) => n + (r.file_count || 0), 0);
  return `${ds.bp.length} BP reading${ds.bp.length === 1 ? '' : 's'}, ${ds.glucose.length} glucose reading${ds.glucose.length === 1 ? '' : 's'}, ${ds.reports.length} lab report${ds.reports.length === 1 ? '' : 's'} (${res} result${res === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}), ${ds.medical.length} medical history entr${ds.medical.length === 1 ? 'y' : 'ies'}`;
}
function updateExportSummary() {
  const k = $('exKind').value;
  $('exDayWrap').hidden = !(k === 'day' || k === 'week'); $('exMonthWrap').hidden = k !== 'month';
  $('exFromWrap').hidden = k !== 'custom'; $('exToWrap').hidden = k !== 'custom';
  const p = currentPeriod();
  $('exSummary').innerHTML = p ? `<b>${esc(p.label)}</b><br>${esc(datasetCounts(ownDataset(p)))}` : 'Choose the dates for the report.';
}
function bpStats(bp) {
  if (!bp.length) return null;
  const avg = k => Math.round(bp.reduce((s, x) => s + Number(x[k]), 0) / bp.length);
  const hi = bp.reduce((a, b) => b.systolic > a.systolic ? b : a), lo = bp.reduce((a, b) => b.systolic < a.systolic ? b : a);
  const raised = bp.filter(x => x.systolic >= 130 || x.diastolic >= 80).length;
  const pulses = bp.map(x => Number(x.pulse)).filter(Boolean);
  return { n: bp.length, avg: avg('systolic') + '/' + avg('diastolic'), hi: hi.systolic + '/' + hi.diastolic, lo: lo.systolic + '/' + lo.diastolic, raised,
    pulse: pulses.length ? Math.round(pulses.reduce((s, x) => s + x, 0) / pulses.length) : null };
}
function glucoseStats(gl) {
  const groups = {};
  gl.forEach(x => { const k = x.measure_type + '|' + x.unit; (groups[k] = groups[k] || []).push(Number(x.value)); });
  return Object.entries(groups).map(([k, v]) => { const [type, unit] = k.split('|');
    return { type, unit, n: v.length, avg: fmtNum(v.reduce((s, x) => s + x, 0) / v.length), min: fmtNum(Math.min(...v)), max: fmtNum(Math.max(...v)) }; });
}
const fileSafe = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'report';
function fileBase(ds) {
  const p = ds.period;
  return `VitalPath_${fileSafe(ds.profile && ds.profile.name)}_${p.fromDate}${p.fromDate !== p.toDate ? '_to_' + p.toDate : ''}`;
}

// ───────────────────────── CSV ─────────────────────────
function buildCSV(ds) {
  const rows = [['date_time', 'category', 'item', 'value', 'unit', 'status_or_flag', 'reference_range', 'details']];
  ds.bp.forEach(x => rows.push([fmtDT(x.taken_at), 'Blood pressure', 'Systolic/Diastolic', x.systolic + '/' + x.diastolic, 'mmHg', bpCheck(x.systolic, x.diastolic)[1], '',
    [x.pulse ? 'Pulse ' + x.pulse : '', x.position, x.context, x.note].filter(Boolean).join('; ')]));
  ds.glucose.forEach(x => rows.push([fmtDT(x.taken_at), 'Blood glucose', x.measure_type, fmtNum(x.value), x.unit, glCheck(Number(x.value), x.unit, x.measure_type)[1], '', x.note || '']));
  ds.reports.forEach(r => r.results.forEach(x => rows.push([fmtD(r.report_date), 'Lab: ' + (PANEL_NAME[x.panel] || x.panel), x.test_name, fmtNum(x.value), x.unit || '', labFlag(x), rangeText(x),
    [r.lab_name, r.doctor ? 'Dr ' + r.doctor : ''].filter(Boolean).join('; ')])));
  ds.medical.forEach(x => rows.push([fmtDT(x.event_at), 'Medical history', x.event_type, x.reason, '', '', '',
    [x.doctor ? 'Doctor: ' + x.doctor : '', x.facility ? 'Facility: ' + x.facility : '', x.outcome ? 'Outcome: ' + x.outcome : '', x.notes].filter(Boolean).join('; ')]));
  const head = [['VitalPath Health Journal'], [ds.period.label], ['Name: ' + (ds.profile.name || '') + ' | Age ' + (ds.profile.age || '') + ' | ' + (ds.profile.sex || '')], []];
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  return '﻿' + head.concat(rows).map(r => r.map(cell).join(',')).join('\r\n');
}

// ───────────────────────── PDF ─────────────────────────
// The built-in PDF fonts cover Latin-1 only, so swap anything else for a close ASCII form.
const pdfText = s => String(s ?? '').replace(/[   ]/g, ' ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, '-').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/…/g, '...').replace(/[^\x00-\xFF]/g, '?');
async function imageForPdf(url) {
  const blob = await (await fetch(url)).blob();
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  const img = await loadImage(dataUrl);
  return { dataUrl, w: img.naturalWidth, h: img.naturalHeight, fmt: blob.type.includes('png') ? 'PNG' : 'JPEG' };
}
async function buildPDF(ds, withPhotos) {
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('The PDF tool did not load. Check your internet connection and reload the page.');
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 14, navy = [18, 63, 84];
  const p = ds.profile || {};
  // Cell text → colour level, filled from what bpCheck/glCheck/labFlag return, so every category is coloured.
  const LEVEL = { HIGH: 'bad', LOW: 'warn', Normal: 'good' };
  const cat = a => { LEVEL[pdfText(a[1])] = a[0]; return a[1]; };
  doc.setFillColor(...navy); doc.rect(0, 0, W, 28, 'F');
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text('VitalPath Health Journal', M, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(pdfText(ds.period.label), M, 19);
  doc.setFontSize(8); doc.text(pdfText('Generated ' + new Date().toLocaleString('en-IN')), W - M, 19, { align: 'right' });
  doc.setTextColor(23, 47, 61); doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text(pdfText(p.name || ''), M, 37);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
  doc.text(pdfText([p.age ? 'Age ' + p.age : '', p.sex, p.condition && p.condition !== 'Not specified' ? p.condition : ''].filter(Boolean).join('  |  ')), M, 43);
  let y = 50;
  const table = (title, head, body, opts = {}) => {
    if (y > 260) { doc.addPage(); y = 18; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(22, 56, 74); doc.text(pdfText(title), M, y); y += 2;
    doc.autoTable({ startY: y, head: [head.map(pdfText)], body: body.map(r => r.map(pdfText)), theme: 'grid', margin: { left: M, right: M },
      styles: { fontSize: 8.5, cellPadding: 1.8, textColor: [23, 47, 61], lineColor: [220, 231, 234] }, headStyles: { fillColor: navy, textColor: 255 },
      didParseCell: d => { if (d.section === 'body') { const lvl = LEVEL[pdfText(d.cell.raw)]; if (lvl === 'bad') d.cell.styles.textColor = [180, 35, 24]; else if (lvl === 'warn') d.cell.styles.textColor = [155, 98, 0]; else if (lvl === 'good') d.cell.styles.textColor = [24, 121, 78]; } },
      ...opts });
    y = doc.lastAutoTable.finalY + 8;
  };
  // Summary
  const sum = [];
  const bs = bpStats(ds.bp);
  if (bs) sum.push(['Blood pressure', `${bs.n} reading${bs.n === 1 ? '' : 's'}`, `Average ${bs.avg} mmHg`, `Highest ${bs.hi}, lowest ${bs.lo}`, `${bs.raised} at or above 130/80${bs.pulse ? '; avg pulse ' + bs.pulse : ''}`]);
  glucoseStats(ds.glucose).forEach(g => sum.push(['Glucose: ' + g.type, `${g.n} reading${g.n === 1 ? '' : 's'}`, `Average ${g.avg} ${g.unit}`, `Range ${g.min}-${g.max}`, '']));
  const labLatest = {};
  ds.reports.forEach(r => r.results.forEach(x => { labLatest[x.test_code === 'other' ? 'o:' + x.test_name : x.test_code] = { ...x, d: r.report_date }; }));
  const flagged = Object.values(labLatest).filter(x => ['HIGH', 'LOW'].includes(labFlag(x)));
  if (ds.reports.length) sum.push(['Lab reports', `${ds.reports.length} report${ds.reports.length === 1 ? '' : 's'}`, `${Object.keys(labLatest).length} tests`, flagged.length ? 'Outside range: ' + flagged.map(x => x.test_name + ' ' + labFlag(x)).join(', ') : 'All within the ranges used', '']);
  if (ds.medical.length) sum.push(['Medical history', `${ds.medical.length} entr${ds.medical.length === 1 ? 'y' : 'ies'}`, '', '', '']);
  table('Summary', ['Area', 'Count', 'Average', 'Range / notes', ''], sum.length ? sum : [['No records in this period', '', '', '', '']]);
  if (ds.bp.length) table('Blood pressure readings', ['Date / time', 'Reading (mmHg)', 'Pulse', 'Position / context', 'Category', 'Note'],
    ds.bp.map(x => [fmtDT(x.taken_at), x.systolic + '/' + x.diastolic, x.pulse || '', [x.position, x.context].filter(Boolean).join(', '), cat(bpCheck(x.systolic, x.diastolic)), x.note || '']));
  if (ds.glucose.length) table('Blood glucose readings', ['Date / time', 'Type', 'Result', 'Category', 'Note'],
    ds.glucose.map(x => [fmtDT(x.taken_at), x.measure_type, fmtNum(x.value) + ' ' + x.unit, cat(glCheck(Number(x.value), x.unit, x.measure_type)), x.note || '']));
  ds.reports.forEach(r => {
    const title = 'Lab report - ' + fmtD(r.report_date) + (r.lab_name ? ' - ' + r.lab_name : '') + (r.doctor ? ' (Dr ' + r.doctor + ')' : '');
    if (r.results.length) table(title, ['Test', 'Panel', 'Result', 'Unit', 'Reference', 'Flag'],
      r.results.map(x => [x.test_name, PANEL_NAME[x.panel] || '', fmtNum(x.value), x.unit || '', rangeText(x), labFlag(x)]));
    else table(title, ['Notes'], [[(r.file_count ? r.file_count + ' attached file(s). ' : '') + (r.notes || 'No typed results.')]]);
    if (r.results.length && r.notes) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(99, 121, 133);
      const lines = doc.splitTextToSize(pdfText('Notes: ' + r.notes), W - 2 * M);
      y -= 4;
      for (const line of lines) {            // break onto a new page instead of running into the footer
        if (y > 282) { doc.addPage(); y = 18; doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(99, 121, 133); }
        doc.text(line, M, y); y += 4;
      }
      y += 6;
    }
  });
  if (ds.medical.length) table('Medical history', ['Date', 'Type', 'Reason / diagnosis', 'Doctor / facility', 'Outcome / notes'],
    ds.medical.map(x => [fmtDT(x.event_at), x.event_type, x.reason, [x.doctor, x.facility].filter(Boolean).join(', '), [x.outcome, x.notes].filter(Boolean).join(' | ')]));
  // Photos appendix
  if (withPhotos) {
    const imgs = ds.reports.flatMap(r => (r.files || []).filter(f => (f.mime || '').startsWith('image/') && f.mime !== 'image/heic').map(f => ({ f, r })));
    if (imgs.length) {
      const urls = await ensureUrls(imgs.map(x => x.f.path));
      for (const { f, r } of imgs) {
        try {
          const im = await imageForPdf(urls[f.path]);
          doc.addPage(); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(22, 56, 74);
          doc.text(pdfText('Report photo - ' + fmtD(r.report_date) + (r.lab_name ? ' - ' + r.lab_name : '')), M, 14);
          const maxW = W - 2 * M, maxH = 297 - 30, k = Math.min(maxW / im.w, maxH / im.h);
          doc.addImage(im.dataUrl, im.fmt, M, 20, im.w * k, im.h * k);
        } catch (e) { /* skip an image that cannot be read */ }
      }
    }
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(113, 131, 140); doc.setFont('helvetica', 'normal');
    doc.text('VitalPath Health Journal - personal health record, not a diagnosis. Interpret with your doctor.', M, 290);
    doc.text(`Page ${i} of ${pages}`, W - M, 290, { align: 'right' });
  }
  return doc.output('blob');
}

// ───────────────────────── Download & share ─────────────────────────
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function needPeriod() {
  const p = currentPeriod(); if (!p) { msg('exResult', 'warn', 'Choose the dates first.', ''); return null; } return p;
}
async function makeFile(ds, kind, withPhotos) {
  if (kind === 'pdf') return new File([await buildPDF(ds, withPhotos)], fileBase(ds) + '.pdf', { type: 'application/pdf' });
  return new File([buildCSV(ds)], fileBase(ds) + '.csv', { type: 'text/csv' });
}
async function exportFile(kind) {
  const p = needPeriod(); if (!p) return;
  const ds = ownDataset(p);
  msg('exResult', '', 'Preparing…', '');
  const f = await makeFile(ds, kind, kind === 'pdf' && $('exPhotos').checked);
  downloadBlob(f, f.name); msg('exResult', 'good', 'Downloaded.', f.name);
}
async function shareFile(kind) {
  const p = needPeriod(); if (!p) return;
  const ds = ownDataset(p);
  msg('exResult', '', 'Preparing…', '');
  const f = await makeFile(ds, kind, kind === 'pdf' && $('exPhotos').checked);
  const title = 'VitalPath — ' + p.label;
  if (!(navigator.canShare && navigator.canShare({ files: [f] }))) {
    downloadBlob(f, f.name);
    msg('exResult', 'warn', 'This browser cannot share files directly, so the file was downloaded.', 'Attach ' + f.name + ' in WhatsApp or email, or use a share link below.');
    return;
  }
  S.pendingShare = { f, title };
  await doShare();
}
async function doShare() {
  const s = S.pendingShare; if (!s) return;
  try {
    await navigator.share({ files: [s.f], title: s.title, text: s.title });
    S.pendingShare = null; $('sharePendingBtn').hidden = true; msg('exResult', 'good', 'Shared.', '');
  } catch (err) {
    if (err.name === 'AbortError') { S.pendingShare = null; $('sharePendingBtn').hidden = true; $('exResult').innerHTML = ''; return; }
    if (err.name === 'NotAllowedError') { $('sharePendingBtn').hidden = false; msg('exResult', '', 'The file is ready.', 'Tap “Tap to share now” to open the share menu.'); return; }
    throw err;
  }
}
function shareUrl(token) { return location.origin + location.pathname + (DB.mode === 'demo' ? '?demo=1' : '') + '#share=' + token; }
function randomToken() { const a = new Uint8Array(24); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); }
async function createShareLink() {
  const p = currentPeriod(); if (!p) { msg('slResult', 'warn', 'Choose the dates first.', ''); return; }
  const days = Number($('slDays').value);
  const [row] = await DB.insert('share_links', [{ token: randomToken(), period_label: p.label, from_at: p.fromAt, to_at: p.toAt, from_date: p.fromDate, to_date: p.toDate,
    expires_at: new Date(Date.now() + days * 864e5).toISOString() }]);
  S.shares.push(row);
  const url = shareUrl(row.token), text = `${S.profile.name} — ${p.label} (VitalPath Health Journal): `;
  $('slResult').innerHTML = `<div class="alert good"><b>Link created.</b> Anyone with this link can view this report until ${esc(fmtDT(row.expires_at))}.
    <div class="linkbox" style="margin-top:8px"><input readonly value="${esc(url)}" id="newLink" aria-label="Share link"><button class="small primary" data-act="copyLink" data-url="${esc(url)}">Copy</button></div>
    <div class="actions"><a class="btn" href="https://wa.me/?text=${encodeURIComponent(text + url)}" target="_blank" rel="noopener">Send on WhatsApp</a>
    <a class="btn" href="mailto:?subject=${encodeURIComponent('Health report: ' + p.label)}&body=${encodeURIComponent(text + '\n\n' + url)}">Send by email</a>
    ${navigator.share ? `<button data-act="shareLinkNative" data-url="${esc(url)}" data-title="${esc(text)}">Share…</button>` : ''}</div></div>`;
  renderShareLinks();
}
function renderShareLinks() {
  const list = S.shares.slice().sort((a, b) => ms(b.created_at) - ms(a.created_at));
  if (!list.length) { $('shareLinkList').innerHTML = '<p class="muted">No share links yet.</p>'; return; }
  $('shareLinkList').innerHTML = '<table><tr><th>Report</th><th>Expires</th><th>Status</th><th>Actions</th></tr>' + list.map(s => {
    const live = !s.revoked && ms(s.expires_at) > Date.now();
    return `<tr><td>${esc(s.period_label)}</td><td>${esc(fmtDT(s.expires_at))}</td><td class="${live ? 'good' : 'muted'}">${s.revoked ? 'Revoked' : live ? 'Active' : 'Expired'}</td>
      <td>${live ? `<button class="small" data-act="copyLink" data-url="${esc(shareUrl(s.token))}">Copy</button> <button class="small danger" data-act="revokeLink" data-id="${esc(s.id)}">Revoke</button>` : `<button class="small danger" data-act="deleteLink" data-id="${esc(s.id)}">Remove</button>`}</td></tr>`;
  }).join('') + '</table>';
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Link copied.'); return; } catch (e) { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  if (ok) toast('Link copied.'); else prompt('Copy this link:', t);
}

// ───────────────────────── Shared (read-only) view ─────────────────────────
function reportHTML(ds) {
  const p = ds.profile || {}, bs = bpStats(ds.bp), gs = glucoseStats(ds.glucose);
  const tbl = (head, rows) => `<div class="scroll"><table><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.join('')}</table></div>`;
  let h = `<div class="card"><div class="sub">SHARED HEALTH REPORT · READ ONLY</div><div class="metric">${esc(p.name || '')}</div>
    <div class="sub">${esc([p.age ? 'Age ' + p.age : '', p.sex, p.condition].filter(Boolean).join(' • '))}</div>
    <h2 style="margin-top:12px">${esc(ds.period.label)}</h2><div class="sub">${esc(datasetCounts(ds))}</div>
    <div class="sub">This link stops working on ${esc(fmtDT(ds.period.expiresAt))}.</div>
    <div class="actions"><button class="primary" data-act="sharedPDF">Download PDF</button><button data-act="sharedCSV">Download CSV</button><button data-act="print">Print</button></div></div>`;
  if (bs || gs.length) h += `<div class="card"><h2>Summary</h2>${bs ? `<p><b>Blood pressure:</b> ${bs.n} reading${bs.n === 1 ? '' : 's'}, average ${esc(bs.avg)} mmHg (highest ${esc(bs.hi)}, lowest ${esc(bs.lo)}); ${bs.raised} at or above 130/80.</p>` : ''}${gs.map(g => `<p><b>${esc(g.type)}:</b> ${g.n} reading${g.n === 1 ? '' : 's'}, average ${esc(g.avg)} ${esc(g.unit)} (range ${esc(g.min)}–${esc(g.max)}).</p>`).join('')}</div>`;
  if (ds.bp.length) h += `<div class="card"><h2>Blood pressure</h2>${tbl(['Date / time', 'Reading', 'Pulse', 'Category', 'Note'], ds.bp.map(x => { const a = bpCheck(x.systolic, x.diastolic); return `<tr><td>${esc(fmtDT(x.taken_at))}</td><td><b>${x.systolic}/${x.diastolic}</b></td><td>${esc(x.pulse || '')}</td><td class="${a[0]}">${esc(a[1])}</td><td>${esc(x.note || '')}</td></tr>`; }))}</div>`;
  if (ds.glucose.length) h += `<div class="card"><h2>Blood glucose</h2>${tbl(['Date / time', 'Type', 'Result', 'Category'], ds.glucose.map(x => { const a = glCheck(Number(x.value), x.unit, x.measure_type); return `<tr><td>${esc(fmtDT(x.taken_at))}</td><td>${esc(x.measure_type)}</td><td><b>${esc(fmtNum(x.value))}</b> ${esc(x.unit)}</td><td class="${a[0]}">${esc(a[1])}</td></tr>`; }))}</div>`;
  ds.reports.forEach(r => {
    h += `<div class="card"><h2>Lab report — ${esc(fmtD(r.report_date))}${r.lab_name ? ' · ' + esc(r.lab_name) : ''}</h2>${r.results.length ? tbl(['Test', 'Result', 'Reference', 'Flag'], r.results.map(x => `<tr><td>${esc(x.test_name)}</td><td><b>${esc(fmtNum(x.value))}</b> ${esc(x.unit || '')}</td><td>${esc(rangeText(x))}</td><td>${flagChip(labFlag(x))}</td></tr>`)) : ''}${r.file_count ? `<p class="muted">${r.file_count} report file(s) are kept privately by the owner.</p>` : ''}${r.notes ? `<p class="muted">${esc(r.notes)}</p>` : ''}</div>`;
  });
  if (ds.medical.length) h += `<div class="card"><h2>Medical history</h2>${tbl(['Date', 'Type', 'Details'], ds.medical.map(x => `<tr><td>${esc(fmtDT(x.event_at))}</td><td>${esc(x.event_type)}</td><td><b>${esc(x.reason)}</b>${x.doctor ? '<br>Doctor: ' + esc(x.doctor) : ''}${x.facility ? '<br>' + esc(x.facility) : ''}${x.outcome ? '<br>' + esc(x.outcome) : ''}</td></tr>`))}</div>`;
  h += '<div class="card muted">A personal health record kept by the patient. It is not a diagnosis; interpret it with the treating doctor.</div>';
  return h;
}
let SHARED = null;
async function showShared(token) {
  $('shareView').hidden = false; $('authGate').hidden = true; $('app').hidden = true;
  $('shareBody').innerHTML = '<div class="card">Loading report…</div>';
  try {
    const ds = await DB.sharedReport(token);
    if (!ds) { $('shareBody').innerHTML = '<div class="card"><h2>This link is not available</h2><p class="muted">It may have expired or been revoked by its owner. Ask them for a new link.</p></div>'; return; }
    ds.reports = (ds.reports || []).map(r => ({ ...r, results: r.results || [], files: [] }));
    ['bp', 'glucose', 'medical'].forEach(k => { ds[k] = ds[k] || []; });
    SHARED = ds; $('shareBody').innerHTML = reportHTML(ds);
    document.title = 'Shared report — VitalPath Health Journal';
  } catch (err) { $('shareBody').innerHTML = `<div class="card"><h2>Could not load the report</h2><p class="muted">${esc(friendly(err))}</p></div>`; }
}

// ───────────────────────── Backup, import, erase ─────────────────────────
function backup() {
  const out = { app: 'VitalPath Health Journal', version: 2, exported_at: new Date().toISOString(), profile: S.profile,
    bp_readings: S.bp, glucose_readings: S.glucose, medical_history: S.medical, lab_reports: S.reports, lab_results: S.results, report_files: S.files };
  downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `VitalPath_backup_${fileSafe(S.profile.name)}_${localDate()}.json`);
}
async function importOld(file) {
  let x;
  try { x = JSON.parse(await file.text()); } catch (e) { msg('importResult', 'bad', 'Not a backup file.', 'Choose the .json file the old VitalPath app downloaded.'); return; }
  if (!x || !x.data || !Array.isArray(x.data.bp) || !Array.isArray(x.data.glucose)) { msg('importResult', 'bad', 'Not an old VitalPath backup.', 'This file does not have the expected readings.'); return; }
  const iso = d => { const t = new Date(d); return isNaN(t) ? null : t.toISOString(); };
  const seenBP = new Set(S.bp.map(r => ms(r.taken_at) + '|' + r.systolic + '|' + r.diastolic));
  const seenGL = new Set(S.glucose.map(r => ms(r.taken_at) + '|' + Number(r.value) + '|' + r.measure_type));
  const seenMH = new Set(S.medical.map(r => ms(r.event_at) + '|' + r.reason));
  // Same limits as the database CHECK constraints, so one bad legacy row cannot fail a whole batch.
  const pulseOk = p => (p != null && p >= 20 && p <= 250) ? p : null;
  const bpAll = x.data.bp.map(r => ({ taken_at: iso(r.date), systolic: Number(r.sys), diastolic: Number(r.dia), pulse: pulseOk(numOrNull(r.pulse)), position: r.position || null, context: r.context || null, note: r.note || '' }));
  const bpValid = bpAll.filter(r => r.taken_at && r.systolic >= 40 && r.systolic <= 300 && r.diastolic >= 20 && r.diastolic <= 200 && r.systolic > r.diastolic);
  const skipped = bpAll.length - bpValid.length;
  const bp = bpValid.filter(r => !seenBP.has(ms(r.taken_at) + '|' + r.systolic + '|' + r.diastolic));
  const gl = x.data.glucose.map(r => ({ taken_at: iso(r.date), value: Number(r.value), unit: r.unit, measure_type: r.type, note: r.note || '' }))
    .filter(r => r.taken_at && r.value > 0 && ['mg/dL', 'mmol/L', '% (HbA1c)'].includes(r.unit) && r.measure_type && !seenGL.has(ms(r.taken_at) + '|' + r.value + '|' + r.measure_type));
  const mh = (x.data.medicalHistory || []).map(r => ({ event_at: iso(r.date), event_type: r.type || 'Other', doctor: r.doctor || '', facility: r.facility || '', reason: r.reason || '(not recorded)', outcome: r.outcome || '', notes: r.notes || '' }))
    .filter(r => r.event_at && !seenMH.has(ms(r.event_at) + '|' + r.reason));
  const oldContacts = x.profile && x.profile.contacts ? migrateLegacyContacts(x.profile.contacts) : null;
  const addContacts = oldContacts && oldContacts.directory.length && !contacts().directory.length;
  if (!bp.length && !gl.length && !mh.length && !addContacts) { msg('importResult', 'good', 'Nothing new to import.', 'Everything in this file is already in your account.'); return; }
  if (!confirm(`Import ${bp.length} BP readings, ${gl.length} glucose readings and ${mh.length} medical history entries${addContacts ? ', plus ' + oldContacts.directory.length + ' contacts' : ''} into your account?`)) return;
  msg('importResult', '', 'Importing…', '');
  try {
    if (bp.length) S.bp.push(...await DB.insert('bp_readings', bp));
    if (gl.length) S.glucose.push(...await DB.insert('glucose_readings', gl));
    if (mh.length) S.medical.push(...await DB.insert('medical_history', mh));
    if (addContacts) { const c = contacts(); await saveContactsObj({ ...oldContacts, ...c, directory: oldContacts.directory }); }
  } finally { renderAll(); }
  msg('importResult', 'good', 'Imported.', `${bp.length} BP, ${gl.length} glucose and ${mh.length} medical history records added.${skipped ? ` ${skipped} BP reading(s) with impossible values were skipped.` : ''}`);
}
async function eraseAll() {
  if (!confirm('Delete ALL your readings, lab reports, photos, share links and your profile? This cannot be undone.')) return;
  if ((prompt('Type DELETE to confirm') || '').trim().toUpperCase() !== 'DELETE') { toast('Nothing was deleted.'); return; }
  await DB.wipe(S.user.id);
  Object.assign(S, { profile: null, bp: [], glucose: [], medical: [], reports: [], results: [], files: [], shares: [], urls: {} });
  toast('All your records were deleted.'); openProfile(true);
}

// ───────────────────────── Event wiring ─────────────────────────
const ACTIONS = {
  go: d => showPage(d.page),
  signOut: async () => { await DB.signOut(); leave(); },
  authMode: d => setAuthMode(d.mode),
  saveProfile, cancelProfile: () => { $('profileGate').hidden = true; $('app').hidden = false; },
  editProfile: () => openProfile(false),
  saveBP, saveGlucose, saveMedical, saveLabReport,
  cancelEdit: d => { ({ bp: resetBPForm, glucose: resetGlucoseForm, medical: resetMedicalForm, labs: resetLabForm })[d.form](); },
  editReading: d => editReading(d.kind, d.id), deleteReading: d => deleteReading(d.kind, d.id),
  editMedical: d => editMedical(d.id), deleteMedical: d => deleteMedical(d.id),
  addOtherTest: () => addOtherTestRow(),
  removeOtherTest: (d, el) => el.closest('.otherRow').remove(),
  removePending: d => { const p = S.pendingFiles.splice(Number(d.i), 1)[0]; if (p) URL.revokeObjectURL(p.url); renderPendingFiles(); },
  editLabReport: d => editLabReport(d.id), deleteLabReport: d => deleteLabReport(d.id), deleteFile: d => deleteFile(d.id),
  openImage: d => { if (!d.src) return; $('lightbox').querySelector('img').src = d.src; $('lightbox').hidden = false; },
  closeLightbox: () => { $('lightbox').hidden = true; },
  exportPDF: () => exportFile('pdf'), exportCSV: () => exportFile('csv'),
  sharePDF: () => shareFile('pdf'), shareCSV: () => shareFile('csv'), sharePending: () => doShare(),
  createShareLink, copyLink: d => copyText(d.url),
  shareLinkNative: d => navigator.share({ title: d.title, text: d.title, url: d.url }).catch(() => {}),
  revokeLink: async d => { if (!confirm('Revoke this link? Anyone who has it will no longer be able to open the report.')) return; const r = await DB.update('share_links', d.id, { revoked: true }); S.shares = S.shares.map(x => x.id === r.id ? r : x); renderShareLinks(); toast('Link revoked.'); },
  deleteLink: async d => { await DB.remove('share_links', [d.id]); S.shares = S.shares.filter(x => x.id !== d.id); renderShareLinks(); },
  sharedPDF: async () => { const f = await makeFile(SHARED, 'pdf', false); downloadBlob(f, f.name); },
  sharedCSV: async () => { const f = await makeFile(SHARED, 'csv', false); downloadBlob(f, f.name); },
  print: () => window.print(),
  openMore: () => openMore(),
  pickImport: () => $('importFile').click(),
  addCareContact: async () => {
    const c = syncCareCards(); c.directory.push({ kind: 'Doctor', name: '', speciality: '', phone: '', facility: '', address: '', notes: '' });
    renderCareDirectoryEditor(); const el = $('careName' + (c.directory.length - 1)); if (el) el.focus();
  },
  updateCareContact: () => saveAllContacts('This entry has been saved.'),
  deleteCareContact: async d => {
    const c = syncCareCards(); if (!c.directory[Number(d.i)] || !confirm('Delete this contact / facility entry?')) return;
    c.directory.splice(Number(d.i), 1); await saveContactsObj(c); renderCareDirectoryEditor(); renderHomeContacts();
  },
  saveContacts: () => saveAllContacts('Your contacts, emergency numbers and instructions have been saved.'),
  changePassword: async () => {
    const cur = $('curPass').value, p = $('newPass').value;
    if (!cur) { msg('accountResult', 'warn', 'Current password needed.', 'Enter your current password first.'); return; }
    if (p.length < 8) { msg('accountResult', 'warn', 'Too short.', 'Use at least 8 characters for the new password.'); return; }
    try { await DB.verifyPassword(S.user.email, cur); }
    catch (e) { msg('accountResult', 'bad', 'Current password is not correct.', ''); return; }
    await DB.updatePassword(p); $('curPass').value = ''; $('newPass').value = ''; msg('accountResult', 'good', 'Password changed.', '');
  },
  showOlder: () => { S.historyLimit += 60; renderHistory(); },
  backup, eraseAll
};
// One save path for the whole contacts card: every typed contact plus the emergency numbers.
async function saveAllContacts(okText) {
  const c = syncCareCards();
  const nameless = c.directory.findIndex(x => !x.name && (x.phone || x.speciality || x.facility || x.address || x.notes));
  if (nameless >= 0) { msg('contactResult', 'warn', 'Name needed.', `Contact ${nameless + 1} has details but no name. Add a name, or delete that entry.`); $('careName' + nameless).focus(); return; }
  c.ambulanceNumber = $('ambulanceNumber').value.trim(); c.nationalEmergencyNumber = $('nationalEmergencyNumber').value.trim(); c.contactNotes = $('contactNotes').value.trim();
  await saveContactsObj(c);
  msg('contactResult', 'good', 'Saved.', okText); renderCareDirectoryEditor(); renderHomeContacts();
}
// Which result box shows an error for each action.
const ERROR_BOX = { saveBP: 'bpResult', saveGlucose: 'glResult', saveMedical: 'mhResult', saveLabReport: 'lrResult', saveProfile: 'profileMsg',
  exportPDF: 'exResult', exportCSV: 'exResult', sharePDF: 'exResult', shareCSV: 'exResult', sharePending: 'exResult', createShareLink: 'slResult',
  updateCareContact: 'contactResult', saveContacts: 'contactResult', deleteCareContact: 'contactResult', changePassword: 'accountResult' };

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const name = el.dataset.act, fn = ACTIONS[name]; if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.disabled) return;
  const isBtn = el.tagName === 'BUTTON'; if (isBtn) el.disabled = true;
  try { await fn(el.dataset, el); }
  catch (err) { console.error(err); if (ERROR_BOX[name]) msg(ERROR_BOX[name], 'bad', 'Something went wrong.', friendly(err)); else toast(friendly(err)); }
  finally { if (isBtn && el.isConnected) el.disabled = false; }
});
document.querySelectorAll('.tab[data-page]').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
$('moreSheet').addEventListener('click', e => { if (e.target.id === 'moreSheet') closeMore(); });
// Hide the bottom tab bar while the on-screen keyboard is likely open, so it never floats over a form.
const TYPING = 'input:not([type=checkbox]):not([type=file]):not([type=radio]),select,textarea';
document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches(TYPING)) document.body.classList.add('typing'); });
document.addEventListener('focusout', () => setTimeout(() => {
  if (!(document.activeElement && document.activeElement.matches && document.activeElement.matches(TYPING))) document.body.classList.remove('typing');
}, 50));
// On phones, tables turn into stacked cards: label every cell with its column heading.
function stackTables(root) {
  root.querySelectorAll('table:not(.stack)').forEach(t => {
    const heads = [...t.querySelectorAll('th')].map(th => th.textContent.trim());
    if (!heads.length) return;
    t.classList.add('stack');
    t.querySelectorAll('tr').forEach(tr => [...tr.children].forEach((td, i) => {
      if (td.tagName !== 'TD') return;
      td.dataset.label = heads[i] || '';
      if (/^actions$/i.test(heads[i] || '')) { td.classList.add('acts'); return; }
      if (!td.querySelector(':scope > .v')) {   // one wrapper, so the label and the value are the only two flex items
        const v = document.createElement('span'); v.className = 'v';
        while (td.firstChild) v.appendChild(td.firstChild);
        td.appendChild(v);
      }
    }));
  });
}
new MutationObserver(() => { stackTables($('app')); stackTables($('shareView')); }).observe(document.body, { childList: true, subtree: true });
// Redraw charts when the screen size changes (phone rotation, window resize).
let resizeTimer, lastWidth = window.innerWidth;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
  if (!S.profile || window.innerWidth === lastWidth) return;   // ignore phone toolbar show/hide (height only)
  lastWidth = window.innerWidth;
  if ($('history').classList.contains('active')) renderHistoryCharts();
  if ($('labs').classList.contains('active')) renderLabTrend();
}, 200); });
$('authForm').addEventListener('submit', submitAuth);
$('filterType').addEventListener('change', renderHistory);
$('labTrendTest').addEventListener('change', renderLabTrend);
$('lrFiles').addEventListener('change', e => addPendingFiles(e.target.files));
$('importFile').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) { try { await importOld(f); } catch (err) { msg('importResult', 'bad', 'Import failed.', friendly(err)); } } });
['exKind', 'exDay', 'exMonth', 'exFrom', 'exTo'].forEach(id => $(id).addEventListener('change', updateExportSummary));
$('lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('lightbox').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('lightbox').hidden = true; closeMore(); } });
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#share=([A-Za-z0-9]+)$/);
  if (m && DB) showShared(m[1]);
  else if (!$('shareView').hidden) location.reload();   // leaving a shared report: bring the app back
});
// Phone Back button moves between tabs instead of leaving the site.
window.addEventListener('popstate', e => {
  if (!$('moreSheet').hidden) { $('moreSheet').hidden = true; document.documentElement.style.overflow = ''; if (!(e.state && e.state.sheet)) return; }
  if (e.state && e.state.page && S.profile) showPage(e.state.page, true);
});
// Warn before a reload or close would lose an unsaved form or a running upload.
window.addEventListener('beforeunload', e => {
  if (!S.user) return;
  if (S.saving || labDirty() || bpDirty() || glDirty() || mhDirty()) { e.preventDefault(); e.returnValue = ''; }
});
// Picking HbA1c switches the unit to % (and back to mg/dL for other types).
$('glType').addEventListener('change', () => {
  if ($('glType').value === 'HbA1c') $('glUnit').value = '% (HbA1c)';
  else if ($('glUnit').value === '% (HbA1c)') $('glUnit').value = 'mg/dL';
});

// ───────────────────────── Start ─────────────────────────
async function boot() {
  history.replaceState({ page: 'home' }, '');
  resetBPForm(); resetGlucoseForm(); resetMedicalForm(); resetLabForm();
  $('exDay').value = localDate(); $('exMonth').value = localDate().slice(0, 7); $('exFrom').value = localDate(addDays(new Date(), -6)); $('exTo').value = localDate();
  const params = new URLSearchParams(location.search), cfg = window.VITALPATH_CONFIG || {};
  if (params.has('demo') && window.VitalPathDemoDB) { DB = window.VitalPathDemoDB; $('demoBanner').hidden = false; }
  else if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    if (!window.supabase) { $('setupView').hidden = false; $('setupView').querySelector('p').textContent = 'The sign-in library could not load. Check your internet connection and reload the page.'; return; }
    DB = supabaseAdapter(cfg);
  } else { $('setupView').hidden = false; return; }
  const share = location.hash.match(/^#share=([A-Za-z0-9]+)$/);
  if (share) { showShared(share[1]); return; }
  setAuthMode(RECOVERING ? 'newpass' : 'signin');
  if (RECOVERING) showAuth();
  DB.onAuth(async (ev, user) => {
    if (ev === 'PASSWORD_RECOVERY') { setAuthMode('newpass'); showAuth(); return; }
    if (ev === 'SIGNED_OUT') { if (S.user) leave(); return; }
    if (user && (ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION') && S.authMode !== 'newpass') await enter(user);
  });
  let user = null;
  try { user = await DB.currentUser(); } catch (e) { /* treat as signed out */ }
  if (user && !RECOVERING) await enter(user); else if (!S.user) showAuth();
}
window.addEventListener('error', e => console.error('VitalPath error:', e.message));
boot();
})();
