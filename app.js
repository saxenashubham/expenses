import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, collection, doc, setDoc, updateDoc, deleteField, FieldPath,
  deleteDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getStorage, ref, uploadString, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { firebaseConfig, ALLOWED_EMAILS, EXTRACT_URL } from "./firebase-config.js";

const allowed = ALLOWED_EMAILS.map((e) => e.toLowerCase());

// ---------- Firebase init ----------
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache() });
const storage = getStorage(fb);
const provider = new GoogleAuthProvider();

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  });
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c != null && n.append(c.nodeType ? c : document.createTextNode(c)));
  return n;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const todayISO = () => new Date().toISOString().slice(0, 10);
const num = (a) => { const n = parseFloat(String(a).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; };
function money(a, cur) {
  const n = num(a); if (n == null) return "\u2014";
  cur = cur === "INR" ? "INR" : "USD";
  try { return new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n); }
  catch (e) { return (cur === "INR" ? "\u20b9" : "$") + n.toFixed(2); }
}
const firstName = (s) => (s || "").split(/[\s@]/)[0] || "?";

const CATEGORIES = ["Medical", "Food", "Groceries", "Travel", "Vehicle", "Shopping", "Utilities", "Other"];
const CAT_HINTS = {
  Medical: ["pharmac", "cvs", "walgreen", "clinic", "dental", "dentist", "doctor", "medical", "health", "optometr", "vision center", "hospital", " rx", "drug"],
  Food: ["restaurant", "cafe", "coffee", "starbucks", "grill", "pizza", "taco", "diner", "bakery", "kitchen", "bbq", "burger", "sushi"],
  Groceries: ["grocery", "market", "kroger", "aldi", "costco", "walmart", "whole foods", "trader joe", "heb", "h-e-b", "sprouts", "safeway", "target"],
  Travel: ["hotel", "inn", "motel", "marriott", "hilton", "airline", "airport", "delta", "united air", "uber", "lyft", "resort", "lodge", "rental car"],
  Vehicle: ["shell", "exxon", "chevron", "mobil", "gas ", "fuel", "valero", "auto", "tire", "quick lube", "tesla", "supercharg", "parking", "toll"],
  Shopping: ["amazon", "best buy", "apple store", "mall", "home depot", "lowe", "ikea"],
  Utilities: ["electric", "water dept", "energy", "at&t", "verizon", "comcast", "spectrum", "internet", "utility"]
};
function guessCategory(merchant) {
  const m = (merchant || "").toLowerCase();
  if (!m) return "";
  for (const cat of CATEGORIES) { const h = CAT_HINTS[cat]; if (h && h.some((x) => m.includes(x))) return cat; }
  return "";
}

function resizeImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (Math.max(width, height) > maxDim) { const s = maxDim / Math.max(width, height); width = Math.round(width * s); height = Math.round(height * s); }
        const c = document.createElement("canvas"); c.width = width; c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject; img.src = reader.result;
    };
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}

let _pdfjs;
function ensurePdfJs() {
  if (_pdfjs) return Promise.resolve(_pdfjs);
  return new Promise((res, rej) => {
    const base = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
    const s = document.createElement("script"); s.src = base + "pdf.min.js";
    s.onload = () => { const lib = window.pdfjsLib; if (!lib) return rej(new Error("pdfjs")); lib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.js"; _pdfjs = lib; res(lib); };
    s.onerror = () => rej(new Error("pdfjs network")); document.head.appendChild(s);
  });
}
async function pdfFirstPageToJpeg(file, maxDim = 1600, quality = 0.82) {
  const lib = await ensurePdfJs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await pdf.getPage(1);
  const b = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxDim / Math.max(b.width, b.height)) || 1;
  const viewport = page.getViewport({ scale: scale > 0 ? scale : 1 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/jpeg", quality);
}

async function extract(dataUrl) {
  if (!EXTRACT_URL) throw new Error("no-extractor");
  const res = await fetch(EXTRACT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: dataUrl.split(",")[1] }) });
  if (!res.ok) throw new Error("extract-failed");
  return res.json();
}

