# Receipt Ledger — Shared (Firebase)

A shared household receipt ledger. You and your wife each sign in with your own
Google account; every receipt syncs live to both phones, stamped with who added it.
Images live in Cloud Storage, data in Firestore, extraction via your existing Worker.
Locked to your two emails by security rules.

Nothing works until the Firebase setup below is done — the code ships inert.

---

## A. Create the Firebase project (~15 min, one time)

1. **console.firebase.google.com** → Add project. Name it, finish.
2. **Register a Web app:** Project Overview → the `</>` (Web) icon → give it a nickname →
   Register. You'll be shown a `firebaseConfig` object. Copy it.
3. Paste those values into **`firebase-config.js`** (replace the `PASTE_...` placeholders).
   Copy `storageBucket` exactly as shown — it may end in `.appspot.com` or
   `.firebasestorage.app`.

## B. Turn on sign-in

4. **Build → Authentication → Get started → Sign-in method → Google → Enable → Save.**
5. **Authentication → Settings → Authorized domains → Add domain** → add your app's host,
   e.g. `yourname.github.io`. Google sign-in is refused from any domain not listed here.

## C. Database + rules

6. **Build → Firestore Database → Create database →** start in **production mode** → pick a
   region → Enable.
7. **Firestore → Rules** → paste the contents of `firestore.rules` (with your two real
   emails) → **Publish.**

## D. Image storage + rules  (this is the card step)

8. **Build → Storage → Get started.** It will prompt you to upgrade to the **Blaze** plan
   and link a card. This is expected — it stays $0 within the free tier (5 GB storage,
   100 GB/mo egress). Finish the upgrade, create the default bucket.
9. **Storage → Rules** → paste the contents of `storage.rules` (same two emails) → **Publish.**

## E. Allowlist + deploy

10. In **`firebase-config.js`**, set `ALLOWED_EMAILS` to your two Google emails — they must
    match the emails in both rules files exactly (lowercase).
11. Host the files (GitHub Pages, same as before). Open on each phone → **Add to Home
    Screen** → sign in with the matching Google account.

---

## Everyday notes
- **Updates:** bump `VERSION` in `sw.js` on every change, or phones keep the cached copy.
- **Your data, exportable:** "Export CSV" (includes image links), "Download image" per
  receipt, or bulk-download the whole bucket from the Firebase/Cloud console anytime.
- **Free-tier reality:** a linked card is required for Storage but the bill stays $0 at your
  volume. Set a budget alert in Google Cloud Billing if you want a tripwire.
- **Files you edit:** only `firebase-config.js`, `firestore.rules`, `storage.rules`. Leave
  `app.js` alone.

## Roadmap
- Trip grouping + per-trip totals
- Monthly rollups and a soft budget cap
