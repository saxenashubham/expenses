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
let unsubReceipts = null, unsubCards = null;
function monthRange() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  return { from: y + "-" + pad(m + 1) + "-01", to: y + "-" + pad(m + 1) + "-" + pad(new Date(y, m + 1, 0).getDate()) };
}
function isThisMonth() { const mr = monthRange(); return state.flt.from === mr.from && state.flt.to === mr.to; }
const state = {
  screen: "loading",   // loading | signin | denied | ledger
  view: "list",        // list | capture | cards
  cap: null,
  flt: { from: monthRange().from, to: monthRange().to, card: "", token: "", category: "", currency: "", owner: "", hcsaOnly: false, text: "" },
  sort: { by: "date", dir: "desc" },   // by: date | amount | added
  openId: null,
  edit: null,          // { id, date, amount, category } when editing a receipt
  page: 1,
  fltSig: ""
};
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
      tokens: Object.entries((v && v.tokens) || {})
        .map(([last4, t]) => ({ last4: String(last4).replace(/\D/g, "").slice(-4), label: (t && t.label) || "" }))
        .filter((t) => t.last4)
        .sort((a, b) => a.last4.localeCompare(b.last4))
    }))
    .filter((c) => c.name && !/^[\u2022\s]*\d{2,4}$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const cardsRef = () => doc(db, "meta", "cards");

async function addCard(name) {
  name = (name || "").trim(); if (!name) return "";
  if (!CARDS.some((c) => c.name === name)) {
    try { await setDoc(cardsRef(), { cards: { [name]: { tokens: {} } } }, { merge: true }); } catch (e) { console.error(e); }
  }
  return name;
}
async function linkToken(cardName, last4, label) {
  last4 = (last4 || "").replace(/\D/g, "").slice(-4); if (!cardName || !last4) return;
  // deep-merge writes only this token's label; sibling tokens/cards untouched.
  try { await setDoc(cardsRef(), { cards: { [cardName]: { tokens: { [last4]: { label: (label || "").trim() } } } } }, { merge: true }); } catch (e) { console.error(e); }
}
async function removeToken(cardName, last4) {
  last4 = (last4 || "").replace(/\D/g, "").slice(-4); if (!cardName || !last4) return;
  try { await updateDoc(cardsRef(), new FieldPath("cards", cardName, "tokens", last4), deleteField()); } catch (e) { console.error(e); }
}
async function removeCard(name) {
  if (!name) return;
  try { await updateDoc(cardsRef(), new FieldPath("cards", name), deleteField()); } catch (e) { console.error(e); }
}
async function setCardColor(name, color) {
  if (!name) return;
  try { await setDoc(cardsRef(), { cards: { [name]: { color } } }, { merge: true }); } catch (e) { console.error(e); }
}
async function renameCard(oldName, newName) {
  oldName = (oldName || "").trim(); newName = (newName || "").trim();
  if (!oldName || !newName || oldName === newName) return;
  if (CARDS.some((c) => c.name === newName)) { alert("A card named \"" + newName + "\" already exists."); return; }
  const src = CARDS.find((c) => c.name === oldName); if (!src) return;
  const tokensMap = {}; (src.tokens || []).forEach((t) => { if (t.last4) tokensMap[t.last4] = { label: t.label || "" }; });
  try {
    // create the renamed card carrying tokens + color, then drop the old key
    await setDoc(cardsRef(), { cards: { [newName]: { tokens: tokensMap, color: src.color || "" } } }, { merge: true });
    await updateDoc(cardsRef(), new FieldPath("cards", oldName), deleteField());
    // re-point every linked receipt (one atomic field write each)
    for (const r of RECEIPTS.filter((r) => r.card === oldName)) {
      try { await updateDoc(doc(db, "receipts", r.id), { card: newName }); } catch (e) { console.error(e); }
    }
  } catch (e) { console.error(e); alert("Rename failed: " + (e.message || e)); }
}
async function saveReceiptEdit() {
  const e2 = state.edit; if (!e2) return;
  try {
    await updateDoc(doc(db, "receipts", e2.id), {
      date: e2.date || todayISO(),
      amount: e2.amount,
      category: CATEGORIES.includes(e2.category) ? e2.category : "Other"
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
  state.cap = { img: null, date: todayISO(), merchant: "", amount: "", currency: "USD", card: "", last4: "", tokenLabel: "", linkLast4: "", linkLabel: "", category: "Other", hcsa: false, note: "", reading: false, err: false, addingCard: false, loadingPdf: false, saving: false };
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
      hcsa: !!c.hcsa, note: c.note.trim(),
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
    return true;
  });
  return sortReceipts(arr);
}
function exportCsv() {
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const rows = [["date", "merchant", "amount", "currency", "category", "card", "token", "last4", "hcsa", "added_by", "note", "image_url"]];
  filtered().forEach((r) => rows.push([r.date, r.merchant, r.amount, r.currency || "USD", r.category || "Other", r.card, r.tokenLabel || "", r.last4 || "", r.hcsa ? "yes" : "", r.ownerName || r.ownerEmail || "", r.note, r.imageUrl || ""]));
  const url = URL.createObjectURL(new Blob([rows.map((x) => x.map(esc).join(",")).join("\n")], { type: "text/csv" }));
  const a = el("a", { href: url, download: "receipt-ledger.csv" }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- render ----------
function render() {
  const root = $("#app"); root.textContent = "";
  if (state.screen === "loading") return root.append(el("div", { class: "empty" }, "Opening the ledger\u2026"));
  if (state.screen === "signin") return root.append(renderSignIn());
  if (state.screen === "denied") return root.append(renderDenied());

  root.append(el("header", { class: "app" }, [
    el("div", {}, [
      el("div", { class: "eyebrow" }, "Receipt Ledger \u00b7 " + firstName(USER.displayName || USER.email)),
      el("h1", {}, "Every slip, filed by the date you'll search for it.")
    ]),
    el("button", { class: "btn primary", onclick: startCapture }, "Capture receipt")
  ]));

  if (state.view === "capture") return root.append(renderCapture());
  if (state.view === "cards") return root.append(renderManageCards());

  const cards = cardNames();
  root.append(el("section", { class: "filters" }, [
    el("div", { class: "f-row" }, [
      labelInput("From", el("input", { class: "mono", type: "date", value: state.flt.from, oninput: (e) => { state.flt.from = e.target.value; render(); } }), "from"),
      labelInput("To", el("input", { class: "mono", type: "date", value: state.flt.to, oninput: (e) => { state.flt.to = e.target.value; render(); } }), "to"),
      labelInput("Card", selectFrom(["", ...cards], state.flt.card, (v) => { state.flt.card = v; render(); }, "Any"), "card"),
      labelInput("Category", selectFrom(["", ...CATEGORIES], state.flt.category, (v) => { state.flt.category = v; render(); }, "Any"), "card"),
      allTokenLabels().length ? labelInput("Token / phone", selectFrom(["", ...allTokenLabels()], state.flt.token, (v) => { state.flt.token = v; render(); }, "Any"), "card") : null,
      el("label", { class: "f card" }, ["Range", el("div", { class: "scope-btns" }, [
        el("button", { class: "chip" + (isThisMonth() ? " on" : ""), onclick: () => { const mr = monthRange(); state.flt.from = mr.from; state.flt.to = mr.to; render(); } }, "This month"),
        el("button", { class: "chip" + ((!state.flt.from && !state.flt.to) ? " on" : ""), onclick: () => { state.flt.from = ""; state.flt.to = ""; render(); } }, "All dates")
      ])])
    ]),
    el("div", { class: "f-row" }, [
      labelInput("Search", el("input", { value: state.flt.text, placeholder: "merchant or note", oninput: (e) => { state.flt.text = e.target.value; render(); } }), "grow"),
      ownerChips(),
      curChips(),
      el("button", { class: "chip" + (state.flt.hcsaOnly ? " on" : ""), onclick: () => { state.flt.hcsaOnly = !state.flt.hcsaOnly; render(); } }, "HCSA only"),
      (state.flt.from || state.flt.to || state.flt.card || state.flt.token || state.flt.category || state.flt.currency || state.flt.owner || state.flt.hcsaOnly || state.flt.text)
        ? el("button", { class: "link", onclick: () => { const mr = monthRange(); state.flt = { from: mr.from, to: mr.to, card: "", token: "", category: "", currency: "", owner: "", hcsaOnly: false, text: "" }; render(); } }, "Reset") : null
    ])
  ]));

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
    sortSelect(),
    RECEIPTS.length ? el("button", { class: "link", onclick: exportCsv }, "Export CSV") : null
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

  root.append(el("footer", { class: "tools" }, [
    el("span", { class: "who" }, "Signed in as " + (USER.email || "")),
    el("button", { class: "link spacer", onclick: () => { state.view = "cards"; render(); } }, "Manage cards"),
    el("button", { class: "link", onclick: doSignOut }, "Sign out")
  ]));
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
    ? el("div", { class: "shot" }, [el("img", { src: c.img, alt: "receipt" }), c.reading ? el("div", { class: "reading" }, "Reading the receipt\u2026") : null])
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
      editing ? renderEditForm() : el("div", { class: "r-detail-actions" }, [
        el("button", { class: "link", onclick: () => { state.edit = { id: r.id, date: r.date || todayISO(), amount: r.amount || "", category: r.category || "Other" }; render(); } }, "Edit"),
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
      el("label", {}, ["Category", selectFrom(CATEGORIES, e2.category, (v) => { e2.category = v; })])
    ]),
    el("div", { class: "cap-actions" }, [
      el("button", { class: "btn ghost", onclick: () => { state.edit = null; render(); } }, "Cancel"),
      el("button", { class: "btn primary", onclick: saveReceiptEdit }, "Save changes")
    ])
  ]);
}

// ---------- boot ----------
$("#fileCam").addEventListener("change", onFileInput);
$("#fileImg").addEventListener("change", onFileInput);
$("#filePdf").addEventListener("change", onFileInput);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
render();
