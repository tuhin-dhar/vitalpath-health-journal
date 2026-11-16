# VitalPath Health Journal

A personal health record website. Each person signs up for a private account and can log:

- **Blood pressure** and **blood glucose** readings, with a plain-language reading of each value
- **Lab reports**: photos or PDFs of the report, plus the numbers for
  - Sugar: **HbA1c** (average sugar over about 3 months), fasting, post-meal, random
  - Thyroid: TSH, T3, T4, FT3, FT4
  - Liver (LFT): SGPT/ALT, SGOT/AST, ALP, GGT, bilirubin, albumin, protein
  - Kidney (KFT): creatinine, urea, BUN, uric acid, eGFR
  - Lipids: total cholesterol, LDL, HDL, triglycerides, VLDL
  - any other test, typed in by name
- **Medical history** (admissions, surgeries, consultations), and doctor, hospital and emergency contacts

Reports for **one day, one week, one month or any date range** can be:

- downloaded as a **PDF** (a summary with averages and flags, optionally with the report photos) or a **CSV** (opens in Excel)
- sent from a phone with **Share…**, which opens WhatsApp, Gmail and other apps with the file attached
- shared as a **read-only link** that expires after 1, 7 or 30 days and can be revoked at any time

It costs nothing to run: the site is static files on a free host, and the data lives in a free Supabase project.

> This is a personal record and an educational aid, not a medical device. The treating doctor's advice comes first.

**Live site:** <https://tuhin-dhar.github.io/vitalpath-health-journal/> (GitHub Pages, connected to the Supabase project `tpaojupaqwsdehscjkyp` in Mumbai).

---

## Try it first (no setup)

Open `index.html?demo=1` through any local web server, for example:

```bash
python -m http.server 8000
```

then visit <http://localhost:8000/index.html?demo=1>. In demo mode everything stays in that browser; don't put real health data there.

---

## Set it up for real (about 15 minutes, once)

### 1. Create the free database (Supabase)

1. Go to <https://supabase.com>, sign up (no card needed) and click **New project**.
   Pick a region close to you (for India: **Mumbai, ap-south-1**). Save the database password somewhere safe.
2. When the project is ready, open **SQL Editor → New query**, paste the whole of
   [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. It should say "Success".
   This creates the tables, the private photo storage and the privacy rules.
3. Open **Project Settings → API** and copy:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long text starting with `eyJ…`)

   Do **not** use the `service_role` key anywhere in the site.

### 2. Put the keys in the site

Open [`config.js`](config.js) and fill in the two values:

```js
window.VITALPATH_CONFIG = {
  supabaseUrl: "https://abcd1234.supabase.co",
  supabaseAnonKey: "eyJhbGciOi..."
};
```

The anon key is designed to be public. Privacy comes from the Row Level Security rules in the schema: each signed-in person can only read and change their own rows and their own photo folder.

### 3. Publish the site for free

Any static host works. Two easy ones:

**Netlify Drop (no GitHub needed)**
1. Go to <https://app.netlify.com/drop> and sign up.
2. Drag the whole `vitalpath-health-journal` folder onto the page.
3. You get an address like `https://vitalpath-xyz.netlify.app`. You can rename it under **Site configuration → Change site name**.

**GitHub Pages**
1. Create a GitHub repository and upload these files.
2. **Settings → Pages → Deploy from a branch → main / (root)**.
3. The site appears at `https://<username>.github.io/<repository>/`.

### 4. Tell Supabase the site address

In Supabase open **Authentication → URL Configuration**:
- **Site URL**: your site address, e.g. `https://vitalpath-xyz.netlify.app`
- **Redirect URLs**: add the same address (with `/index.html` too if you like)

This makes the "confirm your email" and "reset password" links come back to the site.

### 5. Sign up

Open the site, click **Create an account**, confirm the email, sign in and fill in the profile.
Each family member or colleague who wants their own journal signs up with their own email.

If your uncle has data in the old single-file app, he should click **Download backup** there, then in the new site go to
**Profile & backup → Import old VitalPath backup**. Readings, medical history and contacts come across; anything already imported is skipped.

---

## Using it

| To… | Go to |
|---|---|
| Log BP or sugar | **Record BP** / **Record glucose** |
| Save a lab report | **Lab reports** → set the date → open the panels you need and type the numbers → attach photos or the PDF → **Save** |
| See trends | **History & charts** (BP, glucose) and **Lab reports → Lab trend** (any lab test) |
| Send a weekly/monthly report | **Share & export** → pick the period → **Download PDF / CSV**, **Share PDF…**, or **Create share link** |
| Stop a link working | **Share & export → Your links → Revoke** |

The reference ranges pre-filled for lab tests are typical adult values. Labs differ, so type the range printed on the report when it is different. Flags (HIGH / LOW) use whichever range was saved.

---

## Free-plan limits worth knowing

- **Inactivity pause**: a free Supabase project pauses after **7 days with no activity**. Regular use keeps it awake. If it pauses, sign in to supabase.com and click **Restore project**; no data is lost.
- **Space**: 500 MB database (years of readings) and 1 GB of files. Photos are shrunk to about 300–600 KB each before upload, so 1 GB holds roughly 2,000 report pages.
- **Sign-up emails**: Supabase's built-in email sender allows only a few emails per hour. That's fine for a family, but if many officers sign up on the same day, some may need to wait an hour. You can connect your own SMTP under **Authentication → Emails** to lift the limit.
- **Backups**: the free plan has no automatic database backups. Use **Profile & backup → Download full backup** now and then.

## What share links include

A share link shows that period's readings, lab numbers and medical history, plus the person's name, age, sex and health profile.
It does **not** include report photos or contact details. To send photos, use **Share PDF…** or **Download PDF** with "Include report photos" ticked.
Anyone who has the link can open it until it expires, so send it only to the people meant to see it.

## Files

| File | What it is |
|---|---|
| `index.html` | The page and its styles |
| `app.js` | All app logic: sign-in, records, lab reports, charts, PDF/CSV, sharing |
| `config.js` | Your Supabase URL and anon key |
| `demo-db.js` | In-browser stand-in backend for `?demo=1` |
| `supabase/schema.sql` | Tables, privacy rules, photo storage and the share-link function |

Libraries are loaded from public CDNs: supabase-js 2.45.4, jsPDF 2.5.1 and jsPDF-AutoTable 3.8.2.

Designed by Biraj Das.