// ---------- state ----------
let USER = null;
let RECEIPTS = [];
let CARDS = [];
let unsubReceipts = null, unsubCards = null, unsubBackup = null;
function monthRange() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  return { from: y + "-" + pad(m + 1) + "-01", to: y + "-" + pad(m + 1) + "-" + pad(new Date(y, m + 1, 0).getDate()) };
}
function isThisMonth() { const mr = monthRange(); return state.flt.from === mr.from && state.flt.to === mr.to; }
function lastMonthRange() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const lm = new Date(y, m - 1, 1);            // first day of previous month
  const ly = lm.getFullYear(), lmo = lm.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  return { from: ly + "-" + pad(lmo + 1) + "-01", to: ly + "-" + pad(lmo + 1) + "-" + pad(new Date(ly, lmo + 1, 0).getDate()) };
}
function isLastMonth() { const mr = lastMonthRange(); return state.flt.from === mr.from && state.flt.to === mr.to; }
const state = {
  screen: "loading",   // loading | signin | denied | ledger
  view: "list",        // list | capture | cards
  cap: null,
  flt: { from: monthRange().from, to: monthRange().to, card: "", token: "", category: "", currency: "", owner: "", hcsaOnly: false, text: "", tag: "" },
  sort: { by: "date", dir: "desc" },   // by: date | amount
  openId: null,
  filtersOpen: false,  // collapsible filter panel, default collapsed
  menuOpen: false,     // hamburger dropdown
  edit: null,          // { id, date, amount, category } when editing a receipt
  page: 1,
  fltSig: "",
  dash: { currency: "USD", seg: "card", range: "12m" },
  stmt: { card: "", currency: "USD", open: null },
  backupDone: {}, backupBusy: false, cardBusy: false,
  export: { name: "", from: lastMonthRange().from, to: lastMonthRange().to, card: "", category: "", currency: "", hcsaOnly: false, tag: "" }
};
const CATEGORY_COLORS = { Medical: "#B23A2E", Food: "#B5852A", Groceries: "#5B7A2E", Travel: "#2E5E9E", Vehicle: "#8A5A2B", Shopping: "#7A3E8A", Utilities: "#3A7A8A", Other: "#8A857C" };
function segColor(k, mode) { return mode === "card" ? colorForCard(k) : (CATEGORY_COLORS[k] || "#8A857C"); }
function monthsBack(n) {
  const out = [], d = new Date();
  for (let i = n - 1; i >= 0; i--) { const dt = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0")); }
  return out;
}
const monthKeyOf = (s) => (s || "").slice(0, 7);
function aggregate(rs, keyFn) {
  const m = {}; rs.forEach((r) => { const k = keyFn(r); m[k] = (m[k] || 0) + (num(r.amount) || 0); });
  return Object.entries(m).map(([k, v]) => ({ k, v })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
}
function parseTags(str) { return [...new Set(String(str || "").split(/[\s,#]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))]; }
function tagsToStr(arr) { return (arr || []).join(", "); }
function allTags() { const s = new Set(); RECEIPTS.forEach((r) => (r.tags || []).forEach((t) => s.add(t))); return [...s].sort(); }
function tagsField(get, set) {
  const cur = parseTags(get());
  const suggestions = allTags().filter((t) => !cur.includes(t)).slice(0, 12);
  return el("div", { class: "tags-field" }, [
    el("input", { value: get(), placeholder: "e.g. birthday, vacation", oninput: (e) => set(e.target.value) }),
    suggestions.length ? el("div", { class: "tag-suggests" }, suggestions.map((t) => el("button", { class: "tag-sugg", onclick: () => { const v = parseTags(get()); if (!v.includes(t)) set(tagsToStr([...v, t])); render(); } }, "#" + t))) : null
  ]);
}
const PAGE_SIZE = 20;
const CARD_PALETTE = ["#0F6E6A", "#B23A2E", "#2E5E9E", "#8A5A2B", "#5B7A2E", "#7A3E8A", "#B5852A", "#3A7A8A", "#9E4B6E", "#4B6E3A"];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function colorForCard(name) {
  if (!name) return "#C9C4B8";
  const c = CARDS.find((x) => x.name === name);
  if (c && c.color) return c.color;
  return CARD_PALETTE[hashStr(name) % CARD_PALETTE.length];
}

// ---------- auth ----------
onAuthStateChanged(auth, (u) => {
  teardown();
  if (!u) { USER = null; state.screen = "signin"; return render(); }
  if (!allowed.includes((u.email || "").toLowerCase())) { USER = u; state.screen = "denied"; return render(); }
  USER = u; state.screen = "ledger"; subscribe(); render();
});
getRedirectResult(auth).catch(() => {});

async function doSignIn() {
  try { await signInWithPopup(auth, provider); }
  catch (e) { try { await signInWithRedirect(auth, provider); } catch (e2) { alert("Sign-in failed: " + (e2.message || e2)); } }
}
function doSignOut() { signOut(auth); }

function teardown() {
  if (unsubReceipts) { unsubReceipts(); unsubReceipts = null; }
  if (unsubCards) { unsubCards(); unsubCards = null; }
  if (unsubBackup) { unsubBackup(); unsubBackup = null; }
  RECEIPTS = []; CARDS = [];
}
function subscribe() {
  unsubReceipts = onSnapshot(query(collection(db, "receipts"), orderBy("date", "desc")), (snap) => {
    RECEIPTS = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (state.screen === "ledger") render();
  }, (err) => { console.error(err); });
  unsubCards = onSnapshot(doc(db, "meta", "cards"), (d) => {
    const data = d.exists() ? d.data() : {};
    CARDS = (data.cards && !Array.isArray(data.cards))
      ? cardsMapToArray(data.cards)                    // current map shape
      : normalizeCards(data.cards || data.list || []); // legacy shape: read-only, never written back
    if (state.screen === "ledger") render();
  }, (err) => { console.error(err); });
  unsubBackup = onSnapshot(doc(db, "meta", "backup"), (d) => {
    state.backupDone = (d.exists() && d.data().done) || {};
    if (state.screen === "ledger") render();
  }, (err) => { console.error(err); });
}

function cardNames() { return CARDS.map((c) => c.name); }
function tokensOf(c) { return (c && c.tokens) || []; }
function allTokenLabels() {
  const s = new Set();
  CARDS.forEach((c) => tokensOf(c).forEach((t) => t.label && s.add(t.label)));
  return [...s].sort();
}
function cardByLast4(l4) {
  if (!l4) return null;
  for (const c of CARDS) { const t = tokensOf(c).find((x) => x.last4 === l4); if (t) return { card: c, token: t }; }
  return null;
}
function normalizeCards(raw) {
  const out = [], seen = new Set();
  (raw || []).forEach((entry) => {
    let name = "", tokens = [];
    if (typeof entry === "string") name = entry;
    else if (entry && entry.name) {
      name = entry.name;
      if (Array.isArray(entry.tokens)) tokens = entry.tokens.map((t) => ({ last4: (t.last4 || "").replace(/\D/g, "").slice(-4), label: (t.label || "").trim() })).filter((t) => t.last4);
      else if (entry.last4) tokens = [{ last4: (entry.last4 || "").replace(/\D/g, "").slice(-4), label: "" }].filter((t) => t.last4); // migrate old single last4
    } else return;
    name = name.trim();
    if (/^[\u2022\s]*\d{2,4}$/.test(name)) return; // drop junk digit-only "cards"
    if (!name || seen.has(name)) return;
    seen.add(name); out.push({ name, tokens });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
// ---- card store: a keyed map at meta/cards -> { cards: { <name>: { tokens: { <last4>: {label} } } } }
// In memory we keep the array shape the UI already uses; only reads/writes change.
function cardsMapToArray(map) {
  return Object.entries(map || {})
    .map(([name, v]) => ({
      name,
      color: (v && v.color) || "",
      stmtDay: (v && typeof v.stmtDay === "number") ? v.stmtDay : null,
      tokens: Object.entries((v && v.tokens) || {})
        .map(([last4, t]) => ({ last4: String(last4).replace(/\D/g, "").slice(-4), label: (t && t.label) || "" }))
        .filter((t) => t.last4)
        .sort((a, b) => a.last4.localeCompare(b.last4))
    }))
    .filter((c) => c.name && !/^[\u2022\s]*\d{2,4}$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const cardsRef = () => doc(db, "meta", "cards");

async function busyWrite(fn) {
  state.cardBusy = true; render();
  try { return await fn(); } catch (e) { console.error(e); } finally { state.cardBusy = false; render(); }
}
async function addCard(name) {
  name = (name || "").trim(); if (!name) return "";
  if (!CARDS.some((c) => c.name === name)) {
    await busyWrite(() => setDoc(cardsRef(), { cards: { [name]: { tokens: {} } } }, { merge: true }));
  }
  return name;
}
async function linkToken(cardName, last4, label) {
  last4 = (last4 || "").replace(/\D/g, "").slice(-4); if (!cardName || !last4) return;
  await busyWrite(() => setDoc(cardsRef(), { cards: { [cardName]: { tokens: { [last4]: { label: (label || "").trim() } } } } }, { merge: true }));
}
async function removeToken(cardName, last4) {
  last4 = (last4 || "").replace(/\D/g, "").slice(-4); if (!cardName || !last4) return;
  await busyWrite(() => updateDoc(cardsRef(), new FieldPath("cards", cardName, "tokens", last4), deleteField()));
}
async function removeCard(name) {
  if (!name) return;
  await busyWrite(() => updateDoc(cardsRef(), new FieldPath("cards", name), deleteField()));
}
async function setCardColor(name, color) {
  if (!name) return;
  await busyWrite(() => setDoc(cardsRef(), { cards: { [name]: { color } } }, { merge: true }));
}
async function setCardStmtDay(name, day) {
  if (!name) return;
  const raw = String(day).trim();
  const val = raw === "" ? deleteField() : Math.max(1, Math.min(31, parseInt(raw, 10) || 1));
  await busyWrite(() => setDoc(cardsRef(), { cards: { [name]: { stmtDay: val } } }, { merge: true }));
}
async function renameCard(oldName, newName) {
  oldName = (oldName || "").trim(); newName = (newName || "").trim();
  if (!oldName || !newName || oldName === newName) return;
  if (CARDS.some((c) => c.name === newName)) { alert("A card named \"" + newName + "\" already exists."); return; }
  const src = CARDS.find((c) => c.name === oldName); if (!src) return;
  const tokensMap = {}; (src.tokens || []).forEach((t) => { if (t.last4) tokensMap[t.last4] = { label: t.label || "" }; });
  await busyWrite(async () => {
    await setDoc(cardsRef(), { cards: { [newName]: { tokens: tokensMap, color: src.color || "" } } }, { merge: true });
    await updateDoc(cardsRef(), new FieldPath("cards", oldName), deleteField());
    for (const r of RECEIPTS.filter((r) => r.card === oldName)) {
      try { await updateDoc(doc(db, "receipts", r.id), { card: newName }); } catch (e) { console.error(e); }
    }
  });
}
async function saveReceiptEdit() {
  const e2 = state.edit; if (!e2) return;
  try {
    await updateDoc(doc(db, "receipts", e2.id), {
      date: e2.date || todayISO(),
      amount: e2.amount,
      category: CATEGORIES.includes(e2.category) ? e2.category : "Other",
      note: (e2.note || "").trim(),
      tags: parseTags(e2.tags)
    });
    state.edit = null; render();
  } catch (err) { alert("Couldn't save the edit: " + (err.message || err)); }
}
async function deleteAllReceipts() {
  for (const r of [...RECEIPTS]) {
    try { if (r.imagePath) await deleteObject(ref(storage, r.imagePath)).catch(() => {}); await deleteDoc(doc(db, "receipts", r.id)); } catch (e) { console.error(e); }
  }
}

// ---------- capture ----------
function startCapture() {
  state.view = "capture";
  state.cap = { img: null, date: todayISO(), merchant: "", amount: "", currency: "USD", card: "", last4: "", tokenLabel: "", linkLast4: "", linkLabel: "", category: "Other", hcsa: false, note: "", tags: "", reading: false, err: false, addingCard: false, loadingPdf: false, saving: false };
  render();
}
function onFileInput(ev) { const f = ev.target.files && ev.target.files[0]; ev.target.value = ""; if (f) processFile(f); }
async function processFile(file) {
  if (!state.cap) return;
  state.cap.err = false;
  try {
    let dataUrl;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (isPdf) { state.cap.loadingPdf = true; render(); dataUrl = await pdfFirstPageToJpeg(file); state.cap.loadingPdf = false; }
    else { dataUrl = await resizeImage(file); }
    state.cap.img = dataUrl;
    if (EXTRACT_URL) {
      state.cap.reading = true; render();
      try {
        const r = await extract(dataUrl);
        if (r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || "")) state.cap.date = r.date;
        state.cap.merchant = r.merchant || "";
        state.cap.amount = r.amount ? String(r.amount).replace(/[^0-9.]/g, "") : "";
        state.cap.last4 = (r.last4 || "").replace(/\D/g, "").slice(-4);
        const m = cardByLast4(state.cap.last4);
        if (m) { state.cap.card = m.card.name; state.cap.tokenLabel = m.token.label || ""; state.cap.linkLast4 = ""; }
        else if (state.cap.last4) { state.cap.linkLast4 = state.cap.last4; }
        state.cap.category = (r.category && CATEGORIES.includes(r.category)) ? r.category : (guessCategory(state.cap.merchant) || "Other");
      } catch (e) { state.cap.err = true; }
      state.cap.reading = false;
    }
  } catch (e) { state.cap.err = true; state.cap.loadingPdf = false; }
  render();
}
async function saveCapture() {
  const c = state.cap; if (!c || !c.img || c.saving) return;
  c.saving = true; render();
  const id = uid();
  try {
    const path = "receipts/" + id + ".jpg";
    await uploadString(ref(storage, path), c.img, "data_url");
    const imageUrl = await getDownloadURL(ref(storage, path));
    await setDoc(doc(db, "receipts", id), {
      date: c.date || todayISO(), merchant: c.merchant.trim(), amount: c.amount, currency: c.currency === "INR" ? "INR" : "USD",
      card: c.card.trim(), last4: (c.last4 || "").replace(/\D/g, "").slice(-4), tokenLabel: (c.tokenLabel || "").trim(),
      category: CATEGORIES.includes(c.category) ? c.category : "Other",
      hcsa: !!c.hcsa, note: c.note.trim(), tags: parseTags(c.tags),
      imagePath: path, imageUrl,
      ownerEmail: (USER.email || "").toLowerCase(), ownerName: USER.displayName || USER.email,
      createdAt: serverTimestamp(), addedAt: Date.now()
    });
    state.view = "list"; state.cap = null; render();
  } catch (e) {
    c.saving = false; c.err = true;
    alert("Couldn't save: " + (e.message || e));
    render();
  }
}
async function removeReceipt(r) {
  if (!confirm("Delete this receipt for good? The image goes with it.")) return;
  try {
    if (r.imagePath) await deleteObject(ref(storage, r.imagePath)).catch(() => {});
    await deleteDoc(doc(db, "receipts", r.id));
    if (state.openId === r.id) state.openId = null;
  } catch (e) { alert("Delete failed: " + (e.message || e)); }
}

// ---------- filtering ----------
function otherEmail() { return allowed.find((e) => e !== (USER && USER.email || "").toLowerCase()) || ""; }
function sortReceipts(arr) {
  const { by, dir } = state.sort;
  const mul = dir === "asc" ? 1 : -1;
  const ts = (r) => (typeof r.addedAt === "number") ? r.addedAt : (r.createdAt && r.createdAt.toMillis ? r.createdAt.toMillis() : 0);
  return [...arr].sort((a, b) => {
    const primary = (by === "amount")
      ? ((num(a.amount) || 0) - (num(b.amount) || 0))
      : String(a.date || "").localeCompare(String(b.date || ""));
    if (primary !== 0) return primary * mul;
    const t = ts(a) - ts(b);           // same day (or equal amount) -> order by entry time
    if (t !== 0) return t * mul;
    return String(a.id).localeCompare(String(b.id));
  });
}
function filtered() {
  const f = state.flt;
  const arr = RECEIPTS.filter((r) => {
    if (f.from && (r.date || "") < f.from) return false;
    if (f.to && (r.date || "") > f.to) return false;
    if (f.card && r.card !== f.card) return false;
    if (f.token && (r.tokenLabel || "") !== f.token) return false;
    if (f.currency && (r.currency === "INR" ? "INR" : "USD") !== f.currency) return false;
    if (f.category && (r.category || "Other") !== f.category) return false;
    if (f.owner === "mine" && (r.ownerEmail || "") !== (USER.email || "").toLowerCase()) return false;
    if (f.owner === "partner" && (r.ownerEmail || "") !== otherEmail()) return false;
    if (f.hcsaOnly && !r.hcsa) return false;
    if (f.text) { const t = f.text.toLowerCase(); if (!((r.merchant || "").toLowerCase().includes(t) || (r.note || "").toLowerCase().includes(t))) return false; }
    if (f.tag && !(r.tags || []).includes(f.tag)) return false;
    return true;
  });
  return sortReceipts(arr);
}
function exportCsv() {
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const rows = [["date", "merchant", "amount", "currency", "category", "card", "token", "last4", "hcsa", "tags", "added_by", "note", "image_url"]];
  filtered().forEach((r) => rows.push([r.date, r.merchant, r.amount, r.currency || "USD", r.category || "Other", r.card, r.tokenLabel || "", r.last4 || "", r.hcsa ? "yes" : "", (r.tags || []).join(" "), r.ownerName || r.ownerEmail || "", r.note, r.imageUrl || ""]));
  const url = URL.createObjectURL(new Blob([rows.map((x) => x.map(esc).join(",")).join("\n")], { type: "text/csv" }));
  const a = el("a", { href: url, download: "receipt-ledger.csv" }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- render ----------
let searchTimer = null;
function scheduleSearchRender() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.focusSearch = true; render(); }, 300);
}
function render() {
  const root = $("#app"); root.textContent = "";
  if (state.screen === "loading") return root.append(el("div", { class: "empty" }, "Opening the ledger\u2026"));
  if (state.screen === "signin") return root.append(renderSignIn());
  if (state.screen === "denied") return root.append(renderDenied());

  const go = (v) => { state.menuOpen = false; state.view = v; render(); };
  root.append(el("header", { class: "app" }, [
    el("div", {}, [
      el("div", { class: "eyebrow" }, "Receipt Ledger \u00b7 " + firstName(USER.displayName || USER.email)),
      el("h1", {}, "Every slip, filed by the date you'll search for it.")
    ]),
    el("div", { class: "head-actions" }, [
      el("button", { class: "btn primary", onclick: startCapture }, "Capture receipt"),
      el("div", { class: "menu-wrap" }, [
        el("button", { class: "menu-btn", "aria-label": "Menu", onclick: () => { state.menuOpen = !state.menuOpen; render(); } }, "\u2630"),
        ...(state.menuOpen ? [
          el("div", { class: "menu-overlay", onclick: () => { state.menuOpen = false; render(); } }),
          el("div", { class: "menu-pop" }, [
            el("div", { class: "menu-who" }, USER.email || ""),
            el("button", { class: "menu-item", onclick: () => go("dash") }, "Dashboard"),
            el("button", { class: "menu-item", onclick: () => go("stmt") }, "Statements"),
            el("button", { class: "menu-item", onclick: () => go("cards") }, "Manage Cards"),
            el("button", { class: "menu-item", onclick: () => go("export") }, "Backup / Export"),
            el("div", { class: "menu-sep" }),
            el("button", { class: "menu-item danger", onclick: () => { state.menuOpen = false; doSignOut(); } }, "Sign Out")
          ])
        ] : [])
      ])
    ])
  ]));

  const busy = (state.cap && state.cap.reading) ? "Reading the receipt\u2026"
    : (state.cap && state.cap.loadingPdf) ? "Rendering PDF\u2026"
    : (state.cap && state.cap.saving) ? "Saving\u2026"
    : state.cardBusy ? "Saving\u2026"
    : state.backupBusy ? "Preparing backup\u2026" : "";
  if (busy) root.append(el("div", { class: "busy-overlay" }, el("div", { class: "busy-box" }, [
    el("div", { class: "spinner" }), el("div", { class: "busy-label" }, busy)
  ])));

  if (state.view === "capture") return root.append(renderCapture());
  if (state.view === "cards") return root.append(renderManageCards());
  if (state.view === "dash") return root.append(renderDash());
  if (state.view === "stmt") return root.append(renderStatements());
  if (state.view === "export") return root.append(renderExport());

  const cards = cardNames();
  // ---- monthly backup reminder (previous full month; dismissal syncs across devices) ----
  const bmk = backupMonthKey();
  if (!state.backupDone[bmk]) {
    root.append(el("div", { class: "backup-banner" }, [
      el("span", { class: "bb-text" }, "Back up " + monthName(bmk) + " \u2014 spreadsheet + receipt images."),
      el("span", { class: "bb-actions" }, [
        el("button", { class: "btn primary", ...(state.backupBusy ? { disabled: "disabled" } : {}), onclick: doBackup }, state.backupBusy ? "Preparing\u2026" : "Download Backup"),
        el("button", { class: "link", onclick: () => markBackupDone(bmk, "dismissed") }, "Dismiss")
      ])
    ]));
  }

  // ---- collapsible filter panel (default collapsed); summary shows the date range too ----
  const summ = activeFilterSummary();
  const summaryText = [dateSummary(), ...summ].join(" \u00b7 ");
  root.append(el("div", { class: "filter-bar" }, [
    el("button", { class: "filter-toggle" + (state.filtersOpen ? " open" : ""), onclick: () => { state.filtersOpen = !state.filtersOpen; render(); } }, [
      el("span", {}, (state.filtersOpen ? "\u2715 " : "\u2699 ") + "Filters"),
      summ.length ? el("span", { class: "filter-count" }, String(summ.length)) : null
    ]),
    el("span", { class: "filter-summary" }, summaryText),
    el("span", { class: "bar-sort" }, sortSelect())
  ]));
  if (state.filtersOpen) {
    root.append(el("section", { class: "filters" }, [
      el("div", { class: "f-row" }, [
        labelInput("From", el("input", { class: "mono", type: "date", value: state.flt.from, oninput: (e) => { state.flt.from = e.target.value; render(); } }), "from"),
        labelInput("To", el("input", { class: "mono", type: "date", value: state.flt.to, oninput: (e) => { state.flt.to = e.target.value; render(); } }), "to"),
        el("label", { class: "f card" }, ["Range", el("div", { class: "scope-btns" }, [
          el("button", { class: "chip" + (isThisMonth() ? " on" : ""), onclick: () => { const mr = monthRange(); state.flt.from = mr.from; state.flt.to = mr.to; render(); } }, "This month"),
          el("button", { class: "chip" + (isLastMonth() ? " on" : ""), onclick: () => { const mr = lastMonthRange(); state.flt.from = mr.from; state.flt.to = mr.to; render(); } }, "Last month"),
          el("button", { class: "chip" + ((!state.flt.from && !state.flt.to) ? " on" : ""), onclick: () => { state.flt.from = ""; state.flt.to = ""; render(); } }, "All dates")
        ])])
      ]),
      el("div", { class: "f-row" }, [
        labelInput("Card", selectFrom(["", ...cards], state.flt.card, (v) => { state.flt.card = v; render(); }, "Any"), "card"),
        labelInput("Category", selectFrom(["", ...CATEGORIES], state.flt.category, (v) => { state.flt.category = v; render(); }, "Any"), "card"),
        allTokenLabels().length ? labelInput("Token / phone", selectFrom(["", ...allTokenLabels()], state.flt.token, (v) => { state.flt.token = v; render(); }, "Any"), "card") : null,
        allTags().length ? labelInput("Tag", selectFrom(["", ...allTags()], state.flt.tag, (v) => { state.flt.tag = v; render(); }, "Any"), "card") : null
      ]),
      el("div", { class: "f-row" }, [
        labelInput("Search", el("input", { id: "search-input", value: state.flt.text, placeholder: "merchant or note", oninput: (e) => { state.flt.text = e.target.value; scheduleSearchRender(); } }), "grow"),
        ownerChips(),
        curChips(),
        el("button", { class: "chip" + (state.flt.hcsaOnly ? " on" : ""), onclick: () => { state.flt.hcsaOnly = !state.flt.hcsaOnly; render(); } }, "HCSA only"),
        summ.length ? el("button", { class: "link", onclick: () => { state.flt = { ...state.flt, card: "", token: "", category: "", currency: "", owner: "", hcsaOnly: false, text: "", tag: "" }; render(); } }, "Clear filters") : null
      ])
    ]));
  }

  const list = filtered();
  const totals = {};
  list.forEach((r) => { const cur = r.currency === "INR" ? "INR" : "USD"; totals[cur] = (totals[cur] || 0) + (num(r.amount) || 0); });
  const totalStr = Object.keys(totals).length ? Object.keys(totals).sort().map((cur) => money(totals[cur], cur)).join("  \u00b7  ") : money(0, "USD");

  // reset to page 1 whenever the filter set changes
  const sig = JSON.stringify(state.flt);
  if (sig !== state.fltSig) { state.fltSig = sig; state.page = 1; }
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  if (state.page < 1) state.page = 1;
  const startIdx = (state.page - 1) * PAGE_SIZE;
  const pageItems = list.slice(startIdx, startIdx + PAGE_SIZE);

  root.append(el("div", { class: "summary" }, [
    el("span", {}, list.length + " receipt" + (list.length === 1 ? "" : "s")),
    el("span", { class: "mono" }, totalStr),
    RECEIPTS.length ? el("button", { class: "link spacer", onclick: exportCsv }, "Export CSV") : el("span", { class: "spacer" })
  ]));

  if (!RECEIPTS.length) {
    root.append(el("div", { class: "empty" }, [
      el("p", { class: "big" }, "No receipts yet."),
      el("p", {}, "Snap one \u2014 it'll show up on both your phones."),
      el("button", { class: "btn primary", onclick: startCapture }, "Capture your first receipt")
    ]));
  } else if (!list.length) {
    root.append(el("div", { class: "empty" }, el("p", {}, "Nothing matches those filters.")));
  } else {
    const ul = el("ul", { class: "list" });
    pageItems.forEach((r) => ul.append(renderReceipt(r)));
    root.append(ul);
    if (pages > 1) {
      root.append(el("div", { class: "pager" }, [
        el("button", { class: "btn ghost", ...(state.page <= 1 ? { disabled: "disabled" } : {}), onclick: () => { state.page--; render(); window.scrollTo(0, 0); } }, "\u2039 Prev"),
        el("span", { class: "pager-info mono" }, "Page " + state.page + " of " + pages),
        el("button", { class: "btn ghost", ...(state.page >= pages ? { disabled: "disabled" } : {}), onclick: () => { state.page++; render(); window.scrollTo(0, 0); } }, "Next \u203a")
      ]));
    }
  }

  if (state.focusSearch) {
    state.focusSearch = false;
    const si = $("#search-input");
    if (si) { si.focus(); const L = si.value.length; try { si.setSelectionRange(L, L); } catch (e) {} }
  }
}

function renderSignIn() {
  return el("div", { class: "gate" }, [
    el("div", { class: "eyebrow" }, "Receipt Ledger"),
    el("h1", {}, "A shared receipt ledger for the two of you."),
    el("p", { class: "gate-note" }, "Sign in with the Google account you set up for this."),
    el("button", { class: "btn primary", onclick: doSignIn }, "Sign in with Google")
  ]);
}
function renderDenied() {
  return el("div", { class: "gate" }, [
    el("h1", {}, "That account isn't on the list."),
    el("p", { class: "gate-note" }, (USER.email || "") + " isn't one of the two allowed accounts. Sign in with the right one."),
    el("button", { class: "btn ghost", onclick: doSignOut }, "Switch account")
  ]);
}

function labelInput(text, input, cls) { return el("label", { class: "f " + (cls || "") }, [text, input]); }
function selectFrom(values, current, onchange, anyLabel) {
  const s = el("select", { onchange: (e) => onchange(e.target.value) },
    values.map((v) => el("option", { value: v }, v === "" ? (anyLabel || "\u2014") : v)));
  s.value = current || "";
  return s;
}
const SORT_OPTIONS = [
  ["date|desc", "Date \u2193 newest"], ["date|asc", "Date \u2191 oldest"],
  ["amount|desc", "Amount \u2193 high"], ["amount|asc", "Amount \u2191 low"]
];
function sortSelect() {
  const cur = state.sort.by + "|" + state.sort.dir;
  const s = el("select", { class: "sort-sel", onchange: (e) => { const p = e.target.value.split("|"); state.sort = { by: p[0], dir: p[1] }; state.page = 1; render(); } },
    SORT_OPTIONS.map(([v, label]) => el("option", { value: v }, label)));
  s.value = cur;
  return s;
}
function dateSummary() {
  const f = state.flt;
  if (isThisMonth()) return "This month";
  if (isLastMonth()) return "Last month";
  if (!f.from && !f.to) return "All dates";
  if (f.from && f.to) return f.from + " \u2192 " + f.to;
  if (f.from) return "from " + f.from;
  return "until " + f.to;
}
function activeFilterSummary() {
  const f = state.flt, parts = [];
  if (f.card) parts.push(f.card);
  if (f.category) parts.push(f.category);
  if (f.token) parts.push(f.token);
  if (f.currency) parts.push(f.currency === "INR" ? "\u20b9" : "$");
  if (f.owner === "mine") parts.push("Mine");
  if (f.owner === "partner") parts.push(firstName(otherEmail()));
  if (f.hcsaOnly) parts.push("HCSA");
  if (f.tag) parts.push("#" + f.tag);
  if (f.text) parts.push('"' + f.text + '"');
  return parts;
}
function ownerChips() {
  const set = (v) => { state.flt.owner = state.flt.owner === v ? "" : v; render(); };
  return el("span", { class: "owner-chips" }, [
    el("button", { class: "chip" + (state.flt.owner === "mine" ? " on" : ""), onclick: () => set("mine") }, "Mine"),
    el("button", { class: "chip" + (state.flt.owner === "partner" ? " on" : ""), onclick: () => set("partner") }, firstName(otherEmail()))
  ]);
}
function curChips() {
  const set = (v) => { state.flt.currency = state.flt.currency === v ? "" : v; render(); };
  return el("span", { class: "owner-chips" }, [
    el("button", { class: "chip" + (state.flt.currency === "USD" ? " on" : ""), onclick: () => set("USD") }, "$"),
    el("button", { class: "chip" + (state.flt.currency === "INR" ? " on" : ""), onclick: () => set("INR") }, "\u20b9")
  ]);
}
function renderCardPicker(c) {
  if (c.addingCard) {
    let val = "";
    return el("div", { class: "card-add" }, [
      el("input", { placeholder: "New card name (e.g. Chase Sapphire)", oninput: (e) => val = e.target.value }),
      el("button", { class: "btn primary", onclick: async () => { const n = await addCard(val); if (n) c.card = n; c.addingCard = false; render(); } }, "Add"),
      el("button", { class: "btn ghost", onclick: () => { c.addingCard = false; render(); } }, "Cancel")
    ]);
  }
  const s = el("select", {
    onchange: (e) => {
      const v = e.target.value;
      if (v === "__add__") { c.addingCard = true; }
      else { c.card = v; if (!c.linkLast4) c.tokenLabel = ""; }
      render();
    }
  }, [
    el("option", { value: "" }, "Select a card"),
    ...CARDS.map((x) => el("option", { value: x.name }, x.name + (tokensOf(x).length ? "  (" + tokensOf(x).length + ")" : ""))),
    el("option", { value: "__add__" }, "\u2795 Add a card\u2026")
  ]);
  s.value = cardNames().includes(c.card) ? c.card : "";
  return s;
}
function renderLinkRow(c) {
  const canRemember = !!c.card && cardNames().includes(c.card);
  return el("div", { class: "link-row" }, [
    el("div", { class: "detect-note" }, "Receipt shows \u2022\u2022" + c.linkLast4 + " \u2014 if that's a real card, pick the card above, label the token, and remember it:"),
    el("input", { class: "link-label", value: c.linkLabel, placeholder: "token label (e.g. Apple Pay \u2013 wife's phone)", oninput: (e) => c.linkLabel = e.target.value }),
    el("div", { class: "link-actions" }, [
      el("button", { class: "btn primary", ...(canRemember ? {} : { disabled: "disabled" }), onclick: async () => { await linkToken(c.card, c.linkLast4, c.linkLabel); c.tokenLabel = (c.linkLabel || "").trim(); c.linkLast4 = ""; c.linkLabel = ""; render(); } }, canRemember ? "Remember on " + c.card : "Pick a card first"),
      el("button", { class: "btn ghost", onclick: () => { c.linkLast4 = ""; c.last4 = ""; c.linkLabel = ""; render(); } }, "Not a card")
    ])
  ]);
}

function renderCapture() {
  const c = state.cap;
  const shot = c.img
    ? el("div", { class: "shot" }, [el("img", { src: c.img, alt: "receipt" })])
    : el("div", { class: "drop" }, c.loadingPdf ? [el("div", { class: "reading" }, "Rendering PDF\u2026")] : [
        el("button", { class: "btn primary", onclick: () => $("#fileCam").click() }, "\uD83D\uDCF7 Take photo"),
        el("button", { class: "btn ghost", onclick: () => $("#fileImg").click() }, "\uD83D\uDDBC\uFE0F Upload image"),
        el("button", { class: "btn ghost", onclick: () => $("#filePdf").click() }, "\uD83D\uDCC4 Upload PDF"),
        el("div", { class: "drop-note" }, "a photo, an image file, or a PDF (first page)")
      ]);

  return el("section", { class: "panel" }, [
    el("div", { class: "cap-grid" }, [
      shot,
      el("div", { class: "fields" }, [
        c.err ? el("div", { class: "notice" }, "Couldn't read that one automatically. Type the details in \u2014 the file is still saved.") : null,
        field("Date", el("input", { class: "mono", type: "date", value: c.date, oninput: (e) => c.date = e.target.value })),
        field("Merchant", el("input", { value: c.merchant, placeholder: "e.g. Corner Pharmacy", oninput: (e) => c.merchant = e.target.value })),
        field("Amount", el("input", { class: "mono", value: c.amount, placeholder: "0.00", inputmode: "decimal", oninput: (e) => c.amount = e.target.value })),
        field("Currency", el("div", { class: "seg" }, [
          el("button", { class: "seg-btn" + (c.currency !== "INR" ? " on" : ""), onclick: () => { c.currency = "USD"; render(); } }, "$ USD"),
          el("button", { class: "seg-btn" + (c.currency === "INR" ? " on" : ""), onclick: () => { c.currency = "INR"; render(); } }, "\u20b9 INR")
        ])),
        field("Card used", renderCardPicker(c)),
        c.linkLast4 ? renderLinkRow(c)
          : (c.last4 && cardByLast4(c.last4))
            ? el("div", { class: "detect-note ok" }, "Recognized \u2022\u2022" + c.last4 + " \u2192 " + cardByLast4(c.last4).card.name + (cardByLast4(c.last4).token.label ? " (" + cardByLast4(c.last4).token.label + ")" : ""))
            : null,
        field("Category", selectFrom(CATEGORIES, c.category, (v) => { c.category = v; })),
        el("button", { class: "hcsa-toggle" + (c.hcsa ? " on" : ""), onclick: () => { c.hcsa = !c.hcsa; render(); } }, [
          el("span", { class: "box" }, c.hcsa ? "\u2713" : ""), "Flag as HCSA / reimbursable"
        ]),
        field("Note (optional)", el("input", { value: c.note, placeholder: "what it was for", oninput: (e) => c.note = e.target.value })),
        field("Tags (optional)", tagsField(() => c.tags, (v) => c.tags = v)),
        el("div", { class: "cap-actions" }, [
          el("button", { class: "btn ghost", onclick: () => { state.view = "list"; state.cap = null; render(); } }, "Cancel"),
          el("button", { class: "btn primary", ...((!c.img || c.reading || c.saving) ? { disabled: "disabled" } : {}), onclick: saveCapture }, c.saving ? "Saving\u2026" : "Save to ledger")
        ])
      ])
    ])
  ]);
}
function field(text, input) { return el("label", {}, [text, input]); }

function renderManageCards() {
  return el("section", { class: "panel" }, [
    el("div", { class: "manage-head" }, [
      el("h2", { class: "manage-h" }, "Your cards"),
      el("button", { class: "btn ghost", onclick: () => { state.view = "list"; render(); } }, "Done")
    ]),
    el("p", { class: "gate-note" }, "One card can hold several \u2022\u2022last-4 tokens \u2014 physical, Apple Pay, a phone. Tokens are learned when you link them on a receipt; any receipt printing one of them auto-selects this card."),
    CARDS.length
      ? el("ul", { class: "card-list" }, CARDS.map((c) => el("li", { class: "card-block" }, [
          el("div", { class: "card-row" }, [
            el("span", { class: "card-name-wrap" }, [
              el("input", { type: "color", class: "card-swatch", value: colorForCard(c.name), onchange: async (e) => { await setCardColor(c.name, e.target.value); } }),
              el("span", { class: "card-name" }, c.name)
            ]),
            el("span", { class: "card-row-actions" }, [
              el("button", { class: "link", onclick: async () => { const n = prompt("Rename card", c.name); if (n && n.trim() && n.trim() !== c.name) { await renameCard(c.name, n); render(); } } }, "Rename"),
              el("button", { class: "link danger", onclick: async () => { if (confirm("Remove card \"" + c.name + "\" and all its tokens?")) { await removeCard(c.name); render(); } } }, "Remove")
            ])
          ]),
          el("div", { class: "card-stmt" }, [
            el("span", { class: "card-stmt-lbl" }, "Statement closes on day"),
            el("input", { type: "number", min: "1", max: "31", class: "stmt-day-input mono", value: c.stmtDay || "", placeholder: "\u2014", onchange: async (e) => { await setCardStmtDay(c.name, e.target.value); render(); } })
          ]),
          tokensOf(c).length
            ? el("ul", { class: "token-list" }, tokensOf(c).map((t) => el("li", { class: "token-row" }, [
                el("span", { class: "mono" }, "\u2022\u2022" + t.last4),
                el("span", { class: "token-label" }, t.label || "(no label)"),
                el("button", { class: "link danger", onclick: async () => { await removeToken(c.name, t.last4); render(); } }, "\u00d7")
              ])))
            : el("p", { class: "token-empty" }, "no tokens yet")
        ])))
      : el("p", { class: "gate-note" }, "No cards yet \u2014 they're added as you use them."),
    el("div", { class: "danger-zone" }, [
      el("h3", { class: "dz-h" }, "Danger zone"),
      el("p", { class: "gate-note" }, "Export first (from the list screen). This deletes every receipt for both of you, including the images, and cannot be undone."),
      el("button", { class: "btn danger-btn", onclick: doDeleteAll }, "Delete ALL receipts")
    ])
  ]);
}
async function doDeleteAll() {
  if (!RECEIPTS.length) { alert("There are no receipts to delete."); return; }
  if (!confirm("Delete ALL " + RECEIPTS.length + " receipts for BOTH of you, permanently? Images are deleted too.")) return;
  if (!confirm("Last check \u2014 this is irreversible. Really delete everything?")) return;
  await deleteAllReceipts();
  render();
}

function renderReceipt(r) {
  const li = el("li", { class: "receipt", style: "border-left:4px solid " + colorForCard(r.card) });
  li.append(el("button", { class: "r-main", onclick: () => { if (state.edit && state.edit.id !== r.id) state.edit = null; state.openId = state.openId === r.id ? null : r.id; render(); } }, [
    el("span", { class: "r-date mono" }, r.date || "\u2014"),
    el("span", { class: "r-mid" }, [
      el("span", { class: "r-merch" }, r.merchant || "Unnamed merchant"),
      el("span", { class: "r-meta" }, [
        r.card ? el("span", { class: "r-card", style: "border-left:3px solid " + colorForCard(r.card) }, r.card) : null,
        (r.category && r.category !== "Other") ? el("span", { class: "r-cat" }, r.category) : null,
        r.hcsa ? el("span", { class: "tag-hcsa" }, "HCSA") : null,
        el("span", { class: "r-owner" }, firstName(r.ownerName || r.ownerEmail))
      ])
    ]),
    el("span", { class: "r-amt mono" }, money(r.amount, r.currency))
  ]));
  if (state.openId === r.id) {
    const editing = state.edit && state.edit.id === r.id;
    li.append(el("div", { class: "r-detail" }, [
      r.imageUrl ? el("img", { src: r.imageUrl, alt: "receipt" }) : el("div", { class: "reading" }, "No image."),
      (r.card || r.tokenLabel || r.last4) ? el("p", { class: "r-pay mono" }, "Paid: " + (r.card || "\u2014") + (r.tokenLabel ? " \u00b7 " + r.tokenLabel : "") + (r.last4 ? " \u00b7 \u2022\u2022" + r.last4 : "")) : null,
      r.note ? el("p", { class: "r-note" }, r.note) : null,
      (r.tags && r.tags.length) ? el("div", { class: "r-tags" }, r.tags.map((t) => el("span", { class: "r-tag" }, "#" + t))) : null,
      editing ? renderEditForm() : el("div", { class: "r-detail-actions" }, [
        el("button", { class: "link", onclick: () => { state.edit = { id: r.id, date: r.date || todayISO(), amount: r.amount || "", category: r.category || "Other", note: r.note || "", tags: tagsToStr(r.tags) }; render(); } }, "Edit"),
        r.imageUrl ? el("a", { class: "link", href: r.imageUrl, target: "_blank", rel: "noopener", download: "" }, "Download image") : null,
        el("button", { class: "link danger", onclick: () => removeReceipt(r) }, "Delete")
      ])
    ]));
  }
  return li;
}
function renderEditForm() {
  const e2 = state.edit;
  return el("div", { class: "edit-form" }, [
    el("div", { class: "edit-fields" }, [
      el("label", {}, ["Date", el("input", { class: "mono", type: "date", value: e2.date, oninput: (ev) => e2.date = ev.target.value })]),
      el("label", {}, ["Amount", el("input", { class: "mono", value: e2.amount, inputmode: "decimal", oninput: (ev) => e2.amount = ev.target.value })]),
      el("label", {}, ["Category", selectFrom(CATEGORIES, e2.category, (v) => { e2.category = v; })]),
      el("label", {}, ["Note", el("input", { value: e2.note, placeholder: "what it was for", oninput: (ev) => e2.note = ev.target.value })]),
      el("label", {}, ["Tags", tagsField(() => e2.tags, (v) => e2.tags = v)])
    ]),
    el("div", { class: "cap-actions" }, [
      el("button", { class: "btn ghost", onclick: () => { state.edit = null; render(); } }, "Cancel"),
      el("button", { class: "btn primary", onclick: saveReceiptEdit }, "Save changes")
    ])
  ]);
}

// ---------- dashboard ----------
function renderDash() {
  const cur = state.dash.currency, seg = state.dash.seg, range = state.dash.range;
  const rs = RECEIPTS.filter((r) => (r.currency === "INR" ? "INR" : "USD") === cur);
  const months = rangeMonths(range, rs);
  const mset = new Set(months);
  const inRange = rs.filter((r) => mset.has(monthKeyOf(r.date)));
  const total = inRange.reduce((s, r) => s + (num(r.amount) || 0), 0);
  const byCard = aggregate(inRange, (r) => r.card || "\u2014");
  const byCat = aggregate(inRange, (r) => r.category || "Other");
  const RANGES = [["1m", "1M"], ["3m", "3M"], ["6m", "6M"], ["12m", "12M"], ["ytd", "YTD"], ["all", "All"]];

  return el("section", { class: "panel dash" }, [
    el("div", { class: "manage-head" }, [
      el("h2", { class: "manage-h" }, "Dashboard"),
      el("button", { class: "btn ghost", onclick: () => { state.view = "list"; render(); } }, "Done")
    ]),
    el("div", { class: "seg", style: "margin:4px 0 12px" }, [
      el("button", { class: "seg-btn" + (cur !== "INR" ? " on" : ""), onclick: () => { state.dash.currency = "USD"; render(); } }, "$ USD"),
      el("button", { class: "seg-btn" + (cur === "INR" ? " on" : ""), onclick: () => { state.dash.currency = "INR"; render(); } }, "\u20b9 INR")
    ]),
    el("div", { class: "scope-btns dash-ranges" }, RANGES.map(([k, lbl]) => el("button", { class: "chip" + (range === k ? " on" : ""), onclick: () => { state.dash.range = k; render(); } }, lbl))),
    el("div", { class: "dash-total" }, [el("span", { class: "dash-total-label" }, rangeLabel(range)), el("span", { class: "mono dash-total-val" }, money(total, cur))]),
    el("h3", { class: "dash-h" }, "By card"),
    breakdownList(byCard, total, cur, "card"),
    el("h3", { class: "dash-h" }, "By category"),
    breakdownList(byCat, total, cur, "category"),
    el("div", { class: "dash-hist-head" }, [
      el("h3", { class: "dash-h", style: "margin:0" }, "Monthly trend"),
      el("div", { class: "scope-btns" }, [
        el("button", { class: "chip" + (seg === "card" ? " on" : ""), onclick: () => { state.dash.seg = "card"; render(); } }, "By card"),
        el("button", { class: "chip" + (seg === "category" ? " on" : ""), onclick: () => { state.dash.seg = "category"; render(); } }, "By category")
      ])
    ]),
    stackedChart(rs, months, seg, cur)
  ]);
}
function rangeLabel(k) { return { "1m": "This month", "3m": "Last 3 months", "6m": "Last 6 months", "12m": "Last 12 months", "ytd": "This year", "all": "All time" }[k] || "Last 12 months"; }
function rangeMonths(preset, rs) {
  const now = new Date();
  if (preset === "1m") return monthsBack(1);
  if (preset === "3m") return monthsBack(3);
  if (preset === "6m") return monthsBack(6);
  if (preset === "12m") return monthsBack(12);
  if (preset === "ytd") { const out = []; for (let m = 0; m <= now.getMonth(); m++) out.push(now.getFullYear() + "-" + String(m + 1).padStart(2, "0")); return out; }
  const keys = rs.map((r) => monthKeyOf(r.date)).filter(Boolean).sort();
  if (!keys.length) return monthsBack(1);
  let [fy, fm] = keys[0].split("-").map(Number); const ny = now.getFullYear(), nm = now.getMonth() + 1, out = [];
  while (fy < ny || (fy === ny && fm <= nm)) { out.push(fy + "-" + String(fm).padStart(2, "0")); fm++; if (fm > 12) { fm = 1; fy++; } if (out.length > 120) break; }
  return out;
}
function breakdownList(items, total, cur, mode) {
  if (!items.length) return el("p", { class: "gate-note" }, "Nothing this month.");
  return el("ul", { class: "dash-list" }, items.map((it) => {
    const pct = total > 0 ? Math.round(it.v / total * 100) : 0;
    const color = segColor(it.k, mode);
    return el("li", { class: "dash-row" }, [
      el("span", { class: "dash-dot", style: "background:" + color }),
      el("span", { class: "dash-name" }, it.k),
      el("span", { class: "dash-bar-wrap" }, el("span", { class: "dash-bar", style: "width:" + pct + "%;background:" + color })),
      el("span", { class: "mono dash-amt" }, money(it.v, cur)),
      el("span", { class: "dash-pct mono" }, pct + "%")
    ]);
  }));
}
function stackedChart(rs, months, seg, cur) {
  const keyFn = seg === "card" ? ((r) => r.card || "\u2014") : ((r) => r.category || "Other");
  const data = {}; const segTotals = {};
  months.forEach((m) => data[m] = {});
  rs.forEach((r) => { const mk = monthKeyOf(r.date); if (!(mk in data)) return; const k = keyFn(r); const v = num(r.amount) || 0; if (v <= 0) return; data[mk][k] = (data[mk][k] || 0) + v; segTotals[k] = (segTotals[k] || 0) + v; });
  const segs = Object.keys(segTotals).sort((a, b) => segTotals[b] - segTotals[a]);
  const monthTotals = months.map((m) => Object.values(data[m]).reduce((s, v) => s + v, 0));
  const max = Math.max(1, ...monthTotals);
  if (!segs.length) return el("p", { class: "gate-note" }, "No spend recorded in this currency yet.");

  const W = 340, H = 172, padB = 20, padT = 6, padL = 4, padR = 4;
  const plotH = H - padB - padT, bw = (W - padL - padR) / months.length;
  const step = Math.ceil(months.length / 12);
  const parts = [];
  months.forEach((m, i) => {
    let y = padT + plotH;
    const x = padL + i * bw + bw * 0.15, w = bw * 0.7;
    segs.forEach((k) => {
      const v = data[m][k] || 0; if (v <= 0) return;
      const h = (v / max) * plotH; y -= h;
      parts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + segColor(k, seg) + '"/>');
    });
    if (i % step === 0 || i === months.length - 1) {
      const lbl = m.slice(5) + "/" + m.slice(2, 4);
      parts.push('<text x="' + (padL + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" font-size="7.5" text-anchor="middle" fill="#8A857C">' + lbl + '</text>');
    }
  });
  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="monthly spend chart">' + parts.join("") + '</svg>';
  return el("div", {}, [
    el("div", { class: "dash-max mono" }, "peak month: " + money(max, cur)),
    el("div", { class: "dash-chart", html: svg }),
    el("div", { class: "dash-legend" }, segs.map((k) => el("span", { class: "leg-item" }, [
      el("span", { class: "dash-dot", style: "background:" + segColor(k, seg) }),
      el("span", { class: "leg-name" }, k),
      el("span", { class: "mono leg-val" }, money(segTotals[k], cur))
    ])))
  ]);
}

// ---------- statement reconciliation ----------
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isoOf = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const isoToday = () => isoOf(new Date());
const clampDay = (day, y, m) => Math.min(day, new Date(y, m + 1, 0).getDate());
function fmtShort(isoStr) { const p = isoStr.split("-").map(Number); return MONTHS_SHORT[p[1] - 1] + " " + p[2]; }
function daysDiff(a, b) { return Math.abs((new Date(a) - new Date(b)) / 86400000); }
function nearEdge(dateIso, p, n) { return daysDiff(dateIso, p.end) <= n || daysDiff(dateIso, p.start) <= n; }
function statementPeriods(stmtDay, count) {
  const today = new Date(), closes = [];
  for (let i = -count - 1; i <= 1; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    closes.push(new Date(d.getFullYear(), d.getMonth(), clampDay(stmtDay, d.getFullYear(), d.getMonth())));
  }
  closes.sort((a, b) => a - b);
  const periods = [];
  for (let i = 1; i < closes.length; i++) { const s = new Date(closes[i - 1]); s.setDate(s.getDate() + 1); periods.push({ start: isoOf(s), end: isoOf(closes[i]) }); }
  const t = isoToday();
  return periods.filter((p) => p.start <= t).slice(-count).reverse();
}

function renderStatements() {
  const cur = state.stmt.currency;
  const withDay = CARDS.filter((c) => c.stmtDay);
  let cardName = state.stmt.card && CARDS.some((c) => c.name === state.stmt.card) ? state.stmt.card : (withDay[0] ? withDay[0].name : "");
  state.stmt.card = cardName;
  const card = CARDS.find((c) => c.name === cardName);
  const body = [
    el("div", { class: "seg", style: "margin:4px 0 12px" }, [
      el("button", { class: "seg-btn" + (cur !== "INR" ? " on" : ""), onclick: () => { state.stmt.currency = "USD"; render(); } }, "$ USD"),
      el("button", { class: "seg-btn" + (cur === "INR" ? " on" : ""), onclick: () => { state.stmt.currency = "INR"; render(); } }, "\u20b9 INR")
    ]),
    el("label", { class: "f card", style: "margin-bottom:12px" }, ["Card", selectFrom(["", ...cardNames()], cardName, (v) => { state.stmt.card = v; state.stmt.open = null; render(); }, "Select a card")])
  ];

  if (!card) body.push(el("p", { class: "gate-note" }, "Pick a card to reconcile."));
  else if (!card.stmtDay) body.push(el("p", { class: "gate-note" }, "\u201c" + card.name + "\u201d has no statement day set \u2014 add one in Manage cards."));
  else {
    const rs = RECEIPTS.filter((r) => r.card === card.name && (r.currency === "INR" ? "INR" : "USD") === cur);
    body.push(el("p", { class: "gate-note" }, "Closes on day " + card.stmtDay + " each month. \u26a0 marks charges within 3 days of a cycle edge \u2014 those may post to the neighboring statement."));
    const ul = el("ul", { class: "stmt-list" });
    statementPeriods(card.stmtDay, 12).forEach((p) => {
      const prs = rs.filter((r) => r.date >= p.start && r.date <= p.end).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const total = prs.reduce((s, r) => s + (num(r.amount) || 0), 0);
      const boundary = prs.filter((r) => nearEdge(r.date, p, 3));
      const isOpen = state.stmt.open === p.end;
      const current = p.end > isoToday();
      const row = el("li", { class: "stmt-period" }, [
        el("button", { class: "stmt-head", onclick: () => { state.stmt.open = isOpen ? null : p.end; render(); } }, [
          el("span", { class: "stmt-range" }, fmtShort(p.start) + " \u2013 " + fmtShort(p.end) + (current ? "  (current)" : "")),
          el("span", { class: "stmt-meta" }, [
            boundary.length ? el("span", { class: "stmt-warn" }, "\u26a0 " + boundary.length) : null,
            el("span", { class: "stmt-count" }, String(prs.length)),
            el("span", { class: "mono stmt-total" }, money(total, cur))
          ])
        ])
      ]);
      if (isOpen) {
        const det = el("ul", { class: "stmt-detail" });
        if (!prs.length) det.append(el("li", { class: "gate-note" }, "No charges in this cycle."));
        prs.forEach((r) => {
          const edge = nearEdge(r.date, p, 3);
          det.append(el("li", { class: "stmt-txn" + (edge ? " edge" : "") }, [
            el("span", { class: "mono stmt-tdate" }, r.date),
            el("span", { class: "stmt-tmerch" }, (edge ? "\u26a0 " : "") + (r.merchant || "\u2014")),
            el("span", { class: "mono" }, money(r.amount, cur))
          ]));
        });
        row.append(det);
      }
      ul.append(row);
    });
    body.push(ul);
  }

  return el("section", { class: "panel" }, [
    el("div", { class: "manage-head" }, [
      el("h2", { class: "manage-h" }, "Statement reconciliation"),
      el("button", { class: "btn ghost", onclick: () => { state.view = "list"; render(); } }, "Done")
    ]),
    ...body
  ]);
}

// ---------- monthly backup ----------
function loadScript(src, globalName) {
  return new Promise((res, rej) => {
    if (window[globalName]) return res(window[globalName]);
    const s = document.createElement("script"); s.src = src;
    s.onload = () => window[globalName] ? res(window[globalName]) : rej(new Error("load " + globalName));
    s.onerror = () => rej(new Error("network " + src));
    document.head.appendChild(s);
  });
}
function backupMonthKey() { return lastMonthRange().from.slice(0, 7); }
function monthName(mk) { const p = mk.split("-"); return MONTHS_SHORT[+p[1] - 1] + " " + p[0]; }
async function markBackupDone(month, action) {
  try { await setDoc(doc(db, "meta", "backup"), { done: { [month]: { action, by: (USER && USER.email) || "", at: Date.now() } } }, { merge: true }); } catch (e) { console.error(e); }
}
async function buildBackup(opts) {
  // opts: { filterFn, name, dateLabel, monthKeyToMark? }
  if (state.backupBusy) return;
  state.backupBusy = true; render();
  try {
    const [XLSX, JSZip] = await Promise.all([
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js", "XLSX"),
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", "JSZip")
    ]);
    const rs = RECEIPTS.filter(opts.filterFn).sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    const wb = XLSX.utils.book_new();
    const tx = [["Date", "Merchant", "Amount", "Currency", "Category", "Card", "Token", "Last4", "HCSA", "Tags", "Added by", "Note"]];
    rs.forEach((r) => tx.push([r.date || "", r.merchant || "", num(r.amount) || 0, r.currency || "USD", r.category || "Other", r.card || "", r.tokenLabel || "", r.last4 || "", r.hcsa ? "Yes" : "", (r.tags || []).join(" "), r.ownerName || r.ownerEmail || "", r.note || ""]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tx), "Transactions");

    const sum = [["Summary \u2014 " + (opts.dateLabel || "export")], [], ["By card"]];
    ["USD", "INR"].forEach((cur) => {
      const cr = rs.filter((r) => (r.currency === "INR" ? "INR" : "USD") === cur); if (!cr.length) return;
      sum.push([cur]);
      aggregate(cr, (r) => r.card || "\u2014").forEach((x) => sum.push(["", x.k, x.v]));
      sum.push(["", "Total", cr.reduce((s, r) => s + (num(r.amount) || 0), 0)]);
    });
    sum.push([], ["By category"]);
    ["USD", "INR"].forEach((cur) => {
      const cr = rs.filter((r) => (r.currency === "INR" ? "INR" : "USD") === cur); if (!cr.length) return;
      sum.push([cur]);
      aggregate(cr, (r) => r.category || "Other").forEach((x) => sum.push(["", x.k, x.v]));
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), "Summary");

    const zip = new JSZip();
    zip.file("receipts-" + (opts.dateLabel || "export") + ".xlsx", XLSX.write(wb, { type: "array", bookType: "xlsx" }));
    const imgs = zip.folder("images");
    let ok = 0, fail = 0;
    for (const r of rs) {
      if (!r.imageUrl) continue;
      try {
        const resp = await fetch(r.imageUrl); if (!resp.ok) throw new Error("http");
        const blob = await resp.blob();
        const safe = (r.merchant || "receipt").replace(/[^a-z0-9]+/gi, "_").slice(0, 24);
        imgs.file((r.date || "") + "_" + safe + "_" + r.id + ".jpg", blob); ok++;
      } catch (e) { fail++; }
    }
    if (fail && !ok) zip.file("IMAGES_README.txt", "Images couldn't be bundled. Your Firebase Storage bucket needs a one-time CORS rule allowing this app's origin to download image bytes. The spreadsheet is complete; images stay available in the app and the Firebase console.");

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const fname = opts.name + (opts.dateLabel ? "-" + opts.dateLabel : "") + ".zip";
    const a = el("a", { href: url, download: fname }); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    if (opts.monthKeyToMark) await markBackupDone(opts.monthKeyToMark, "downloaded");
  } catch (e) { alert("Backup failed: " + (e.message || e)); }
  state.backupBusy = false; render();
}
async function doBackup() {
  const range = lastMonthRange(), mk = range.from.slice(0, 7);
  await buildBackup({ filterFn: (r) => { const d = r.date || ""; return d >= range.from && d <= range.to; }, name: "receipt-backup", dateLabel: mk, monthKeyToMark: mk });
}
function matchesExport(r, e) {
  const d = r.date || "";
  if (e.from && d < e.from) return false;
  if (e.to && d > e.to) return false;
  if (e.currency && (r.currency === "INR" ? "INR" : "USD") !== e.currency) return false;
  if (e.card && r.card !== e.card) return false;
  if (e.category && (r.category || "Other") !== e.category) return false;
  if (e.hcsaOnly && !r.hcsa) return false;
  if (e.tag && !(r.tags || []).includes(e.tag)) return false;
  return true;
}
async function doExport() {
  const e = state.export;
  const name = ((e.name || "export").trim().replace(/[^a-z0-9._-]+/gi, "_")) || "export";
  const label = (e.from && e.to) ? (e.from + "_" + e.to) : (e.from ? ("from_" + e.from) : (e.to ? ("until_" + e.to) : "all"));
  await buildBackup({ filterFn: (r) => matchesExport(r, e), name, dateLabel: label });
}
function renderExport() {
  const e = state.export;
  const match = RECEIPTS.filter((r) => matchesExport(r, e));
  return el("section", { class: "panel" }, [
    el("div", { class: "manage-head" }, [
      el("h2", { class: "manage-h" }, "Export / backup"),
      el("button", { class: "btn ghost", onclick: () => { state.view = "list"; render(); } }, "Done")
    ]),
    el("div", { class: "fields", style: "margin-top:8px" }, [
      field("Name (prefixes the file)", el("input", { value: e.name, placeholder: "e.g. hcsa", oninput: (ev) => { e.name = ev.target.value; } })),
      el("div", { class: "scope-btns", style: "margin:2px 0" }, [
        el("button", { class: "chip", onclick: () => { const r = monthRange(); e.from = r.from; e.to = r.to; render(); } }, "This month"),
        el("button", { class: "chip", onclick: () => { const r = lastMonthRange(); e.from = r.from; e.to = r.to; render(); } }, "Last month"),
        el("button", { class: "chip", onclick: () => { e.from = ""; e.to = ""; render(); } }, "All dates")
      ]),
      field("From", el("input", { class: "mono", type: "date", value: e.from, oninput: (ev) => { e.from = ev.target.value; render(); } })),
      field("To", el("input", { class: "mono", type: "date", value: e.to, oninput: (ev) => { e.to = ev.target.value; render(); } })),
      field("Currency", selectFrom(["", "USD", "INR"], e.currency, (v) => { e.currency = v; render(); }, "Any")),
      field("Card", selectFrom(["", ...cardNames()], e.card, (v) => { e.card = v; render(); }, "Any")),
      field("Category", selectFrom(["", ...CATEGORIES], e.category, (v) => { e.category = v; render(); }, "Any")),
      allTags().length ? field("Tag", selectFrom(["", ...allTags()], e.tag, (v) => { e.tag = v; render(); }, "Any")) : null,
      el("button", { class: "hcsa-toggle" + (e.hcsaOnly ? " on" : ""), onclick: () => { e.hcsaOnly = !e.hcsaOnly; render(); } }, [
        el("span", { class: "box" }, e.hcsaOnly ? "\u2713" : ""), "HCSA / reimbursable only"
      ]),
      el("p", { class: "gate-note" }, match.length + " receipt" + (match.length === 1 ? "" : "s") + " match"),
      el("div", { class: "cap-actions" }, [
        el("button", { class: "btn primary", ...((state.backupBusy || !match.length) ? { disabled: "disabled" } : {}), onclick: doExport }, state.backupBusy ? "Preparing\u2026" : "Download export")
      ])
    ])
  ]);
}

// ---------- boot ----------
$("#fileCam").addEventListener("change", onFileInput);
$("#fileImg").addEventListener("change", onFileInput);
$("#filePdf").addEventListener("change", onFileInput);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
render();
