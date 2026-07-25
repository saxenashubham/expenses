import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, collection, doc, setDoc,
  deleteDoc, onSnapshot, query, orderBy, serverTimestamp, arrayUnion
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
const money = (a) => { const n = num(a); return n == null ? "\u2014" : "$" + n.toFixed(2); };
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
const state = {
  screen: "loading",   // loading | signin | denied | ledger
  view: "list",        // list | capture
  cap: null,
  flt: { from: "", to: "", card: "", category: "", owner: "", hcsaOnly: false, text: "" },
  openId: null
};

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
    CARDS = (d.exists() && d.data().list) ? [...d.data().list].sort() : [];
    if (state.screen === "ledger" && state.view === "capture") render();
  }, (err) => { console.error(err); });
}

async function addCard(name) {
  name = (name || "").trim(); if (!name) return "";
  if (!CARDS.includes(name)) { CARDS = [...CARDS, name].sort(); }
  try { await setDoc(doc(db, "meta", "cards"), { list: arrayUnion(name) }, { merge: true }); } catch (e) { console.error(e); }
  return name;
}

// ---------- capture ----------
function startCapture() {
  state.view = "capture";
  state.cap = { img: null, date: todayISO(), merchant: "", amount: "", card: "", last4: "", category: "Other", hcsa: false, note: "", reading: false, err: false, addingCard: false, loadingPdf: false, saving: false };
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
      date: c.date || todayISO(), merchant: c.merchant.trim(), amount: c.amount,
      card: c.card.trim(), last4: (c.last4 || "").replace(/\D/g, "").slice(-4),
      category: CATEGORIES.includes(c.category) ? c.category : "Other",
      hcsa: !!c.hcsa, note: c.note.trim(),
      imagePath: path, imageUrl,
      ownerEmail: (USER.email || "").toLowerCase(), ownerName: USER.displayName || USER.email,
      createdAt: serverTimestamp()
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
function filtered() {
  const f = state.flt;
  return RECEIPTS.filter((r) => {
    if (f.from && (r.date || "") < f.from) return false;
    if (f.to && (r.date || "") > f.to) return false;
    if (f.card && r.card !== f.card) return false;
    if (f.category && (r.category || "Other") !== f.category) return false;
    if (f.owner === "mine" && (r.ownerEmail || "") !== (USER.email || "").toLowerCase()) return false;
    if (f.owner === "partner" && (r.ownerEmail || "") !== otherEmail()) return false;
    if (f.hcsaOnly && !r.hcsa) return false;
    if (f.text) { const t = f.text.toLowerCase(); if (!((r.merchant || "").toLowerCase().includes(t) || (r.note || "").toLowerCase().includes(t))) return false; }
    return true;
  });
}
function exportCsv() {
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const rows = [["date", "merchant", "amount", "category", "card", "last4", "hcsa", "added_by", "note", "image_url"]];
  filtered().forEach((r) => rows.push([r.date, r.merchant, r.amount, r.category || "Other", r.card, r.last4 || "", r.hcsa ? "yes" : "", r.ownerName || r.ownerEmail || "", r.note, r.imageUrl || ""]));
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

  const cards = CARDS;
  root.append(el("section", { class: "filters" }, [
    el("div", { class: "f-row" }, [
      labelInput("From", el("input", { class: "mono", type: "date", value: state.flt.from, oninput: (e) => { state.flt.from = e.target.value; render(); } }), "from"),
      labelInput("To", el("input", { class: "mono", type: "date", value: state.flt.to, oninput: (e) => { state.flt.to = e.target.value; render(); } }), "to"),
      labelInput("Card", selectFrom(["", ...cards], state.flt.card, (v) => { state.flt.card = v; render(); }, "Any"), "card"),
      labelInput("Category", selectFrom(["", ...CATEGORIES], state.flt.category, (v) => { state.flt.category = v; render(); }, "Any"), "card")
    ]),
    el("div", { class: "f-row" }, [
      labelInput("Search", el("input", { value: state.flt.text, placeholder: "merchant or note", oninput: (e) => { state.flt.text = e.target.value; render(); } }), "grow"),
      ownerChips(),
      el("button", { class: "chip" + (state.flt.hcsaOnly ? " on" : ""), onclick: () => { state.flt.hcsaOnly = !state.flt.hcsaOnly; render(); } }, "HCSA only"),
      (state.flt.from || state.flt.to || state.flt.card || state.flt.category || state.flt.owner || state.flt.hcsaOnly || state.flt.text)
        ? el("button", { class: "link", onclick: () => { state.flt = { from: "", to: "", card: "", category: "", owner: "", hcsaOnly: false, text: "" }; render(); } }, "Clear") : null
    ])
  ]));

  const list = filtered();
  const total = list.reduce((s, r) => s + (num(r.amount) || 0), 0);
  root.append(el("div", { class: "summary" }, [
    el("span", {}, list.length + " receipt" + (list.length === 1 ? "" : "s")),
    el("span", { class: "mono" }, money(total)),
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
    list.forEach((r) => ul.append(renderReceipt(r)));
    root.append(ul);
  }

  root.append(el("footer", { class: "tools" }, [
    el("span", { class: "who" }, "Signed in as " + (USER.email || "")),
    el("button", { class: "link spacer", onclick: doSignOut }, "Sign out")
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
function ownerChips() {
  const set = (v) => { state.flt.owner = state.flt.owner === v ? "" : v; render(); };
  return el("span", { class: "owner-chips" }, [
    el("button", { class: "chip" + (state.flt.owner === "mine" ? " on" : ""), onclick: () => set("mine") }, "Mine"),
    el("button", { class: "chip" + (state.flt.owner === "partner" ? " on" : ""), onclick: () => set("partner") }, firstName(otherEmail()))
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
  const s = el("select", { onchange: (e) => { const v = e.target.value; if (v === "__add__") c.addingCard = true; else c.card = v; render(); } }, [
    el("option", { value: "" }, "Select a card"),
    ...CARDS.map((x) => el("option", { value: x }, x)),
    el("option", { value: "__add__" }, "\u2795 Add a card\u2026")
  ]);
  s.value = CARDS.includes(c.card) ? c.card : "";
  return s;
}

function renderCapture() {
  const c = state.cap;
  const shot = c.img
    ? el("div", { class: "shot" }, [el("img", { src: c.img, alt: "receipt" }), c.reading ? el("div", { class: "reading" }, "Reading the receipt\u2026") : null])
    : el("div", { class: "drop" }, c.loadingPdf ? [el("div", { class: "reading" }, "Rendering PDF\u2026")] : [
        el("button", { class: "btn primary", onclick: () => $("#fileCam").click() }, "\uD83D\uDCF7 Take photo"),
        el("button", { class: "btn ghost", onclick: () => $("#fileAny").click() }, "Choose file / PDF"),
        el("div", { class: "drop-note" }, "JPEG, PNG, or PDF (first page)")
      ]);

  return el("section", { class: "panel" }, [
    el("div", { class: "cap-grid" }, [
      shot,
      el("div", { class: "fields" }, [
        c.err ? el("div", { class: "notice" }, "Couldn't read that one automatically. Type the details in \u2014 the file is still saved.") : null,
        field("Date", el("input", { class: "mono", type: "date", value: c.date, oninput: (e) => c.date = e.target.value })),
        field("Merchant", el("input", { value: c.merchant, placeholder: "e.g. Corner Pharmacy", oninput: (e) => c.merchant = e.target.value })),
        field("Amount", el("input", { class: "mono", value: c.amount, placeholder: "0.00", inputmode: "decimal", oninput: (e) => c.amount = e.target.value })),
        field("Card used", renderCardPicker(c)),
        c.last4 ? el("button", { class: "detect-chip", onclick: async () => { c.card = await addCard("\u2022\u2022" + c.last4); render(); } }, "Receipt shows \u2022\u2022" + c.last4 + " \u2014 add as card") : null,
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

function renderReceipt(r) {
  const li = el("li", { class: "receipt" + (r.hcsa ? " is-hcsa" : "") });
  li.append(el("button", { class: "r-main", onclick: () => { state.openId = state.openId === r.id ? null : r.id; render(); } }, [
    el("span", { class: "r-date mono" }, r.date || "\u2014"),
    el("span", { class: "r-mid" }, [
      el("span", { class: "r-merch" }, r.merchant || "Unnamed merchant"),
      el("span", { class: "r-meta" }, [
        r.card ? el("span", { class: "r-card" }, r.card) : null,
        (r.category && r.category !== "Other") ? el("span", { class: "r-cat" }, r.category) : null,
        r.hcsa ? el("span", { class: "tag-hcsa" }, "HCSA") : null,
        el("span", { class: "r-owner" }, firstName(r.ownerName || r.ownerEmail))
      ])
    ]),
    el("span", { class: "r-amt mono" }, money(r.amount))
  ]));
  if (state.openId === r.id) {
    li.append(el("div", { class: "r-detail" }, [
      r.imageUrl ? el("img", { src: r.imageUrl, alt: "receipt" }) : el("div", { class: "reading" }, "No image."),
      r.note ? el("p", { class: "r-note" }, r.note) : null,
      el("div", { class: "r-detail-actions" }, [
        r.imageUrl ? el("a", { class: "link", href: r.imageUrl, target: "_blank", rel: "noopener", download: "" }, "Download image") : null,
        el("button", { class: "link danger", onclick: () => removeReceipt(r) }, "Delete")
      ])
    ]));
  }
  return li;
}

// ---------- boot ----------
$("#fileCam").addEventListener("change", onFileInput);
$("#fileAny").addEventListener("change", onFileInput);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
render();
