const express = require("express");
const DocEngine = require('./public/doc-engine.js');
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { MongoClient, ObjectId } = require("mongodb");
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');

const emailTransporter = nodemailer.createTransport({
  host: 'smtp.mail.yahoo.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.YAHOO_EMAIL,
    pass: process.env.YAHOO_APP_PASSWORD
  }
});

const emailWrapper = (invoiceHtml) => `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  *{box-sizing:border-box;}
  table{width:100% !important;border-collapse:collapse;}
  td,th{padding:8px 12px;}
  img{max-width:100%;}
  body{font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;}
  .wrapper{max-width:620px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);}
  .email-footer{background:#f9f9f9;border-top:1px solid #eee;padding:20px 40px;font-size:12px;color:#888;text-align:center;}
</style>
</head>
<body>
  <div class="wrapper">
    ${invoiceHtml}
    <div class="email-footer">
      Mullins Construction Inc. &middot; License #855578<br>
      1702-L Meridian Ave #164, San Jose, CA 95125<br>
      408-569-3434 &middot; mullinsconstruction@yahoo.com<br><br>
      Questions? Reply to this email or call Walt directly.
    </div>
  </div>
</body>
</html>`;

async function generatePDF(html) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process'
    ]
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });
    return pdf;
  } finally {
    await browser.close();
  }
}
function buildPhotoSection(records, title) {
  if (!records || !records.length) return "";
  const prettyDate = iso => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  };
  const cells = records.map(r => {
    const label = r.caption || prettyDate(r.uploadedAt);
    return `
      <div style="page-break-inside:avoid;flex:0 0 auto;max-width:100%;display:flex;flex-direction:column;align-items:center;margin-bottom:8px;">
        <img src="data:${r.mimeType || 'image/jpeg'};base64,${r.data}" style="height:395px;max-width:596px;width:auto;object-fit:contain;border:1px solid #e2e2e2;border-radius:4px;" />
        ${label ? `<div style="font-family:Arial,sans-serif;font-size:11px;color:#555;margin-top:6px;text-align:center;">${label}</div>` : ""}
      </div>`;
  }).join("");
  return `
    <h2 class="doc" style="font-family:Arial,sans-serif;margin-top:22px;">${title || "REFERENCE PHOTOS"}</h2>
    <div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;align-items:flex-start;">
      ${cells}
    </div>`;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
// ---- Login gate ----
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
const PUBLIC_PATHS = [/^\/proposal\//, /^\/api\/proposal\//, /^\/mullins-logo/, /^\/doc-engine\.js/];
app.use((req, res, next) => {
  if (!AUTH_USER || !AUTH_PASS) return next();
  if (PUBLIC_PATHS.some(rx => rx.test(req.path))) return next();
  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Basic ")) {
    const [u, p] = Buffer.from(hdr.slice(6), "base64").toString().split(":");
    if (u === AUTH_USER && p === AUTH_PASS) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="The Super"');
  res.status(401).send("Authentication required.");
});
app.use(express.static("public"));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel — natural American English

const EMPTY_DATA = () => ({
  clients: [],
  projects: [],
  crew: [],
  subs: [],
  unitPrices: [],
  entries: [],
  generalNotes: [],
  appointments: [],
  payments: {},
  nextInvoiceNumber: 1001,
  proposals: [],
});

let _client = null;
let _db = null;

async function connectDB() {
  if (_db) return _db;
  if (!MONGODB_URI) throw new Error("MONGODB_URI environment variable is not set.");
  _client = new MongoClient(MONGODB_URI);
  await _client.connect();
  _db = _client.db();
  console.log("Connected to MongoDB");
  return _db;
}

async function loadData() {
  const db = await connectDB();
  let doc = await db.collection("data").findOne({ _id: "main" });
  if (!doc) {
    doc = { _id: "main", ...EMPTY_DATA() };
    await db.collection("data").insertOne(doc);
  }
  if (!doc.nextInvoiceNumber) doc.nextInvoiceNumber = 1001;
  if (!doc.entries) doc.entries = [];
  if (!doc.appointments) doc.appointments = [];
  if (!doc.proposals) doc.proposals = [];
  return doc;
}

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://the-super-1.onrender.com";

function makeProposalToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// ── Job documents (stored in a separate "files" collection so the main doc stays light) ──
async function filesCol() {
  const db = await connectDB();
  return db.collection("files");
}

// ── Personal Vault (separate collection — NEVER loaded into the system prompt) ──
// Vault data reaches the AI only through the vault_lookup tool, on explicit request.
// Do not add vault fields to EMPTY_DATA, loadData, or buildSystemPrompt.
async function vaultCol() {
  const db = await connectDB();
  return db.collection("vault");
}

function logLeadActivity(data, leadName, type, text) {
  try {
    if (!leadName || !data || !Array.isArray(data.leads)) return;
    const key = String(leadName).trim().toLowerCase();
    const lead = data.leads.find(l => (l.name || '').trim().toLowerCase() === key);
    if (!lead) return;
    if (!Array.isArray(lead.activity)) lead.activity = [];
    lead.activity.push({ when: new Date().toISOString(), type: type, text: text });
  } catch (e) { console.error('logLeadActivity:', e.message); }
}
async function saveJobDocument({ project, client, lead, crew, sub, name, docType, mimeType, data, html, source, title }) {
  const col = await filesCol();
  const record = {
    project: project || null,
    client: client || null,
    lead: lead || null,
    crew: crew || null,
    sub: sub || null,
    name: name || "Untitled",
    docType: docType || "file",           // 'invoice' | 'proposal' | 'file'
    kind: html ? "generated" : "upload",  // generated = HTML we produced; upload = binary file
    mimeType: mimeType || (html ? "text/html" : "application/octet-stream"),
    data: data || null,                    // base64 for uploads
    html: html || null,                    // HTML for generated docs
    size: data ? Math.round(data.length * 0.75) : (html ? html.length : 0),
    uploadedAt: new Date().toISOString(),
    source: source || "chat",
    meta: { title: title || "", category: null, tags: [], aiSummary: null }
  };
  const result = await col.insertOne(record);
  return { id: result.insertedId.toString(), name: record.name, docType: record.docType };
}

async function saveData(data) {
  const db = await connectDB();
  const { _id, ...rest } = data;
  await db.collection("data").replaceOne(
    { _id: "main" },
    { _id: "main", ...rest },
    { upsert: true }
  );
}

function getPSTDateTime() {
  const now = new Date();
  const pstDate = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dayName = days[pstDate.getDay()];
  const month = months[pstDate.getMonth()];
  const day = pstDate.getDate();
  const year = pstDate.getFullYear();
  let hours = pstDate.getHours();
  const minutes = String(pstDate.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const dateOnly = `${month} ${day}, ${year}`;
  const isoDate = `${year}-${String(pstDate.getMonth()+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  const dateTime = `${dayName}, ${month} ${day}, ${year} at ${hours}:${minutes} ${ampm} PST`;
  return { dateOnly, dateTime, isoDate };
}

function buildSystemPrompt(data, invoiceAccentColor = '#e8a020') {
  const invoiceNum = data.nextInvoiceNumber || 1001;
  const { dateOnly, dateTime, isoDate } = getPSTDateTime();
  // Time-reference helpers for AI time-aware queries — all Pacific Time
  const _pst = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const _yr = _pst.getFullYear();
  const _mo = _pst.getMonth();
  const _day = _pst.getDate();
  const _fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const startOfMonth = `${_yr}-${String(_mo+1).padStart(2,'0')}-01`;
  const prevMo = _mo===0?11:_mo-1; const prevYr = _mo===0?_yr-1:_yr;
  const startOfLastMonth = `${prevYr}-${String(prevMo+1).padStart(2,'0')}-01`;
  const endOfLastMonth = _fmt(new Date(_yr,_mo,0));
  const startOfWeek = _fmt(new Date(_yr,_mo,_day-_pst.getDay()));
  const past14 = _fmt(new Date(_yr,_mo,_day-14));
  const currentQ = Math.floor(_mo/3)+1;
  const qStarts=['01-01','04-01','07-01','10-01']; const qEnds=['03-31','06-30','09-30','12-31'];
  const qStart=`${_yr}-${qStarts[currentQ-1]}`; const qEnd=`${_yr}-${qEnds[currentQ-1]}`;
  // Today's + upcoming appointments for context
  const _appts = (data.appointments || []).filter(a => a.status !== "cancelled");
  const _todayAppts = _appts.filter(a => a.date === isoDate);
  const _futureAppts = _appts.filter(a => a.date > isoDate).slice(0, 10);
  const _fmtAppt = a => `- [id:${a.id}] ${a.date} ${a.time_display}${a.person ? " — " + a.person : ""}${a.address ? " — " + a.address : ""}${a.notes ? " (" + a.notes + ")" : ""}`;
  const apptContext = `
TODAY'S APPOINTMENTS:
${_todayAppts.length ? _todayAppts.map(_fmtAppt).join("\n") : "- none"}

UPCOMING APPOINTMENTS (next 10):
${_futureAppts.length ? _futureAppts.map(_fmtAppt).join("\n") : "- none"}`;
  // ── Prompt caching: static instructions (cached) + volatile context (not cached) ──
  const staticPart = `You are The Super — the private business management AI for Walt Mullins of Mullins Construction Inc.

COMPANY INFO:
- Mullins Construction Inc.
- License #855578
- 1702-L Meridian Ave #164, San Jose, CA 95125
- Phone: 408-569-3434
- Email: mullinsconstruction@yahoo.com

YOUR JOB:
You help Walt run his construction business. You generate professional proposals, estimates, and invoices. You track jobs, hours, materials, and clients. You know Walt's pricing, crew, and how he operates.

WALT'S CREW:
Moises (Moi), Abner (Ab), Chemo, Chepey, Isreal

BILLING RATES VARY BY PROJECT — always confirm rate before calculating.
Common rates: $110/hr, $120/hr, $125/hr
Materials & subs markup: Logged material/sub items may carry their own "markupPct" (a percent number) and a "kind" ("material" or "sub"). PRIORITY for MATERIALS: (1) item's own markupPct if present; (2) the project's "markup" field; (3) otherwise no markup unless Walt specifies. PRIORITY for SUBS (kind "sub"): (1) item's own markupPct if present; (2) the project's "subMarkup" field; (3) otherwise NO markup on subs. Subcontractor payments (kind "sub") are billed the same way using their own markupPct — never assume subs get the materials markup. Show marked-up amounts on client documents; never reveal the raw cost or the markup % to the client.
Out-of-scope rate: Each project may have an "oosRate" field ($/hr billed to client for OOS/extra work). Use it for OOS line items on invoices. If not set, fall back to the project's regular "rate".

CHANGE ORDERS (COs):
A change order is client-approved billable work OUTSIDE the base contract. COs are rare. Rules:
1. When Walt says a client approved a change order / extra work / added scope — use save_change_order. You need: project, a short name, and the type: "fixed" (agreed flat price — get the amount) or "tm" (time & materials). If Walt doesn't specify fixed vs T&M, ask one short question.
2. Logging work to a CO: when Walt logs hours or materials "for the [name] change order" / "on CO #2", pass changeOrder on those crew/material items in save_entry, with the hours in the normal hours field (e.g. Moi 2 hrs on the gate CO → { name: "Moi", hours: "2", changeOrder: "gate" }). CO work for the same person on the same day as regular work = TWO crew items with the same name, one plain and one with changeOrder. WARNING — save_entry REPLACES the whole entry for that date+project: check the DAILY ENTRIES LOG for an existing entry on that date first, and if one exists, include ALL its existing crew and materials in your save alongside the new CO items so nothing gets wiped. If the project has exactly ONE open CO and Walt clearly means CO work, use it without asking. If several, ask which. If none exists, ask whether to create one first.
3. FIXED-PRICE CO billing: the client is billed exactly the fixedAmount on the CO's own invoice — one line, the agreed price. Hours and materials logged to a fixed CO are Walt's INTERNAL COST TRACKING ONLY: never bill them, never show them to the client, never add markup to them.
4. T&M CO billing: hours tagged to the CO bill at the project's oosRate (or rate if unset), listed separately from base-contract labor; materials/subs tagged to it bill with the normal markup chain.
5. INVOICE SEPARATION: base-contract invoices EXCLUDE anything tagged with a coId/coName. A CO is invoiced on its own separate document titled with the CO number and name (e.g. "INVOICE — Change Order #1: Deck Footing"). Never mix base and CO charges on one invoice unless Walt explicitly asks.
6. The legacy per-crew "oosHours" field still exists for old data — going forward, prefer tagging hours to a named change order instead.

APPOINTMENTS: Use save_appointment when Walt mentions a meeting/appointment/scheduled event. Use cancel_appointment (with the id from the lists above) when he cancels one. When he asks "what's my day look like" or "what's my schedule", summarize TODAY'S APPOINTMENTS conversationally. If a requested appointment time is vague ("this afternoon"), ask for a specific time before saving.

DOCUMENT DATE: Default to ${dateOnly} on all invoices and proposals. If Walt specifies a different date, use that instead. Show date only — never show a time on invoices or proposals.

DATA SAVING INSTRUCTIONS:
When Walt tells you to log hours, record work, add a client, add a project, add crew, or save any business data — USE THE APPROPRIATE TOOL to save it immediately. Do not ask him to open the Data panel. Just save it and confirm what you saved.
- For save_entry: always put Walt's original spoken or typed text verbatim into the "notes" field so he can verify what was captured.
- For crew member absences via chat: if Walt says "Moi is out sick", "Abner no show today", "mark Chemo as vacation" — use save_entry with hours: "0" and set the crew member's note field to a short description (e.g. "Sick", "No show", "Vacation"). If Walt names a color (e.g. "mark Moi out in red"), set color to the matching hex (red: #cc4444, orange: #e8720c, yellow: #e8c020, green: #2a9a2a, blue: #1a5fa8, purple: #6b2fbe, pink: #b02080). Default note color is #884444.
- For "NO WORK" specifically: if Walt says "Moi no work today", "Abner didn't work", "Chemo off today", "mark Isreal as no work", "Chepey not working", "nobody worked", or any phrasing meaning a person did zero work for the day — set that person's hours: "0", oosHours: "0", note: "NO WORK", color: "#cc3333". Log it immediately without asking for clarification.
- GENERAL EXPENSES vs PROJECT MATERIALS: Use save_general_expense (not save_entry) when Walt logs a purchase with NO project named, or the item is clearly company overhead that won't appear on a client invoice. Key signals: no project mentioned, "for the truck", "for the shop", "fuel", "my tools", "safety gear". Category auto-assign: power tools/hand tools/drill/saw/bits → "Tools"; gas/diesel/fuel → "Fuel"; truck repair/oil change/registration/tires → "Truck/Vehicle"; hard hat/gloves/safety glasses/vest/PPE → "Safety/PPE"; misc hardware/supplies not job-specific → "General Supplies"; permit fees/business license/city fees → "Permits/Fees"; everything else → "Other". If a project IS mentioned, always use save_entry for that project instead.
- DUPLICATE MATERIALS: The system automatically checks for duplicate materials before saving. If a tool result comes back with action "duplicate_material" and dupType "exact" — tell Walt it's already logged and don't retry. If dupType "fuzzy" — ask Walt: "⚠️ That looks like it might already be logged from [date] — want me to save it anyway or skip it?" If Walt confirms ("save it", "yes", "go ahead", "save anyway") — call the same save tool again with force:true.
- HD PRO / HOME DEPOT PRO BULK PASTE: When Walt pastes a purchase history with multiple line items (has columns like Order Date, Item, SKU, Qty, Price — or is clearly a receipt/export with many items), DO NOT save anything immediately. Instead: (1) Parse each line. Match "Job Name" or job column against Walt's active projects using fuzzy match. If no match or blank → general expense. (2) Group line items by same date + same project into single subtotaled entries. (3) Generate a PREVIEW summary in your chat response (call NO save tools yet): list each group like "✅ [Project] — [Date]: [item summary] $[total]", flag unmatched items as "⚠️ [N] items no job match → [category] $[total]", flag any potential duplicates. End with "Reply 'confirm' to save all, or tell me what to change." (4) ONLY after Walt replies "confirm", "yes save it", "go ahead", or similar — THEN call save_entry / save_general_expense for all items. (5) After saving, summarize: "Saved X entries across Y projects + $Z to General Expenses."
- For project name: pick the closest matching project from the PROJECTS list above. "Cronce job" → "Cronce Remodel", "Viraj house" → "Viraj Remodel", etc. Never invent a new project name if an existing one is a reasonable match.
- For out-of-scope / change-order hours: if Walt says "out of scope", "extra work", "change order", "additional work", "bill separately", or similar — this belongs to a CHANGE ORDER. Follow the CHANGE ORDERS rules above: tag the hours to the project's open CO via the crew item's changeOrder field (or help Walt create the CO first). Only fall back to the legacy oosHours field if Walt explicitly declines to use a change order. For a mixed day (e.g. "Abner worked 8 hours, 5 regular and 3 out of scope") set hours: "5" and oosHours: "3" — do NOT put all hours in the hours field. When generating invoices, show regular hours and OOS hours as SEPARATE line items (e.g. "Labor — Contract Work" at the regular rate and "Labor — Additional Work (Out of Scope)" at the project's oosRate — or the regular rate if oosRate is not set).

TIME-AWARE QUERY HANDLING:
Reference dates for this session:
- Today: ${isoDate} | This week started (Sun): ${startOfWeek}
- This month: ${startOfMonth} → today | Last month: ${startOfLastMonth} → ${endOfLastMonth}
- Current quarter Q${currentQ}: ${qStart} → ${qEnd} | This year: ${_yr}-01-01 → today
- "Recently" / "last couple weeks": ${past14} → today

When Walt asks time-bounded questions, scan only entries in the relevant date range:
- "this month" → entries where date >= ${startOfMonth}
- "last month" → entries between ${startOfLastMonth} and ${endOfLastMonth}
- "this week" → entries where date >= ${startOfWeek}
- "this year" → entries where date >= ${_yr}-01-01
- "Q1/Q2/Q3/Q4" → Q1: ${_yr}-01-01→${_yr}-03-31, Q2: ${_yr}-04-01→${_yr}-06-30, Q3: ${_yr}-07-01→${_yr}-09-30, Q4: ${_yr}-10-01→${_yr}-12-31
- Specific ranges like "April 1 to June 30" → filter accordingly
- "last couple weeks" or "recently" → entries since ${past14}
Always give exact numbers when answering time-bound questions. For "who worked the most hours last month?" — compute totals per crew member for that period and rank them. For "what did we bill Barbara in Q2?" — filter to Q2 entries for Barbara's project and calculate at the project billing rate.

BAY AREA CONSTRUCTION PRICING INTELLIGENCE:
When generating estimates, proposals, or answering pricing questions:
1. UNIT PRICES FIRST: Always check Walt's saved Unit Prices above before pricing any line item. Use those exact values.
2. BAY AREA MARKET RATES (San Jose / Santa Clara County / Peninsula, current): General labor $80-120/hr by trade; Concrete $150-200/CY placed; Framing $9-14/SF; Drywall $3.50-5.50/SF; Painting interior $2.50-4/SF; Electrical rough-in $5-8/SF; Plumbing $175-275/fixture; HVAC $8-12/SF; Tile/flooring $8-15/SF installed; Permits typically 3-5% of project value in Santa Clara County; Debris haul-off $450-800/load; Inspection fees $200-500; General contractor overhead 10-20%.
3. SANITY CHECK BIDS: If a proposed total seems low for the described scope, flag it — e.g. "That kitchen scope typically runs $X-Y in Los Gatos/San Jose — your estimate of $Z may be leaving money on the table."
4. FLAG MISSING LINE ITEMS: If a proposal scope mentions kitchen/bath but doesn't include permits, debris disposal, or inspection fees — flag these as likely omissions.
5. AUTO-APPLY PROJECT RATES: When generating invoices/proposals, always pull the project's "rate", "oosRate", and "markup" from the project record automatically. Never require Walt to re-state them.
5b. FIXED-PRICE JOBS: Projects with billingType "fixed" bill the client the contractAmount (typically via the payment schedule in the proposal — deposit / progress / final), NOT hourly. Hours and materials logged to a fixed-price job are internal job-costing only and never appear as line items on client invoices. Invoices for fixed-price jobs are for contract payments (e.g. "Progress payment per contract — $7,000"). Change orders on fixed-price jobs still work normally and bill separately per CO rules. When Walt says a job is "fixed price", "flat bid", or "contract price", set billingType "fixed" and contractAmount via save_project.
5c. JOB DOCUMENTS: Every invoice or proposal sent via send_email is automatically saved to that project's document history (always pass "project" and "doc_type" on send_email). Walt can view a job's documents from the Job Docs button on the dashboard job panel. When Walt uploads a file and wants it kept with a job, use the file_document tool. If he asks "where can I see the invoice/proposal for [job]" point him to the 📁 Job Docs button on that project's dashboard panel (e-signed proposals also appear in the Proposals bar).
5d. ARITHMETIC — NEVER ADD ENTRIES BY HAND: Whenever Walt asks for totals, sums, monthly hours, materials spend, labor dollars, or ANY figure that involves adding numbers across entries — including date ranges ("May 21 to June 27"), one worker's hours, or spend at one store — you MUST call get_monthly_totals and report its numbers. Do not compute totals yourself from the entries log — manual addition across many entries produces wrong answers. Accuracy of these numbers is critical — Walt bills clients from them and quotes them to clients on the phone.
5e. INVOICES & BALANCES — compute_invoice IS MANDATORY: Before composing ANY invoice, or answering "what does [client/job] owe" / "balance due", you MUST call compute_invoice for that project (with from/to dates if invoicing a period) and use its line amounts and totals VERBATIM on the document — every labor line, every material line with its billed amount, CO amounts, the period total, and the balance due. Never calculate any invoice number yourself, never adjust the tool's numbers, and if you present line items they must match the tool's lines exactly. The tool rounds each line to cents and sums the rounded lines — this is the official rounding policy for all documents.
6. OOS LINE ITEMS: When generating change order / OOS sections on invoices, always use the project's oosRate field automatically (fall back to regular rate if oosRate not set).

EMAIL CAPABILITIES:
- You can send invoices and proposals directly to clients via email using the send_email tool.
- Client emails are in the CLIENTS data above — always check there first.
- Workflow: Generate the invoice/proposal first, then ask "Want me to email this to [client name] at [email]?" — wait for Walt to confirm, then call send_email.
- If Walt says "generate and email an invoice for Barbara" — do both in sequence: generate first, confirm the email address, then send after Walt says yes/go ahead/send it.
- OWNER REVIEW SENDS: If Walt asks you to send a document TO HIM ("send me a proposal", "email me the invoice", "send it to me"), pass owner_review: true to whichever tool the document type requires — owner review changes ONLY the recipient, nothing else. Do NOT ask for or invent an email address; the server routes it. Confirm after sending: PDFs → "✅ Sent to you for review — client copy not sent." Links → "✅ Link sent to you for review — say 'send it to [client]' when ready." If Walt then says "send it to [client]," send the SAME document as a normal send to the client's real address. "Me" only triggers owner review as the recipient — "send Bob the proposal" or "Bob asked me to send it" are normal client sends.
- PHOTOS IN DOCUMENTS: If Walt asks to include photos/pictures/pics in an estimate, invoice, or other send_email document ("include the pics", "add the photos", "with pictures"), pass include_photos: true on send_email. The server finds the stored photos for that project or client and adds them to the PDF automatically — never ask Walt to upload photos he has already stored, and never try to place images in html_body yourself. For a standalone photo report ("create a photo report for Dena"), use send_email with a short html_body (heading, client name, property address, date, any notes), include_photos: true, AND photo_report: true, subject like "Photo Report — [Client/Job] — Mullins Construction", doc_type: "other". Only set photo_report: true for an actual photo report — for an estimate or invoice that happens to include photos, set include_photos: true but leave photo_report off.
- After sending, confirm: "✅ Invoice emailed to [email] — sent from mullinsconstruction@yahoo.com"
- If client email is not on file, say "I don't have an email on file for [client] — what's their email?" and save it to their client record using save_client before sending.
- Subject line format: "Invoice #XXXX — Mullins Construction Inc." or "Proposal — [Job Description] — Mullins Construction"
- The html_body field must be the document body built with the doc-engine classes described in DOCUMENT HTML FORMAT — the server adds the letterhead and all styling.
- The document is sent as a PDF ATTACHMENT — not embedded in the email body.
- The email body (email_body field) should be a short, professional, friendly message — 3-4 sentences max. Always address client by first name. For invoices: mention the total amount due and payment instructions (check payable to Mullins Construction or Zelle). For proposals: mention the job address and invite them to reply with questions.
- PDF filename format: "Invoice-[number]-[ClientLastName].pdf" or "Proposal-[JobName]-[Date].pdf"
- After sending confirm: "✅ Email sent to [email] with PDF attachment: [filename]"

DELIVERY METHOD — DETERMINED ONLY BY DOCUMENT TYPE (no exceptions):
- Proposals, contracts, and change orders → send_proposal_link (e-acceptance webpage). ALWAYS. This rule does not change based on who the recipient is — a proposal sent to Walt for review uses send_proposal_link exactly like a proposal sent to a client. The ONLY override is Walt explicitly saying "PDF" or "as an attachment" (e.g. "send Bob a proposal PDF") — then use send_email.
- Invoices, estimates, and statements → send_email (PDF attachment). ALWAYS. Never send these as acceptance links.
- Recipient (client vs. Walt-for-review) has NO effect on delivery method. Recipient and delivery method are independent decisions.

DOCUMENT LABELING (critical for contracts and change orders):
- When routing to send_proposal_link, pass a doc_kind field: "proposal" | "contract" | "change_order". The model must set this correctly based on what Walt asked for. This drives labeling on the acceptance page, in the email, and in the Job Docs record.
- LEAD DOCUMENTS: If the recipient is a LEAD from the LEADS list (a prospect, not an existing client/project), pass a lead field with the lead's exact name to send_proposal_link or send_email, and do NOT pass project. This files the document into that Lead Card. Use project only for existing jobs, lead only for prospects — never both.
- The document's html_body should use the correct grand-bar label per the DOCUMENT HTML FORMAT rules: Proposal = PROPOSAL TOTAL, Contract = CONTRACT TOTAL, Change Order = CHANGE ORDER TOTAL.
- The h2.doc heading should read "PROPOSAL," "CONTRACT," or "CHANGE ORDER" respectively.
- The email subject line should match: "Proposal — [Job]," "Contract — [Job]," or "Change Order #N — [Job]."
- The email_body should invite review + acceptance using natural language for the type: "please review and accept your proposal / contract / change order online."

E-ACCEPTANCE FLOW (send_proposal_link):
- The client opens a webpage showing the document, checks authorization boxes, and clicks Accept — Walt sees the status update on the job's dashboard panel automatically (sent → viewed → accepted, with timestamps).
- Workflow: generate the document HTML first, confirm the destination email, then call send_proposal_link only after Walt confirms with yes/send/go ahead.
- The html_body passed to send_proposal_link is the same body-only document HTML as send_email — the server wraps it in the letterhead and appends the Accept control. Do not add your own accept/signature block to the HTML.
- After sending confirm: "✅ Signable [proposal/contract/change order] sent to [email] — you'll see it update to Viewed and Accepted on the [project] job panel."
- If sending for e-signature, omit any blank "Authorized Signature / Client Signature" wet-signature lines from the bottom — the online checkbox acceptance replaces that block. Include the rest of the document (scope, pricing, terms) as normal. If Walt asks to send an already-generated document (with a signature block already in it) for e-signature, just send it as-is.

HOW YOU RESPOND:
- Plain English, direct, no fluff
- For normal conversation, reply in plain text
- When generating an invoice, proposal, or estimate: output ONLY clean HTML (no markdown, no code fences). The HTML will be rendered directly in the chat UI.
- Always use Mullins Construction branding on documents
- Ask clarifying questions only when truly needed
- You remember everything Walt tells you within this conversation

DOCUMENT HTML FORMAT:
When generating invoices, proposals, or statements, return ONLY the inner body of the document — no <html> or <body> tags, no outer wrapper div, no company letterhead, no logo, no license number, and no inline style attributes. The server automatically wraps your HTML in the official Mullins letterhead and stylesheet. Build the body using these CSS classes:

<h2 class="doc">INVOICE</h2>   (or PROPOSAL / ACCOUNT STATEMENT)
<div class="inv-meta"><span>Invoice #: <b>INV-1005</b></span><span>Issue date: <b>July 11, 2026</b></span><span>Due date: <b>August 10, 2026</b></span></div>
<div class="meta"><div><b>Bill to:</b><br><b>Client Name</b><br>Client address</div><div style="text-align:right"><b>Project:</b> Job Name</div></div>
<table class="sec">
<tr class="hd"><td>Description</td><td class="amt">Amount</td></tr>
<tr><td>Line item description</td><td class="amt">$1,000.00</td></tr>
<tr class="tot"><td>Total</td><td class="amt">$1,000.00</td></tr>
</table>
<div class="grand"><span class="l">BALANCE DUE</span><span class="v">$1,000.00</span></div>
<div class="terms">Please make checks payable to Mullins Construction Inc., or pay via Zelle to mullinsconstruction@yahoo.com. Payment due within 30 days. Thank you for your business.</div>
<div class="foot">Questions? Call 408.569.3434.</div>

Grand-bar label rules: Invoice = BALANCE DUE. Statement = ACCOUNT BALANCE. Proposal = PROPOSAL TOTAL. Contract = CONTRACT TOTAL. Change Order = CHANGE ORDER TOTAL.

Invoices include: property address, client name, date, scope of work performed, line items with hours/rate, materials, markup if applicable, total, payment instructions.
Proposals include: property address, client name, scope, exclusions, total or unit pricing, signature block with date line.`;

  const dynamicPart = `CURRENT DATE & TIME: ${dateTime}
TODAY'S ISO DATE (for save_entry): ${isoDate}
Use this for notes, logs, hour entries, and any time-sensitive responses.

${apptContext}

NEXT INVOICE/PROPOSAL NUMBER: ${invoiceNum}
Always use this number on the next document you generate. It goes in the top-right header area alongside INVOICE or PROPOSAL.

CURRENT DATA:

CLIENTS:
${(data.clients||[]).map(c => `- ${c.name}${c.phone?" | "+c.phone:""}${c.email?" | "+c.email:""}${c.address?" | "+c.address:""}${c.notes?" | Notes: "+c.notes:""}`).join("\n") || "None on file"}

LEADS (prospects — not yet clients; may have no project):
${(data.leads||[]).map(l => `- ${l.name} [${l.status||"New"}]${l.phone?" | "+l.phone:""}${l.email?" | "+l.email:""}${l.address?" | "+l.address:""}${l.source?" | Source: "+l.source:""}${l.followup?" | Follow-up: "+l.followup:""}${l.value?" | Est: "+l.value:""}${l.desc?" | Wants: "+l.desc:""}`).join("\n") || "None on file"}
PROJECTS:
${(data.projects||[]).map(p => `- ${p.name} [${p.status||"Active"}]${p.client?" | Client: "+p.client:""}${p.address?" | "+p.address:""}${p.startDate?" | Start: "+p.startDate:""}${p.rate?" | Billing: $"+p.rate+"/hr":""}${(p.oosRate!==undefined&&p.oosRate!=="")?" | OOS Rate: $"+p.oosRate+"/hr (for extra/change-order work)":""}${p.contractAmount?" | Contract: $"+p.contractAmount:""}${(p.markup!==undefined&&p.markup!=="")?" | Materials Markup: "+p.markup+"%":""}${(p.subMarkup!==undefined&&p.subMarkup!=="")?" | Subs Markup: "+p.subMarkup+"%":""}${p.notes?" | Scope: "+p.notes:""}`).join("\n") || "None on file"}

CHANGE ORDERS (client-approved extra work, invoiced separately):
${(() => { const cos = data.changeOrders || {}; const lines = []; for (const pj of Object.keys(cos)) for (const c of cos[pj]) if (c.status === "open") lines.push(`- ${pj} | CO #${c.num} "${c.name}" | ${c.type === "fixed" ? "FIXED $" + c.fixedAmount : "T&M"} | approved ${c.date}${c.notes ? " | " + c.notes : ""}`); return lines.join("\n") || "None — create with save_change_order when a client approves extra work"; })()}

CREW:
${(data.crew||[]).map(c => `- ${c.name}${c.nickname?" ("+c.nickname+")":""}${c.role?" | "+c.role:""}${c.hourlyRate?" | Pay: $"+c.hourlyRate+"/hr":""}${c.phone?" | "+c.phone:""}${c.notes?" | "+c.notes:""}`).join("\n") || "None on file"}

SUBCONTRACTORS:
${(data.subs||[]).map(s => `- ${s.company||s.name}${s.trade?" | "+s.trade:""}${s.contact?" | Contact: "+s.contact:""}${s.phone?" | "+s.phone:""}${s.rate?" | Rate: "+s.rate:""}${s.cslbNumber?" | CSLB #"+s.cslbNumber+(s.cslbExpiration?" exp "+s.cslbExpiration:""):""}${s.glCarrier?" | GL: "+s.glCarrier+(s.glExpiration?" exp "+s.glExpiration:""):""}${s.wcCarrier?" | WC: "+s.wcCarrier+(s.wcExpiration?" exp "+s.wcExpiration:""):""}${s.notes?" | Notes: "+s.notes:""}`).join("\n") || "None on file"}

UNIT PRICES:
${(data.unitPrices||[]).map(u => `- ${u.description}${u.category?" ["+u.category+"]":""}${u.price?" | $"+u.price+" per "+(u.unit||"ea"):""}${u.notes?" | "+u.notes:""}`).join("\n") || "None on file"}

DAILY ENTRIES LOG (hours worked & materials purchased, newest first):
${(data.entries||[]).length === 0 ? "No entries logged yet" : [...(data.entries||[])].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(e => {
  const crew = (e.crew||[]).map(c=>{const reg=c.outOfScope?0:parseFloat(c.hours||0);const oos=c.outOfScope?parseFloat(c.hours||0):parseFloat(c.oosHours||0);return `${c.name} ${reg}hr${oos>0?'+'+oos+'hr OOS':''}`;}).join(", ");
  const mats = (e.materials||[]).map(m=>`${m.description} $${m.cost}`).join(", ");
  const totalHrs = (e.crew||[]).reduce((s,c)=>s+parseFloat(c.hours||0),0);
  const totalMat = (e.materials||[]).reduce((s,m)=>s+parseFloat(m.cost||0),0);
  return `- [${e.date}] ${e.project}${crew?" | Crew: "+crew+" ("+totalHrs+"hr total)":""}${mats?" | Materials: "+mats+" ($"+totalMat.toFixed(2)+" total)":""}${e.notes?" | "+e.notes:""}`;
}).join("\n")}

GENERAL NOTES (reminders, ideas, supplier info, follow-ups):
${(data.generalNotes||[]).length === 0 ? "No general notes yet" : [...(data.generalNotes||[])].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(n=>`- [${n.date||""}] [${n.tag||"General"}] ${n.note}`).join("\n")}

GENERAL EXPENSES (company overhead — tools, fuel, supplies NOT tied to any client project):
${(data.generalExpenses||[]).length === 0 ? "None logged yet" : [...(data.generalExpenses||[])].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(e=>`- [${e.date}] [${e.category||"Other"}] ${e.store?e.store+": ":""}${e.description} $${parseFloat(e.amount||0).toFixed(2)}${e.receiptNumber?" Receipt #"+e.receiptNumber:""}${e.notes?" | "+e.notes:""}`).join("\n")}
${(data.generalExpenses||[]).length > 0 ? "All-time totals by category: "+['Tools','Fuel','Truck/Vehicle','Safety/PPE','General Supplies','Permits/Fees','Other'].map(cat=>{const t=(data.generalExpenses||[]).filter(e=>e.category===cat).reduce((s,e)=>s+parseFloat(e.amount||0),0);return t>0?cat+" $"+t.toFixed(2):null;}).filter(Boolean).join(" | ") : ""}`;

  return [
    { type: "text", text: staticPart, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicPart }
  ];
}

// ── Tool definitions ──
const TOOLS = [
  {
    name: "save_entry",
    description: "Save a daily work entry: hours logged by crew and/or materials purchased, for a specific job and date. Use whenever Walt logs hours, records work done, or mentions materials bought.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format. Use today's ISO date if Walt says 'today'." },
        project: { type: "string", description: "Project/job name. Match to an existing project name if possible." },
        crew: {
          type: "array",
          description: "Crew members and hours each worked.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Full name or nickname (e.g. Moi, Ab, Chemo)" },
              hours: { type: "string", description: "Hours worked, e.g. '8' or '5'. IMPORTANT: if changeOrder is set on this crew item, these hours ARE the change-order hours (kept separate from base-contract labor) — put the CO hours here, do NOT use '0'. Use '0' only when the person did not work." },
              oosHours: { type: "string", description: "Out-of-scope hours for this crew member on this same entry. Use when Walt says 'out of scope', 'extra work', 'change order', or 'bill separately'. Can accompany regular hours for a mixed day — e.g. { hours: '5', oosHours: '3' } for 5 regular + 3 OOS. Omit or leave '0' if no OOS hours." },
              note: { type: "string", description: "Optional status note for this crew member on this day, e.g. 'Sick', 'Vacation', 'No show', 'Half day'. Use when Walt mentions a person's absence or status instead of hours." },
              color: { type: "string", description: "Optional hex color for the note. Match by name: red: #cc4444, orange: #e8720c, yellow: #e8c020, green: #2a9a2a, teal: #1a8a8a, blue: #1a5fa8, purple: #6b2fbe, pink: #b02080. Default for absences: #884444. Omit if no note." },
              changeOrder: { type: "string", description: "Name or number of the change order these hours belong to (e.g. 'deck footing' or 'CO #1'). Use when the hours are for client-approved extra work tied to a change order. Omit for regular contract work." }
            },
            required: ["name", "hours"]
          }
        },
        materials: {
          type: "array",
          description: "Materials or supplies purchased.",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              cost: { type: "string", description: "Dollar amount, e.g. '245.00'" },
              kind: { type: "string", enum: ["material", "sub"], description: "Use 'sub' when this is a payment to a subcontractor rather than a material purchase. Default 'material'." },
              markupPct: { type: "number", description: "Per-item markup percent, ONLY if Walt explicitly states one for this item. Otherwise omit — the project defaults apply." },
              changeOrder: { type: "string", description: "Name or number of the change order this item belongs to. Omit for base-contract purchases." }
            },
            required: ["description"]
          }
        },
        notes: { type: "string", description: "What was done, any relevant notes." },
        force: { type: "boolean", description: "Set true to force-save even if a material duplicate warning was returned. Use only after Walt confirms he wants to save anyway." }
      },
      required: ["date", "project"]
    }
  },
  {
    name: "save_change_order",
    description: "Create a change order (CO) on a project — client-approved billable work outside the base contract. Use when Walt says a client approved a change order, extra work, or additional scope. COs are invoiced separately from the base contract.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project/job name. Match to an existing project." },
        name: { type: "string", description: "Short name for the change order, e.g. 'deck footing' or 'upstairs bath add'. If Walt gives none, use a concise description of the work." },
        type: { type: "string", enum: ["fixed", "tm"], description: "'fixed' = agreed flat price; 'tm' = time & materials (hours at the project's OOS rate + materials with markup). Ask Walt if unclear." },
        fixedAmount: { type: "string", description: "Required when type is 'fixed' — the agreed dollar amount, e.g. '1500.00'." },
        date: { type: "string", description: "Approval date YYYY-MM-DD. Default today." },
        notes: { type: "string", description: "Scope description / what the client approved." }
      },
      required: ["project", "name", "type"]
    }
  },
  {
    name: "cancel_change_order",
    description: "Cancel/void a change order on a project. Use only when Walt explicitly says a change order is cancelled or was created by mistake.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project/job name." },
        name: { type: "string", description: "Name or number of the change order to cancel." }
      },
      required: ["project", "name"]
    }
  },
  {
    name: "save_general_expense",
    description: "Save a company overhead expense NOT tied to any client project — tools, fuel, truck/vehicle, safety gear, general supplies, permits. Use when Walt logs a purchase with no project named, or when the item is clearly company overhead that won't appear on a client invoice.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format." },
        store: { type: "string", description: "Store or vendor name, e.g. 'Home Depot', 'Chevron', 'AutoZone'." },
        description: { type: "string", description: "What was purchased." },
        amount: { type: "string", description: "Dollar amount, e.g. '85.00'." },
        category: {
          type: "string",
          enum: ["Tools","Fuel","Truck/Vehicle","Safety/PPE","General Supplies","Permits/Fees","Other"],
          description: "Tools: power/hand tools, bits, blades. Fuel: gas/diesel for truck. Truck/Vehicle: repairs, maintenance, registration. Safety/PPE: hard hats, gloves, glasses, vests. General Supplies: misc hardware/lumber not job-specific. Permits/Fees: business licenses, permit fees. Other: anything else."
        },
        receiptNumber: { type: "string", description: "Receipt or order number if mentioned." },
        notes: { type: "string", description: "Any additional notes." },
        force: { type: "boolean", description: "Set true to force-save past a duplicate warning." }
      },
      required: ["date", "description", "amount", "category"]
    }
  },
  {
    name: "save_client",
    description: "Add a new client or update an existing one by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        address: { type: "string" },
        notes: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "save_project",
    description: "Add a new project/job or update an existing one by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        client: { type: "string" },
        address: { type: "string" },
        status: { type: "string", enum: ["Active", "Bidding", "On Hold", "Complete"] },
        startDate: { type: "string", description: "YYYY-MM-DD" },
        rate: { type: "string", description: "Regular billing rate per hour to client" },
        oosRate: { type: "string", description: "Out-of-scope hourly rate billed to client for extra/change-order work. If not set, OOS hours are billed at the regular rate." },
        contractAmount: { type: "string" },
        billingType: { type: "string", enum: ["tm", "fixed"], description: "'fixed' = fixed-price contract job (client pays the contractAmount, not hourly — hours/materials are tracked as internal job cost only). 'tm' = time & materials (default). Set 'fixed' when Walt says a job is fixed price, fixed bid, flat price, or contract price. When setting 'fixed', contractAmount should also be set." },
        notes: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "save_crew_member",
    description: "Add a new crew member or update an existing one by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
        role: { type: "string" },
        hourlyRate: { type: "string" },
        phone: { type: "string" },
        notes: { type: "string" }
      },
      required: ["name"]
    }
  },
  {
    name: "save_unit_price",
    description: "Add or update a unit price / pricing item.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        category: { type: "string" },
        unit: { type: "string", description: "e.g. hr, sq ft, ea, linear ft" },
        price: { type: "string" },
        notes: { type: "string" }
      },
      required: ["description", "price"]
    }
  },
  {
    name: "save_note",
    description: "Save a general business note — reminders, supplier info, equipment notes, ideas, or follow-ups. Use whenever Walt wants to jot something down that isn't a daily entry.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format. Use today's ISO date if Walt says 'today' or doesn't specify." },
        note: { type: "string", description: "The note text, verbatim from Walt." },
        tag: { type: "string", enum: ["General","Supplier","Equipment","Reminder","Idea","Follow-up"], description: "Category tag for the note." }
      },
      required: ["date", "note"]
    }
  },
  {
    name: "send_email",
    description: `Send an email to a client on behalf of Mullins Construction. Use when Walt asks to email an invoice, proposal, or any document to a client — e.g. "send this to Barbara", "email the invoice to the client", "send Barbara her invoice". The to_email should come from the client record in the data. If the client email is not on file, ask Walt for it before sending. Always confirm before sending: "Ready to email this invoice to [email] — shall I send it?" Then send only after Walt confirms with yes/send/go ahead. The invoice or proposal is sent as a PDF attachment with a professional email message body. Generate a friendly, professional email_body that references the client by first name, mentions the property address, and states the total amount (for invoices) or the scope summary (for proposals). The PDF attachment will be named using pdf_filename.`,
    input_schema: {
      type: "object",
      properties: {
        to_email: { type: "string", description: "Recipient email address. OMIT for owner-review sends — the server routes those automatically." },
        owner_review: { type: "boolean", description: "Set true when Walt asks to send the document to himself for review ('send it to me', 'email me a copy'). Server routes the recipient — do not pass to_email." },
        to_name: { type: "string", description: "Recipient full name." },
        subject: { type: "string", description: "Email subject line, e.g. 'Invoice #1003 — Mullins Construction Inc.' or 'Proposal — Kitchen Remodel — Mullins Construction'" },
        html_body: { type: "string", description: "Complete HTML content of the invoice or proposal exactly as generated — do not simplify or strip it." },
        client_name: { type: "string", description: "Client's first name for the email greeting." },
        email_body: { type: "string", description: "The body text of the email message. Write a professional, friendly 3-4 sentence message referencing the attached document, the job address, and the total amount due if it's an invoice. Mention payment options (check to Mullins Construction or Zelle)." },
        pdf_filename: { type: "string", description: "Filename for the PDF attachment, e.g. 'Invoice-1006-Cooney.pdf' or 'Proposal-Cooney-Kitchen.pdf'" },
        project: { type: "string", description: "Project/job name this document belongs to, for an existing job. Do NOT set for a lead — use the lead field instead." },
        lead: { type: "string", description: "Lead/prospect name (exact, from the LEADS list) this document is for, when the recipient is a prospect rather than an existing client/project. Files it into that Lead Card. Use INSTEAD of project for leads." },
        doc_type: { type: "string", enum: ["invoice", "proposal", "other"], description: "What kind of document this is. Used to file it in the job's document history." },
        include_photos: { type: "boolean", description: "Set true when Walt asks to include photos/pictures/pics in the document. The server automatically finds the photos stored on that project or client and adds them to the PDF — do NOT ask Walt to upload them and do NOT try to include images yourself. When using this, client_name must match the client card's name (full name, not just first name)." },
      photo_report: { type: "boolean", description: "Set true ONLY for a standalone photo report (a document whose purpose is the photos themselves, no estimate or pricing). Controls the photo section heading: true shows 'PROJECT PHOTOS', false/absent shows 'REFERENCE PHOTOS'. Do NOT set this for an estimate or invoice that merely includes photos." }  
      },
      required: ["subject", "html_body"]
    }
  },
  {
    name: "send_proposal_link",
    description: `Send a proposal, contract, or change order as a secure e-acceptance link. This is the DEFAULT delivery method for proposals, contracts, and change orders — use it whenever Walt asks to send one of those document types, unless he explicitly says PDF or attachment. The client (or Walt, for owner-review sends) opens a webpage showing the document and clicks Accept.`,
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project/job name this proposal is for, for an existing job. Do NOT set for a lead — use the lead field instead." },
        lead: { type: "string", description: "Lead/prospect name (exact, from the LEADS list) this document is for, when it's for a prospect rather than an existing project. Files it into that Lead Card. Use INSTEAD of project for leads." },
        to_email: { type: "string", description: "Client's email address. OMIT for owner-review sends — the server routes those automatically." },
        owner_review: { type: "boolean", description: "Set true when Walt asks to send the document to himself for review. Server routes the recipient — do not pass to_email." },
        doc_kind: { type: "string", enum: ["proposal", "contract", "change_order"], description: "What kind of agreement document this is. Drives labeling on the acceptance page." },
        to_name: { type: "string", description: "Client's full name." },
        client_name: { type: "string", description: "Client's first name for the email greeting." },
        subject: { type: "string", description: "Email subject line, e.g. 'Proposal — Kitchen Remodel — Mullins Construction'" },
        html_body: { type: "string", description: "Complete HTML content of the proposal exactly as generated — this is what the client will see and accept. Do not simplify, strip, or add your own signature block to it." },
        email_body: { type: "string", description: "Short 2-3 sentence friendly email message inviting the client to review and accept the proposal online. Mention the job address. Do not mention a PDF attachment." }
      },
      required: ["subject", "html_body"]
    }
  },
  {
    name: "file_document",
    description: `Save the file Walt uploaded with his CURRENT message into a project's document history ("job docs"). Use when Walt uploads a PDF, image, or other file and asks to save/file/keep it, or clearly indicates it belongs to a job — e.g. "save this to the Bob Good job", "file this with the Nguyen project", "keep this receipt with Cronce". Only works for a file attached to the current message. After saving, the document is viewable in that project's Job Docs on the dashboard. Match project to an existing project name. If Walt uploads a file that obviously belongs to a job (like "here's the signed permit for Cronce") but doesn't explicitly say to save it, answer his question first, then offer: "Want me to file this in the Cronce job docs?"`,
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project/job name to file this document under. Match to an existing project name." },
        name: { type: "string", description: "Display name for the document, e.g. 'Signed permit', 'ADP payroll report June'. Default to the uploaded filename if Walt didn't name it." },
        doc_type: { type: "string", enum: ["invoice", "proposal", "receipt", "permit", "contract", "file"], description: "Category, best guess from context. Default 'file'." }
      },
      required: ["project"]
    }
  },
  {
    name: "save_appointment",
    description: "Save an appointment, meeting, or scheduled event — NOT tied to job hours or materials. Use when Walt says things like 'meeting at 11:30 with Gary at 111 Main St', 'I have an appointment tomorrow at 2 with the inspector', 'remind me I'm seeing Barbara Friday at 9am'. This is for client walkthroughs, permit office visits, inspections, phone calls, and anything scheduled. If the time is ambiguous (e.g. 'this afternoon'), ask Walt for a specific time before saving.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format. Default to today's ISO date if Walt doesn't specify. Resolve 'tomorrow', weekday names, etc. relative to the current date." },
        time: { type: "string", description: "24-hour time HH:MM, e.g. '11:30' or '14:00'. Required — ask Walt if not given." },
        time_display: { type: "string", description: "Human-readable time, e.g. '11:30 AM' or '2:00 PM'." },
        person: { type: "string", description: "Who the meeting is with, e.g. 'Gary', 'City inspector'. Omit if not mentioned." },
        address: { type: "string", description: "Location/address if mentioned, e.g. '111 Main St, San Jose'. Omit if not mentioned." },
        notes: { type: "string", description: "Anything else Walt mentioned — purpose, things to bring, etc." }
      },
      required: ["date", "time", "time_display"]
    }
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment. Use when Walt says things like 'cancel my 11:30 with Gary', 'the meeting with the inspector is off', 'scratch Friday's appointment'. Match against the appointment list in the system prompt by person, time, and/or date. If more than one could match, ask Walt which one.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The appointment id from the TODAY'S APPOINTMENTS / UPCOMING APPOINTMENTS list in your context." }
      },
      required: ["id"]
    }
  },
  {
    name: "get_monthly_totals",
    description: "Compute EXACT totals from the entries log using real arithmetic: hours per worker per month, labor billed, materials cost and billed (with correct markup), and subs. ALWAYS call this tool instead of adding numbers yourself whenever Walt asks for totals, sums, monthly hours, materials spend, labor dollars, or any figure that requires adding more than two numbers from entries — including arbitrary date ranges, one worker's hours, or spend at one store. Manual arithmetic across entries is unreliable — this tool is the source of truth and matches the dashboard job panels exactly.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Exact project name from the PROJECTS list to filter to one job (a partial match also works). Omit for all projects." },
        month: { type: "string", description: "Month as YYYY-MM (e.g. 2026-06) to filter to one month. Omit for all months." },
        from: { type: "string", description: "Start date YYYY-MM-DD (inclusive) for an arbitrary date range, e.g. Walt asks 'May 21 to June 27'. Use with 'to'. Omit for no lower bound." },
        to: { type: "string", description: "End date YYYY-MM-DD (inclusive) for an arbitrary date range. Omit for no upper bound." },
        worker: { type: "string", description: "Crew member name or nickname to count ONLY that person's hours. Materials/subs are omitted when this is set (they aren't per-worker)." },
        store: { type: "string", description: "Store name to count ONLY materials from that store (partial match, e.g. 'home depot'). Hours are omitted when this is set." }
      },
      required: []
    }
  },
  {
    name: "compute_invoice",
    description: "Compute EXACT invoice numbers for a project with real arithmetic: labor lines per worker (regular/OOS at correct rates), every material line with its markup applied and rounded to cents, subs, change orders (fixed amount or T&M), payments received, period total, and all-time account balance due. MANDATORY: before composing ANY invoice, or answering 'what does [client] owe', call this tool and use its line amounts and totals VERBATIM on the document — never compute invoice numbers yourself. Rounding policy: each line is rounded to cents, totals are sums of the rounded lines.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Exact project name from the PROJECTS list (partial match works)." },
        from: { type: "string", description: "Invoice period start date YYYY-MM-DD (inclusive). Omit to include all entries." },
        to: { type: "string", description: "Invoice period end date YYYY-MM-DD (inclusive). Omit to include all entries." }
      },
      required: ["project"]
    }
  },
  {
    name: "vault_lookup",
    description: "Search Walt's Personal Vault for reference info he has saved — account numbers, gate codes, addresses, member numbers, VINs, policy numbers, support PINs, renewal dates, etc. Vault data is NOT in your context, so you MUST call this tool to answer any question about it. Use whenever Walt asks 'what's my/his X', 'when does X renew', 'what's the code for X', or similar. Passwords are never stored here. Only return what Walt asked for — do not read out an entire entry unless he asks for all of it.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "ONE short keyword — the entity name only, not the whole question. For 'what's my Alaska Air flyer number' search 'Alaska'. For 'AT&T account number' search 'AT&T'. For 'gate code for the Cabo condo' search 'Cabo'. Never pass a full phrase or sentence — it will not match. Matches against title, category, field labels, and notes." },
        category: { type: "string", description: "Optional category filter, e.g. 'Utilities', 'Family', 'Travel', 'Vehicles'." }
      },
      required: ["query"]
    }
    },
  {
    name: "vault_save",
    description: "Add a new entry to Walt's Personal Vault, or add fields to an existing one. Use when Walt says things like 'save my Alaska flyer number 80927453', 'add the Cabo gate code 4471 to my vault', or says yes after you offer to save something. NEVER store passwords — if Walt gives you a password, decline and tell him it belongs in a password manager, not the Vault. Before saving, call vault_lookup first to see if an entry already exists; if it does, pass its exact title so the fields merge instead of creating a duplicate.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Entry name, e.g. 'Alaska Air', 'AT&T Fiber', 'Cabo Condo'. If updating an existing entry, use its exact existing title." },
        category: { type: "string", description: "Category, e.g. 'Utilities', 'Family', 'Travel', 'Vehicles', 'Insurance'. Pick a sensible one if Walt didn't say." },
        fields: {
          type: "array",
          description: "The details to save. Each item is a label and a value.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "e.g. 'Account #', 'Support PIN', 'Gate code', 'VIN'" },
              value: { type: "string", description: "The value itself" }
            },
            required: ["label", "value"]
          }
        },
        notes: { type: "string", description: "Optional extra context." },
        renewal_date: { type: "string", description: "Optional renewal/expiration date, YYYY-MM-DD." }
      },
      required: ["title", "fields"]
    }
  }
];

// ── Prompt caching: mark the last tool so the whole TOOLS array is cached ──
const TOOLS_CACHED = TOOLS.map((t, i) =>
  i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
);

// ── Duplicate entry guard (30-second window) ──
const recentSaves = new Map();
function isDuplicateEntry(entry) {
  const key = `${entry.date}|${entry.project}|${(entry.crew||[]).map(c=>c.name).sort().join(",")}`;
  const now = Date.now();
  const last = recentSaves.get(key);
  if (last && now - last < 30000) return true;
  recentSaves.set(key, now);
  return false;
}

// ── Fuzzy project name matcher ──
function fuzzyMatchProject(inputName, projects) {
  if (!projects || !projects.length) return inputName;
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const words = s => normalize(s).split(/\s+/).filter(w => w.length > 2);
  const input = normalize(inputName);
  const inputWords = words(inputName);
  let bestMatch = null;
  let bestScore = 0;
  for (const p of projects) {
    const projNorm = normalize(p.name);
    const projWords = words(p.name);
    let score = 0;
    // Word overlap: each input word that appears as substring of any project word
    for (const iw of inputWords) {
      if (projWords.some(pw => pw.includes(iw) || iw.includes(pw))) score += 2;
    }
    // Direct containment bonus
    if (projNorm.includes(input) || input.includes(projNorm)) score += 3;
    if (score > bestScore) { bestScore = score; bestMatch = p.name; }
  }
  // Only substitute if we found a real match (score threshold)
  return bestScore >= 2 ? bestMatch : inputName;
}

// ── Material duplicate checker ──
function checkMaterialDuplicate(date, project, description, amount, entries) {
  const descLower = (description || '').toLowerCase().trim();
  const amt = parseFloat(amount || 0);
  const pool = (entries || []).filter(e =>
    e.date === date && (e.project||'').toLowerCase() === (project||'').toLowerCase()
  );
  for (const entry of pool) {
    for (const mat of (entry.materials || [])) {
      const existDesc = (mat.description || '').toLowerCase().trim();
      const existAmt = parseFloat(mat.cost || 0);
      if (existDesc === descLower && Math.abs(existAmt - amt) < 0.01) {
        return { type: 'exact', existing: { description: mat.description, cost: mat.cost, date } };
      }
      const amtClose = Math.abs(existAmt - amt) <= 5;
      const descSim = descLower.length > 4 && existDesc.length > 4 &&
        (descLower.includes(existDesc.slice(0,6)) || existDesc.includes(descLower.slice(0,6)));
      if (amtClose && descSim) {
        return { type: 'fuzzy', existing: { description: mat.description, cost: mat.cost, date } };
      }
    }
  }
  return null;
}

// ── Tool executor ──
// ── Exact arithmetic for chat: mirrors the dashboard job-panel math ──
const _r2 = x => Math.round(x * 100) / 100;
const _isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

function _mathHelpers(data) {
  const projects = data.projects || [];
  const findProj = n => projects.find(p => (p.name || "").toLowerCase() === (n || "").toLowerCase());
  const rateFor = p => (p && p.rate ? parseFloat(p.rate) || 0 : 0);
  const oosFor = p => (p && p.oosRate && String(p.oosRate).trim() !== "" ? parseFloat(p.oosRate) || rateFor(p) : rateFor(p));
  const matPct = (m, p) => {
    if (m && m.markupPct != null && !isNaN(parseFloat(m.markupPct))) return parseFloat(m.markupPct);
    if (p && p.markup !== undefined && p.markup !== "" && !isNaN(parseFloat(p.markup))) return parseFloat(p.markup);
    return 15;
  };
  const subPct = (m, p) => {
    if (m && m.markupPct != null && !isNaN(parseFloat(m.markupPct))) return parseFloat(m.markupPct);
    if (p && p.subMarkup !== undefined && p.subMarkup !== "" && !isNaN(parseFloat(p.subMarkup))) return parseFloat(p.subMarkup);
    return 0;
  };
  const payRateFor = name => {
    const c = (data.crew || []).find(c => [c.name, c.nickname].filter(Boolean).some(x => String(x).toLowerCase() === (name || "").toLowerCase()));
    if (!c) return null;
    const v = parseFloat(c.payRate || c.hourlyRate || c.rate);
    return isNaN(v) ? null : v;
  };
  const resolveProject = raw => {
    const q = (raw || "").trim().toLowerCase();
    if (!q) return null;
    return projects.find(p => (p.name || "").toLowerCase() === q) || projects.find(p => (p.name || "").toLowerCase().includes(q)) || undefined;
  };
  const workerMatches = (crewName, filter) => {
    if (!filter) return true;
    const f = filter.trim().toLowerCase();
    const n = (crewName || "").toLowerCase();
    if (n === f || n.includes(f)) return true;
    const c = (data.crew || []).find(c => [c.name, c.nickname].filter(Boolean).some(x => String(x).toLowerCase() === f || String(x).toLowerCase().includes(f)));
    if (!c) return false;
    return [c.name, c.nickname].filter(Boolean).some(x => String(x).toLowerCase() === n);
  };
  return { projects, findProj, rateFor, oosFor, matPct, subPct, payRateFor, resolveProject, workerMatches };
}

function computeMonthlyTotals(data, input) {
  const H = _mathHelpers(data);
  const monthFilter = (input.month || "").trim();
  const from = (input.from || "").trim(), to = (input.to || "").trim();
  if (from && !_isDate(from)) return { ok: true, readOnly: true, error: "'from' must be YYYY-MM-DD, got '" + from + "'" };
  if (to && !_isDate(to)) return { ok: true, readOnly: true, error: "'to' must be YYYY-MM-DD, got '" + to + "'" };
  const workerFilter = (input.worker || "").trim();
  const storeFilter = (input.store || "").trim().toLowerCase();

  let projFilter = "";
  if ((input.project || "").trim()) {
    const p = H.resolveProject(input.project);
    if (!p) return { ok: true, readOnly: true, type: "monthly_totals", error: "No project matches '" + input.project + "'", availableProjects: H.projects.map(p => p.name) };
    projFilter = (p.name || "").toLowerCase();
  }

  const months = {};
  for (const en of (data.entries || [])) {
    if (!en || !en.date) continue;
    const d = String(en.date);
    if (monthFilter && d.slice(0, 7) !== monthFilter) continue;
    if (from && d < from) continue;
    if (to && d > to) continue;
    const pname = en.project || "(no project)";
    if (projFilter && pname.toLowerCase() !== projFilter) continue;
    const proj = H.findProj(pname);
    const mKey = d.slice(0, 7);
    if (!months[mKey]) months[mKey] = {};
    if (!months[mKey][pname]) months[mKey][pname] = { hoursByWorker: {}, regularHours: 0, oosOrCoHours: 0, totalHours: 0, laborBilled: 0, laborCostAtPay: 0, payRateMissing: [], materialsCost: 0, materialsBilled: 0, subsCost: 0, subsBilled: 0, entryCount: 0 };
    const agg = months[mKey][pname];
    agg.entryCount++;
    const rate = H.rateFor(proj), oos = H.oosFor(proj);
    const fixed = !!(proj && proj.billingType === "fixed");

    if (!storeFilter) {
      for (const c of (en.crew || [])) {
        if (!H.workerMatches(c.name, workerFilter)) continue;
        const h = parseFloat(c.hours || 0) || 0;
        const oh = parseFloat(c.oosHours || 0) || 0;
        if (h <= 0 && oh <= 0) continue;
        const isCO = !!(c.coId || c.changeOrder);
        const isLegacyOOS = !!c.outOfScope;
        const nm = c.name || "(unnamed)";
        agg.hoursByWorker[nm] = (agg.hoursByWorker[nm] || 0) + h + oh;
        agg.totalHours += h + oh;
        if (isCO || isLegacyOOS) {
          agg.oosOrCoHours += h + oh;
          if (!fixed) agg.laborBilled += (h + oh) * oos;
        } else {
          agg.regularHours += h;
          agg.oosOrCoHours += oh;
          if (!fixed) agg.laborBilled += h * rate + oh * oos;
        }
        const pr = H.payRateFor(nm);
        if (pr == null) { if (!agg.payRateMissing.includes(nm)) agg.payRateMissing.push(nm); }
        else agg.laborCostAtPay += (h + oh) * pr;
      }
    }

    if (!workerFilter) {
      for (const m of (en.materials || [])) {
        const cc = parseFloat(m.cost || 0) || 0;
        if (!cc) continue;
        if (storeFilter && !String(m.store || "").toLowerCase().includes(storeFilter)) continue;
        if (m.kind === "sub") {
          agg.subsCost += cc;
          agg.subsBilled += cc * (1 + H.subPct(m, proj) / 100);
        } else {
          agg.materialsCost += cc;
          agg.materialsBilled += cc * (1 + H.matPct(m, proj) / 100);
        }
      }
    }
  }

  const out = { ok: true, readOnly: true, type: "monthly_totals", filters: { project: input.project || "all projects", month: monthFilter || null, from: from || null, to: to || null, worker: workerFilter || null, store: storeFilter || null }, months: [] };
  if (workerFilter) out.note = "Worker filter active: materials/subs omitted (they are not per-worker).";
  if (storeFilter) out.note = "Store filter active: hours omitted (they are not per-store).";
  const grand = { totalHours: 0, laborBilled: 0, materialsCost: 0, materialsBilled: 0, subsCost: 0, subsBilled: 0 };

  for (const mKey of Object.keys(months).sort()) {
    const projsOut = [];
    const mt = { totalHours: 0, laborBilled: 0, materialsCost: 0, materialsBilled: 0, subsCost: 0, subsBilled: 0 };
    for (const pname of Object.keys(months[mKey]).sort()) {
      const a = months[mKey][pname];
      const proj = H.findProj(pname);
      const hbw = {};
      for (const k of Object.keys(a.hoursByWorker)) hbw[k] = _r2(a.hoursByWorker[k]);
      const po = {
        project: pname,
        billingType: (proj && proj.billingType === "fixed") ? "fixed" : "tm",
        entryCount: a.entryCount,
        totalHours: _r2(a.totalHours),
        regularHours: _r2(a.regularHours),
        oosOrCoHours: _r2(a.oosOrCoHours),
        hoursByWorker: hbw,
        materialsCost: _r2(a.materialsCost),
        materialsBilled: _r2(a.materialsBilled)
      };
      if (a.subsCost) { po.subsCost = _r2(a.subsCost); po.subsBilled = _r2(a.subsBilled); }
      if (po.billingType === "fixed") {
        po.laborBilled = 0;
        po.laborCostAtCrewPay = _r2(a.laborCostAtPay);
        po.note = "Fixed-price job: hours/materials are internal cost only; client is billed the contract amount, not these figures.";
        if (a.payRateMissing.length) po.payRateMissing = a.payRateMissing;
      } else {
        po.laborBilled = _r2(a.laborBilled);
      }
      projsOut.push(po);
      mt.totalHours += a.totalHours;
      mt.laborBilled += (po.billingType === "fixed" ? 0 : a.laborBilled);
      mt.materialsCost += a.materialsCost;
      mt.materialsBilled += a.materialsBilled;
      mt.subsCost += a.subsCost;
      mt.subsBilled += a.subsBilled;
    }
    out.months.push({
      month: mKey,
      projects: projsOut,
      monthTotal: { totalHours: _r2(mt.totalHours), laborBilled: _r2(mt.laborBilled), materialsCost: _r2(mt.materialsCost), materialsBilled: _r2(mt.materialsBilled), subsCost: _r2(mt.subsCost), subsBilled: _r2(mt.subsBilled) }
    });
    grand.totalHours += mt.totalHours;
    grand.laborBilled += mt.laborBilled;
    grand.materialsCost += mt.materialsCost;
    grand.materialsBilled += mt.materialsBilled;
    grand.subsCost += mt.subsCost;
    grand.subsBilled += mt.subsBilled;
  }
  out.grandTotal = { totalHours: _r2(grand.totalHours), laborBilled: _r2(grand.laborBilled), materialsCost: _r2(grand.materialsCost), materialsBilled: _r2(grand.materialsBilled), subsCost: _r2(grand.subsCost), subsBilled: _r2(grand.subsBilled) };
  if (!out.months.length) out.note = "No entries matched these filters.";
  return out;
}

// ── Exact invoice math: line-level rounding, COs, payments, account balance ──
function computeInvoice(data, input) {
  const H = _mathHelpers(data);
  const proj = H.resolveProject(input.project);
  if (!proj) return { ok: true, readOnly: true, type: "invoice_math", error: "No project matches '" + (input.project || "") + "'", availableProjects: H.projects.map(p => p.name) };
  const pname = proj.name;
  const from = (input.from || "").trim(), to = (input.to || "").trim();
  if (from && !_isDate(from)) return { ok: true, readOnly: true, error: "'from' must be YYYY-MM-DD, got '" + from + "'" };
  if (to && !_isDate(to)) return { ok: true, readOnly: true, error: "'to' must be YYYY-MM-DD, got '" + to + "'" };

  const rate = H.rateFor(proj), oos = H.oosFor(proj);
  const fixed = !!(proj.billingType === "fixed");
  const inRange = d => (!from || d >= from) && (!to || d <= to);

  function walk(rangeOnly) {
    const acc = { regHoursByWorker: {}, oosHoursByWorker: {}, matLines: [], subLines: [], coHours: {}, coMatLines: [] };
    for (const en of (data.entries || [])) {
      if (!en || !en.date || (en.project || "") !== pname) continue;
      const d = String(en.date);
      if (rangeOnly && !inRange(d)) continue;
      for (const c of (en.crew || [])) {
        const h = parseFloat(c.hours || 0) || 0;
        const oh = parseFloat(c.oosHours || 0) || 0;
        if (h <= 0 && oh <= 0) continue;
        const nm = c.name || "(unnamed)";
        const coKey = c.coId || c.changeOrder || null;
        if (coKey) {
          if (!acc.coHours[coKey]) acc.coHours[coKey] = {};
          acc.coHours[coKey][nm] = (acc.coHours[coKey][nm] || 0) + h + oh;
        } else if (c.outOfScope) {
          acc.oosHoursByWorker[nm] = (acc.oosHoursByWorker[nm] || 0) + h + oh;
        } else {
          if (h > 0) acc.regHoursByWorker[nm] = (acc.regHoursByWorker[nm] || 0) + h;
          if (oh > 0) acc.oosHoursByWorker[nm] = (acc.oosHoursByWorker[nm] || 0) + oh;
        }
      }
      for (const m of (en.materials || [])) {
        const cc = parseFloat(m.cost || 0) || 0;
        if (!cc) continue;
        const base = { date: d, desc: m.desc || m.description || "", store: m.store || "", cost: _r2(cc) };
        if (m.coId) {
          const pct = H.matPct(m, proj);
          acc.coMatLines.push({ ...base, markupPct: pct, billed: _r2(cc * (1 + pct / 100)), coId: m.coId });
        } else if (m.kind === "sub") {
          const pct = H.subPct(m, proj);
          acc.subLines.push({ ...base, markupPct: pct, billed: _r2(cc * (1 + pct / 100)) });
        } else {
          const pct = H.matPct(m, proj);
          acc.matLines.push({ ...base, markupPct: pct, billed: _r2(cc * (1 + pct / 100)) });
        }
      }
    }
    return acc;
  }

  function buildTotals(acc) {
    const laborLines = [];
    let laborTotal = 0;
    for (const nm of Object.keys(acc.regHoursByWorker).sort()) {
      const hrs = _r2(acc.regHoursByWorker[nm]);
      const amt = _r2(hrs * rate);
      laborLines.push({ worker: nm, kind: "regular", hours: hrs, rate: rate, amount: amt });
      laborTotal += amt;
    }
    for (const nm of Object.keys(acc.oosHoursByWorker).sort()) {
      const hrs = _r2(acc.oosHoursByWorker[nm]);
      const amt = _r2(hrs * oos);
      laborLines.push({ worker: nm, kind: "out-of-scope", hours: hrs, rate: oos, amount: amt });
      laborTotal += amt;
    }
    laborTotal = _r2(laborTotal);
    const matTotalCost = _r2(acc.matLines.reduce((s, l) => s + l.cost, 0));
    const matTotalBilled = _r2(acc.matLines.reduce((s, l) => s + l.billed, 0));
    const subTotalCost = _r2(acc.subLines.reduce((s, l) => s + l.cost, 0));
    const subTotalBilled = _r2(acc.subLines.reduce((s, l) => s + l.billed, 0));

    const cos = ((data.changeOrders || {})[pname] || []);
    const coLines = [];
    let coTotal = 0;
    const coKeysSeen = new Set([...Object.keys(acc.coHours), ...acc.coMatLines.map(l => String(l.coId))]);
    for (const co of cos) {
      const keys = [String(co.id || ""), String(co.name || ""), String(co.num || "")].filter(Boolean);
      const matched = [...coKeysSeen].filter(k => keys.some(x => x && (String(x) === String(k) || String(x).toLowerCase() === String(k).toLowerCase())));
      const isFixedCO = co.type === "fixed" && co.fixedAmount != null && co.fixedAmount !== "";
      if (isFixedCO) {
        const amt = _r2(parseFloat(co.fixedAmount) || 0);
        coLines.push({ name: co.name || ("CO #" + (co.num || "?")), type: "fixed", amount: amt, status: co.status || "" });
        coTotal += amt;
      } else {
        let hrs = 0;
        for (const k of matched) for (const nm of Object.keys(acc.coHours[k] || {})) hrs += acc.coHours[k][nm];
        const matBilled = _r2(acc.coMatLines.filter(l => matched.includes(String(l.coId))).reduce((s, l) => s + l.billed, 0));
        const laborAmt = _r2(hrs * oos);
        const amt = _r2(laborAmt + matBilled);
        if (hrs > 0 || matBilled > 0) {
          coLines.push({ name: co.name || ("CO #" + (co.num || "?")), type: "tm", hours: _r2(hrs), rate: oos, laborAmount: laborAmt, materialsBilled: matBilled, amount: amt, status: co.status || "" });
          coTotal += amt;
        }
      }
      for (const k of matched) coKeysSeen.delete(k);
    }
    for (const k of coKeysSeen) {
      let hrs = 0;
      for (const nm of Object.keys(acc.coHours[k] || {})) hrs += acc.coHours[k][nm];
      const matBilled = _r2(acc.coMatLines.filter(l => String(l.coId) === String(k)).reduce((s, l) => s + l.billed, 0));
      const amt = _r2(_r2(hrs * oos) + matBilled);
      if (hrs > 0 || matBilled > 0) {
        coLines.push({ name: "Unmatched CO reference: " + k, type: "tm", hours: _r2(hrs), rate: oos, amount: amt, warning: "No CO record matched this id/name — verify before invoicing" });
        coTotal += amt;
      }
    }
    coTotal = _r2(coTotal);
    return { laborLines, laborTotal, matTotalCost, matTotalBilled, subTotalCost, subTotalBilled, coLines, coTotal, matLines: acc.matLines, subLines: acc.subLines };
  }

  const period = buildTotals(walk(true));
  const allTime = (from || to) ? buildTotals(walk(false)) : period;

  const payments = ((data.payments || {})[pname] || []).map(p => ({ date: p.date || "", check: p.check || "", amount: _r2(parseFloat(p.amount || 0) || 0), notes: p.notes || "" }));
  const paymentsTotal = _r2(payments.reduce((s, p) => s + p.amount, 0));

  const out = { ok: true, readOnly: true, type: "invoice_math", project: pname, billingType: fixed ? "fixed" : "tm", period: { from: from || null, to: to || null }, roundingPolicy: "Each line rounded to cents; totals are sums of rounded lines. Use these amounts verbatim on the invoice." };

  if (fixed) {
    const contract = _r2(parseFloat(proj.contractAmount || 0) || 0);
    out.contractAmount = contract;
    out.changeOrders = { lines: period.coLines, total: period.coTotal };
    out.contractPlusCOs = _r2(contract + allTime.coTotal);
    out.payments = { lines: payments, total: paymentsTotal };
    out.remainingContractBalance = _r2(contract + allTime.coTotal - paymentsTotal);
    out.internalCostReference = { note: "NOT for the invoice — internal job costing only", materialsCost: period.matTotalCost, subsCost: period.subTotalCost };
    out.invoiceGuidance = "Fixed-price job: invoice contract payments per the payment schedule (deposit/progress/final) plus any change orders. Do NOT invoice hours or materials as line items.";
  } else {
    out.labor = { lines: period.laborLines, total: period.laborTotal };
    out.materials = { lines: period.matLines, totalCost: period.matTotalCost, totalBilled: period.matTotalBilled };
    if (period.subLines.length) out.subs = { lines: period.subLines, totalCost: period.subTotalCost, totalBilled: period.subTotalBilled };
    out.changeOrders = { lines: period.coLines, total: period.coTotal };
    out.periodInvoiceTotal = _r2(period.laborTotal + period.matTotalBilled + period.subTotalBilled + period.coTotal);
    out.payments = { lines: payments, total: paymentsTotal };
    const allTimeRevenue = _r2(allTime.laborTotal + allTime.matTotalBilled + allTime.subTotalBilled + allTime.coTotal);
    out.accountBalance = { allTimeRevenue: allTimeRevenue, paymentsTotal: paymentsTotal, balanceDue: _r2(allTimeRevenue - paymentsTotal) };
  }
  return out;
}

async function executeTool(toolName, input, data, ctx) {
  ctx = ctx || {};
  switch (toolName) {
    case "get_monthly_totals": {
      return computeMonthlyTotals(data, input || {});
    }
    case "compute_invoice": {
      return computeInvoice(data, input || {});
    }
    case "save_appointment": {
      if (!data.appointments) data.appointments = [];
      const appt = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        date: input.date,
        time: input.time,
        time_display: input.time_display,
        person: input.person || "",
        address: input.address || "",
        notes: input.notes || "",
        status: "upcoming",
        created_at: new Date().toISOString()
      };
      data.appointments.push(appt);
      data.appointments.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return { ok: true, action: "created", type: "appointment", data: appt };
    }
    case "cancel_appointment": {
      if (!data.appointments) data.appointments = [];
      const apptIdx = data.appointments.findIndex(a => a.id === input.id);
      if (apptIdx < 0) return { ok: false, message: "Appointment not found — ask Walt to clarify which appointment." };
      data.appointments[apptIdx].status = "cancelled";
      return { ok: true, action: "cancelled", type: "appointment", data: data.appointments[apptIdx] };
    }
    case "save_change_order": {
      if (!data.changeOrders) data.changeOrders = {};
      const coProj = fuzzyMatchProject(input.project, data.projects || []);
      if (!data.changeOrders[coProj]) data.changeOrders[coProj] = [];
      const list = data.changeOrders[coProj];
      const num = list.reduce((mx, c) => Math.max(mx, c.num || 0), 0) + 1;
      const co = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        num,
        name: input.name,
        type: input.type === "fixed" ? "fixed" : "tm",
        ...(input.type === "fixed" ? { fixedAmount: String(parseFloat(input.fixedAmount || 0).toFixed(2)) } : {}),
        date: input.date || new Date().toISOString().slice(0, 10),
        notes: input.notes || "",
        status: "open",
        created_at: new Date().toISOString()
      };
      if (co.type === "fixed" && parseFloat(co.fixedAmount || 0) <= 0) {
        return { ok: false, message: "Fixed-price change order needs a dollar amount — ask Walt for the agreed price." };
      }
      list.push(co);
      return { ok: true, action: "created", type: "change_order", data: { project: coProj, ...co },
        message: `Created CO #${num} "${co.name}" on ${coProj} (${co.type === "fixed" ? "fixed price $" + co.fixedAmount : "time & materials"}).` };
    }
    case "cancel_change_order": {
      const coProj2 = fuzzyMatchProject(input.project, data.projects || []);
      const list2 = ((data.changeOrders || {})[coProj2] || []);
      const q = String(input.name || "").toLowerCase();
      const co2 = list2.find(c => c.status === "open" && (String(c.num) === q.replace(/[^0-9]/g, "") || (c.name || "").toLowerCase().includes(q)));
      if (!co2) return { ok: false, message: "No matching open change order found on " + coProj2 + " — ask Walt to clarify which one." };
      co2.status = "cancelled";
      return { ok: true, action: "cancelled", type: "change_order", data: { project: coProj2, ...co2 } };
    }
    case "save_entry": {
      if (!data.entries) data.entries = [];
      // Fuzzy-match project name against existing projects
      const matchedProject = fuzzyMatchProject(input.project, data.projects || []);
      const resolveCO = (name) => {
        if (!name) return null;
        const list = ((data.changeOrders || {})[matchedProject] || []).filter(c => c.status === "open");
        if (!list.length) return null;
        const q = String(name).toLowerCase();
        const qNum = q.replace(/[^0-9]/g, "");
        return list.find(c => (qNum && String(c.num) === qNum) || (c.name || "").toLowerCase().includes(q) || q.includes((c.name || "").toLowerCase())) || null;
      };
      const unresolvedCOs = [];
      const entry = {
        date: input.date,
        project: matchedProject,
        crew: (input.crew || []).map(c => {
          const co = resolveCO(c.changeOrder);
          if (c.changeOrder && !co) unresolvedCOs.push(c.changeOrder);
          return {
            name: c.name,
            hours: c.hours || '0',
            ...(parseFloat(c.oosHours||0) > 0 ? { oosHours: String(c.oosHours) } : {}),
            ...(c.note ? { note: c.note } : {}),
            ...(c.color ? { color: c.color } : {}),
            ...(co ? { coId: co.id, coName: "CO #" + co.num + " " + co.name } : {})
          };
        }),
        materials: (input.materials || []).map(m => {
          const co = resolveCO(m.changeOrder);
          if (m.changeOrder && !co) unresolvedCOs.push(m.changeOrder);
          return {
            description: m.description,
            cost: m.cost || '0',
            ...(m.kind === 'sub' ? { kind: 'sub' } : {}),
            ...(m.markupPct != null && !isNaN(parseFloat(m.markupPct)) ? { markupPct: parseFloat(m.markupPct) } : {}),
            ...(co ? { coId: co.id, coName: "CO #" + co.num + " " + co.name } : {})
          };
        }),
        notes: input.notes || ""
      };
      if (unresolvedCOs.length) {
        return { ok: false, action: "co_not_found",
          message: `No open change order matching "${unresolvedCOs[0]}" on ${matchedProject}. Ask Walt: create it first with save_change_order (get fixed price or T&M), or check the CHANGE ORDERS list for the right name. Nothing was saved.` };
      }
      // Material duplicate check (per-material, before committing)
      if (!input.force && (input.materials || []).length > 0) {
        for (const mat of input.materials) {
          const dup = checkMaterialDuplicate(entry.date, entry.project, mat.description, mat.cost, data.entries);
          if (dup) {
            if (dup.type === 'exact') {
              return { ok: false, action: "duplicate_material", dupType: "exact",
                message: `Already logged: "${dup.existing.description}" $${dup.existing.cost} on ${dup.existing.date} for ${entry.project}. Skipping duplicate — tell Walt this looks like it's already recorded.` };
            } else {
              return { ok: false, action: "duplicate_material", dupType: "fuzzy",
                message: `Possible duplicate detected: "${dup.existing.description}" $${dup.existing.cost} was already logged on ${dup.existing.date} for ${entry.project}. Ask Walt: "⚠️ That looks like it might already be logged from ${dup.existing.date}. Save it anyway or skip?"` };
            }
          }
        }
      }
      // Dedup: skip if identical entry saved in last 30 seconds
      if (isDuplicateEntry(entry)) {
        return { ok: true, action: "duplicate_skipped", type: "entry", data: entry };
      }
      const idx = data.entries.findIndex(e => e.date === entry.date && e.project === entry.project);
      if (idx >= 0) {
        data.entries[idx] = entry;
        return { ok: true, action: "updated", type: "entry", data: entry };
      }
      data.entries.push(entry);
      return { ok: true, action: "created", type: "entry", data: entry };
    }
    case "save_client": {
      if (!data.clients) data.clients = [];
      const idx = data.clients.findIndex(c => c.name.toLowerCase() === input.name.toLowerCase());
      if (idx >= 0) {
        data.clients[idx] = { ...data.clients[idx], ...input };
        return { ok: true, action: "updated", type: "client", data: input };
      }
      data.clients.push(input);
      return { ok: true, action: "created", type: "client", data: input };
    }
    case "save_project": {
      if (!data.projects) data.projects = [];
      const idx = data.projects.findIndex(p => p.name.toLowerCase() === input.name.toLowerCase());
      if (idx >= 0) {
        data.projects[idx] = { ...data.projects[idx], ...input };
        return { ok: true, action: "updated", type: "project", data: input };
      }
      data.projects.push(input);
      return { ok: true, action: "created", type: "project", data: input };
    }
    case "save_crew_member": {
      if (!data.crew) data.crew = [];
      const idx = data.crew.findIndex(c => c.name.toLowerCase() === input.name.toLowerCase());
      if (idx >= 0) {
        data.crew[idx] = { ...data.crew[idx], ...input };
        return { ok: true, action: "updated", type: "crew_member", data: input };
      }
      data.crew.push(input);
      return { ok: true, action: "created", type: "crew_member", data: input };
    }
    case "save_unit_price": {
      if (!data.unitPrices) data.unitPrices = [];
      const idx = data.unitPrices.findIndex(u => u.description.toLowerCase() === input.description.toLowerCase());
      if (idx >= 0) {
        data.unitPrices[idx] = { ...data.unitPrices[idx], ...input };
        return { ok: true, action: "updated", type: "unit_price", data: input };
      }
      data.unitPrices.push(input);
      return { ok: true, action: "created", type: "unit_price", data: input };
    }
    case "save_note": {
      if (!data.generalNotes) data.generalNotes = [];
      data.generalNotes.push({ date: input.date, tag: input.tag || "General", note: input.note });
      return { ok: true, action: "created", type: "note", data: input };
    }
    case "save_general_expense": {
      if (!data.generalExpenses) data.generalExpenses = [];
      // Exact duplicate check
      if (!input.force) {
        const descLower = (input.description || '').toLowerCase().trim();
        const amt = parseFloat(input.amount || 0);
        const dup = data.generalExpenses.find(e =>
          e.date === input.date &&
          (e.description || '').toLowerCase().trim() === descLower &&
          Math.abs(parseFloat(e.amount || 0) - amt) < 0.01
        );
        if (dup) {
          return { ok: false, action: "duplicate_material", dupType: "exact",
            message: `Already logged in general expenses: "${dup.description}" $${dup.amount} on ${dup.date}. Skipping duplicate — tell Walt this is already recorded.` };
        }
      }
      const expense = {
        date: input.date,
        store: input.store || '',
        description: input.description,
        amount: String(parseFloat(input.amount || 0).toFixed(2)),
        category: input.category || 'Other',
        ...(input.receiptNumber ? { receiptNumber: input.receiptNumber } : {}),
        ...(input.notes ? { notes: input.notes } : {})
      };
      data.generalExpenses.push(expense);
      return { ok: true, action: "created", type: "general_expense", data: expense };
    }
    case "send_email": {
      try {
        const isOwnerReview = input.owner_review === true;
      const reviewEmail = process.env.OWNER_REVIEW_EMAIL;
      const routedEmail = (isOwnerReview && reviewEmail) ? reviewEmail : input.to_email;
      const toField = (isOwnerReview && reviewEmail)
        ? `Walt (owner review) <${reviewEmail}>`
        : (input.to_name ? `${input.to_name} <${input.to_email}>` : input.to_email);
        const clientFirstName = input.client_name || (input.to_name ? input.to_name.split(' ')[0] : 'there');
        const bodyHtml = emailWrapper(`
          <div style="padding:30px;font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.6;">
            <p>Hi ${clientFirstName},</p>
            <p>${input.email_body || 'Please find your document attached. Don\'t hesitate to reach out with any questions.'}</p>
            <p>Thank you,<br>
            <strong>Walt Mullins</strong><br>
            Mullins Construction Inc.<br>
            License #855578<br>
            408-569-3434</p>
          </div>
        `);
        let docHtml = input.html_body;
if (input.include_photos === true) {
  try {
    const pcol = await filesCol();
    const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ors = [];
    if (input.project) ors.push({ project: input.project });
    if (input.client_name) ors.push({ client: new RegExp(esc(input.client_name), 'i') });
    if (ors.length) {
      const photoRecords = await pcol.find({
        mimeType: { $regex: '^image/' },
        data: { $ne: null },
        $or: ors
      }).sort({ uploadedAt: 1 }).limit(12).toArray();
      const photoTitle = input.photo_report === true ? "PROJECT PHOTOS" : "REFERENCE PHOTOS";
        docHtml += buildPhotoSection(photoRecords, photoTitle);
    }
  } catch (e) { console.error('photo section:', e.message); }
}
const pdfBuffer = await generatePDF(DocEngine.docShell(input.subject || 'Mullins Construction Document', docHtml));
        await emailTransporter.sendMail({
          from: `"Mullins Construction Inc." <${process.env.YAHOO_EMAIL}>`,
          to: toField,
          subject: input.subject,
          html: bodyHtml,
          text: input.email_body || 'Please find your document attached.',
          attachments: [{
            filename: input.pdf_filename || 'Mullins-Construction-Document.pdf',
            content: pdfBuffer,
            contentType: 'application/pdf'
          }]
        });
        return { success: true, message: `Email sent to ${routedEmail} with PDF attachment: ${input.pdf_filename || 'document.pdf'}`, savedDoc: await (async () => {
          try {
            if (isOwnerReview) return false;
            await saveJobDocument({
          project: input.project || null,
          lead: input.lead || null,
          name: input.pdf_filename || input.subject || "Document",
          docType: input.doc_type || (/(invoice)/i.test(input.subject || "") ? "invoice" : /(proposal)/i.test(input.subject || "") ? "proposal" : "other"),
          data: pdfBuffer.toString('base64'),
          mimeType: 'application/pdf',
          source: "sent-email"
        });
            return true;
          } catch (e) { console.error("saveJobDocument (send_email):", e.message); return false; }
        })() };
      } catch (e) {
        console.error('Email send error:', e.message);
        return { success: false, error: e.message };
      }
    }
    case "send_proposal_link": {
      try {
        const token = makeProposalToken();
        const isOwnerReview = input.owner_review === true;
      const reviewEmail = process.env.OWNER_REVIEW_EMAIL;
      const routedEmail = (isOwnerReview && reviewEmail) ? reviewEmail : input.to_email;
        const record = {
          id: token,
          project: input.project,
          clientName: input.to_name || input.client_name || "",
          lead: input.lead || undefined,
          clientEmail: routedEmail,
          subject: input.subject,
        docKind: input.doc_kind || "proposal",
        htmlBody: DocEngine.docShell(input.subject || `${(input.doc_kind || 'proposal').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())} — Mullins Construction`, input.html_body),
          status: "sent",
          sentDate: new Date().toISOString(),
          viewedDates: [],
          acceptedBy: null,
          acceptedEmail: null,
          acceptedIP: null,
          acceptedAt: null,
          acceptedSnapshot: null,
          reviewOnly: isOwnerReview ? true : undefined
        };
        if (!data.proposals) data.proposals = [];
        data.proposals.push(record);
        if (input.lead) logLeadActivity(data, input.lead, 'proposal_sent', ((input.doc_kind || 'proposal').replace('_',' ').replace(/\b\w/g, c => c.toUpperCase())) + ' sent' + (isOwnerReview ? ' (owner review)' : ''));

        const link = `${PUBLIC_BASE_URL}/proposal/${token}`;
        const firstName = input.client_name || (input.to_name ? input.to_name.split(" ")[0] : "there");
        const bodyHtml = emailWrapper(`
          <div style="padding:30px;font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.6;">
            <p>Hi ${firstName},</p>
            <p>${input.email_body || "Mullins Construction has prepared your proposal. Please review it and let us know if you have any questions."}</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td style="background:#1a5fa8;border-radius:6px">
              <a href="${link}" style="display:inline-block;padding:14px 28px;color:#fff;text-decoration:none;font-weight:bold;font-size:15px">Review Proposal</a>
            </td></tr></table>
            <p style="font-size:13px;color:#888">If the button doesn't work, copy and paste this link into your browser:<br>${link}</p>
            <p>Thank you,<br>
            <strong>Walt Mullins</strong><br>
            Mullins Construction Inc.<br>
            License #855578<br>
            408-569-3434</p>
          </div>
        `);
        const toField = (isOwnerReview && reviewEmail)
        ? `Walt (owner review) <${reviewEmail}>`
        : (input.to_name ? `${input.to_name} <${input.to_email}>` : input.to_email);
        await emailTransporter.sendMail({
          from: `"Mullins Construction Inc." <${process.env.YAHOO_EMAIL}>`,
          to: toField,
          subject: input.subject,
          html: bodyHtml,
          text: `${input.email_body || "Please review your proposal."}\n\nReview it here: ${link}`
        });
        return { ok: true, action: "created", type: "proposal", data: record,
          message: `Link sent to ${routedEmail}.${input.lead ? ` Filed to the ${input.lead} lead card.` : input.project ? ` Track viewed/accepted status on the ${input.project} job panel.` : ''}` };
      } catch (e) {
        console.error("send_proposal_link error:", e.message);
        return { ok: false, error: e.message };
      }
    }
    case "file_document": {
      try {
        if (!ctx.uploadedFile) return { ok: false, error: "No file was attached to this message. Ask Walt to upload the file again in the same message as the request to save it." };
        const saved = await saveJobDocument({
          project: input.project,
          name: input.name || ctx.uploadedFile.name || "Uploaded file",
          docType: input.doc_type || "file",
          mimeType: ctx.uploadedFile.mimeType,
          data: ctx.uploadedFile.data,
          source: "chat-upload"
        });
        return { ok: true, action: "created", type: "document", message: `Saved "${saved.name}" to ${input.project}'s job documents.` };
      } catch (e) {
        console.error("file_document error:", e.message);
        return { ok: false, error: e.message };
      }
    }
   case "vault_lookup": {
      try {
        const col = await vaultCol();
        const q = String(input.query || "").trim();
        if (!q) return { ok: false, readOnly: true, error: "No search term given." };
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const filter = {
          $or: [
            { title: rx },
            { category: rx },
            { notes: rx },
            { "fields.label": rx },
            { "fields.value": rx }
          ]
        };
        if (input.category) filter.category = new RegExp(String(input.category).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const hits = await col.find(filter).limit(5).toArray();
        if (!hits.length) return { ok: true, readOnly: true, found: 0, message: `Nothing in the Vault matches "${q}".` };
        return {
          ok: true,
          readOnly: true,
          found: hits.length,
          entries: hits.map(v => ({
            category: v.category || "",
            title: v.title || "",
            fields: (v.fields || []).map(f => ({ label: f.label, value: f.value })),
            notes: v.notes || "",
            renewalDate: v.renewalDate || ""
          }))
        };
      } catch (e) {
        return { ok: false, readOnly: true, error: e.message };
      }
    } 
    case "vault_save": {
      try {
        const col = await vaultCol();
        const title = String(input.title || "").trim();
        if (!title) return { ok: false, error: "Title is required." };
        const incoming = (input.fields || []).filter(f => f && f.label && f.value);
        if (!incoming.length) return { ok: false, error: "No fields to save." };
        const pw = /password|passcode|passwd/i;
        const bad = incoming.find(f => pw.test(f.label));
        if (bad) return { ok: false, error: "Passwords don't go in the Vault. Tell Walt to keep it in a password manager — the Vault is for account numbers, PINs, and reference info." };
        const existing = await col.findOne({ title: new RegExp("^" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") });
        if (existing) {
          const merged = [...(existing.fields || [])];
          for (const f of incoming) {
            const i = merged.findIndex(m => (m.label || "").toLowerCase() === f.label.toLowerCase());
            if (i >= 0) merged[i] = { label: f.label, value: f.value };
            else merged.push({ label: f.label, value: f.value });
          }
          await col.updateOne({ _id: existing._id }, { $set: {
            fields: merged,
            category: input.category || existing.category || "",
            notes: input.notes || existing.notes || "",
            renewalDate: input.renewal_date || existing.renewalDate || "",
            updatedAt: new Date().toISOString()
          }});
          return { ok: true, readOnly: true, action: "updated", title: existing.title, fields: merged.length };
        }
        await col.insertOne({
          category: input.category || "",
          title: title,
          fields: incoming,
          notes: input.notes || "",
          renewalDate: input.renewal_date || "",
          updatedAt: new Date().toISOString()
        });
        return { ok: true, readOnly: true, action: "created", title: title, fields: incoming.length };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    default:
      return { ok: false, error: "Unknown tool: " + toolName };
  }
}

// ── Email route ── (v2: optionally files the sent doc to Job Docs when project is provided)
app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, html, text, attachPdf, pdfFilename, clientName, emailBody, project, docType, rawPdfHtml } = req.body;
    if (!to || !subject || !html) return res.status(400).json({ error: 'Missing required fields' });
    const firstName = clientName || 'there';
    const bodyHtml = emailWrapper(`
      <div style="padding:30px;font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.6;">
        <p>Hi ${firstName},</p>
        <p>${emailBody || 'Please find your document attached.'}</p>
        <p>Thank you,<br>
        <strong>Walt Mullins</strong><br>
        Mullins Construction Inc.<br>
        License #855578<br>
        408-569-3434</p>
      </div>
    `);
    const mailOptions = {
      from: `"Mullins Construction Inc." <${process.env.YAHOO_EMAIL}>`,
      to, subject,
      html: bodyHtml,
      text: text || emailBody || 'Please find your document attached.',
      attachments: []
    };
    if (attachPdf !== false) {
      // rawPdfHtml = complete standalone document (panel invoices/statements) — render as-is.
      // html without rawPdfHtml = fragment — wrap it (voice/legacy behavior).
      const pdfSource = rawPdfHtml ? rawPdfHtml : emailWrapper(html);
      const pdfBuffer = await generatePDF(pdfSource);
      mailOptions.attachments.push({
        filename: pdfFilename || 'Mullins-Construction-Document.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf'
      });
    }
    await emailTransporter.sendMail(mailOptions);
    // file to Job Docs when a project is specified (mirrors the send_email tool's behavior)
    let filed = false;
    if (project) {
      try {
        await saveJobDocument({
          project: project,
          name: pdfFilename || subject || 'Document',
          docType: docType || (/(invoice)/i.test(subject || '') ? 'invoice' : /(statement)/i.test(subject || '') ? 'statement' : /(proposal)/i.test(subject || '') ? 'proposal' : 'other'),
          html: rawPdfHtml || html,
          source: 'sent-email'
        });
        filed = true;
      } catch (e) { console.error('saveJobDocument (/api/send-email):', e.message); }
    }
    res.json({ success: true, sentTo: to, filed: filed });
  } catch (e) {
    console.error('Email error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── E-signature proposal page ──
function buildProposalPage(record, opts) {
  const { alreadyAccepted } = opts;
  const docLabel = (record.docKind || 'proposal').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  const docLabelLower = docLabel.toLowerCase();
  const acceptedAtDisplay = record.acceptedAt
    ? new Date(record.acceptedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : "";
  const actionBlock = alreadyAccepted
    ? `<div style="margin-top:32px;padding:20px 24px;background:#eafbea;border:1px solid #b6e6b6;border-radius:8px;font-family:Arial,sans-serif;">
        <div style="font-size:16px;font-weight:bold;color:#1a7a1a;margin-bottom:6px;">✓ Signed</div>
        <div style="font-size:14px;color:#333;">Accepted by <strong>${(record.acceptedBy || record.acceptedEmail || "").replace(/</g,"&lt;")}</strong> on ${acceptedAtDisplay}.</div>
        <div style="font-size:12px;color:#888;margin-top:8px;">This ${docLabelLower} has been signed and is locked. Contact Mullins Construction with any questions.</div>
      </div>`
    : `<div id="accept-block" style="margin-top:32px;padding:24px;background:#f7f9fc;border:1px solid #dbe3ee;border-radius:8px;font-family:Arial,sans-serif;">
        <div style="font-size:16px;font-weight:bold;color:#222;margin-bottom:14px;">${docLabel} Acceptance</div>
        <label style="display:block;font-size:14px;color:#333;margin-bottom:10px;"><input type="checkbox" class="accept-chk" style="margin-right:8px;">I have reviewed this ${docLabelLower}.</label>
        <label style="display:block;font-size:14px;color:#333;margin-bottom:10px;"><input type="checkbox" class="accept-chk" style="margin-right:8px;">I approve the scope of work and pricing shown above.</label>
        <label style="display:block;font-size:14px;color:#333;margin-bottom:16px;"><input type="checkbox" class="accept-chk" style="margin-right:8px;">I authorize Mullins Construction Inc. to proceed with the work described above.</label>
        <div style="margin-bottom:10px;">
          <div style="font-size:12px;color:#666;margin-bottom:4px;">Your Name</div>
          <input id="accept-name" type="text" placeholder="Full name" style="width:100%;max-width:320px;padding:9px 10px;border:1px solid #ccc;border-radius:5px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:#666;margin-bottom:4px;">Your Email</div>
          <input id="accept-email" type="email" placeholder="you@example.com" style="width:100%;max-width:320px;padding:9px 10px;border:1px solid #ccc;border-radius:5px;font-size:14px;box-sizing:border-box;">
        </div>
        <button id="accept-btn" onclick="submitAcceptance()" style="background:#1a5fa8;color:#fff;border:none;border-radius:6px;padding:13px 26px;font-size:15px;font-weight:bold;cursor:pointer;">Accept ${docLabel}</button>
        <div id="accept-error" style="color:#c0392b;font-size:13px;margin-top:10px;display:none;"></div>
      </div>
      <script>
        async function submitAcceptance(){
          const boxes = document.querySelectorAll('.accept-chk');
          for (const b of boxes) if (!b.checked) { showErr('Please check all three boxes before accepting.'); return; }
          const name = document.getElementById('accept-name').value.trim();
          const email = document.getElementById('accept-email').value.trim();
          if (!name) { showErr('Please enter your name.'); return; }
          if (!email) { showErr('Please enter your email.'); return; }
          const btn = document.getElementById('accept-btn');
          btn.disabled = true; btn.textContent = 'Submitting…';
          try {
            const resp = await fetch('/api/proposal/${record.id}/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, email })
            });
            const j = await resp.json();
            if (!resp.ok || !j.ok) throw new Error(j.error || 'Something went wrong.');
            window.location.reload();
          } catch (e) {
            showErr(e.message || 'Something went wrong — please try again.');
            btn.disabled = false; btn.textContent = 'Accept ${docLabel}';
          }
        }
        function showErr(msg){
          const el = document.getElementById('accept-error');
          el.textContent = msg; el.style.display = 'block';
        }
      </script>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Proposal — Mullins Construction Inc.</title>
<style>
  body{font-family:Arial,sans-serif;background:#eef1f5;margin:0;padding:24px 12px;}
  .wrap{max-width:820px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:8px 8px 32px;}
  .topbar{padding:16px 24px;border-bottom:1px solid #eee;font-size:13px;color:#888;}
  @media (max-width: 640px) {
    body{padding:0;}
    .wrap{border-radius:0;}
    .wrap{word-break:normal;overflow-wrap:normal;}
    .wrap div[style]{padding:12px !important;}
    .wrap div[style*="display:flex"]{flex-wrap:wrap !important;}
    .wrap div[style*="text-align:right"]{text-align:left !important;margin-top:10px;width:100% !important;}
    .wrap div[style*="font-size:22px"], .wrap div[style*="font-size:26px"]{font-size:18px !important;}
    .wrap table{width:100% !important;font-size:12px !important;}
    .wrap th, .wrap td{padding:6px 4px !important;word-break:break-word;overflow-wrap:break-word;}
    .wrap h1{font-size:19px !important;}
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">Mullins Construction Inc. &middot; License #855578</div>
    <div style="padding:24px;">
      ${record.htmlBody.replace('onclick="window.print()"', `onclick="window.open('/proposal/${record.id}/pdf','_blank')"`)}
      ${actionBlock}
    </div>
  </div>
</body>
</html>`;
}

async function notifyWaltProposalAccepted(record) {
  try {
    const acceptedAtDisplay = new Date(record.acceptedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    const link = `${PUBLIC_BASE_URL}/proposal/${record.id}`;
    await emailTransporter.sendMail({
      from: `"The Super" <${process.env.YAHOO_EMAIL}>`,
      to: process.env.YAHOO_EMAIL,
      subject: `✅ Proposal Accepted — ${record.project}`,
      html: emailWrapper(`
        <div style="padding:30px;font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.6;">
          <p style="font-size:17px;font-weight:bold;color:#1a7a1a;">✅ ${record.project} — proposal accepted</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;font-size:14px;">
            <tr><td style="padding:3px 12px 3px 0;color:#888;">Signed by</td><td><strong>${record.acceptedBy}</strong> (${record.acceptedEmail})</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#888;">Date</td><td>${acceptedAtDisplay}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#888;">IP address</td><td>${record.acceptedIP}</td></tr>
          </table>
          <p>Job can be scheduled. The signed copy is locked and viewable anytime at the link below.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0"><tr><td style="background:#1a5fa8;border-radius:6px">
            <a href="${link}" style="display:inline-block;padding:12px 24px;color:#fff;text-decoration:none;font-weight:bold;font-size:14px">View Signed Proposal</a>
          </td></tr></table>
          <p style="font-size:12px;color:#888">${link}</p>
        </div>
      `),
      text: `${record.project} proposal accepted by ${record.acceptedBy} (${record.acceptedEmail}) on ${acceptedAtDisplay}. IP: ${record.acceptedIP}\n\nView signed proposal: ${link}`
    });
  } catch (e) {
    console.error("notifyWaltProposalAccepted error:", e.message);
  }
}

app.get("/proposal/:token", async (req, res) => {
  try {
    const data = await loadData();
    const record = (data.proposals || []).find(p => p.id === req.params.token);
    if (!record) return res.status(404).send("<h2 style='font-family:Arial'>Proposal not found.</h2>");
    if (record.status !== "accepted") {
      record.viewedDates = record.viewedDates || [];
      record.viewedDates.push(new Date().toISOString());
      await saveData(data);
    }
    res.send(buildProposalPage(record, { alreadyAccepted: record.status === "accepted" }));
  } catch (err) {
    console.error("proposal view error:", err);
    res.status(500).send("<h2 style='font-family:Arial'>Something went wrong loading this proposal.</h2>");
  }
});

app.post("/api/proposal/:token/accept", async (req, res) => {
  try {
    const data = await loadData();
    const record = (data.proposals || []).find(p => p.id === req.params.token);
    if (!record) return res.status(404).json({ ok: false, error: "Proposal not found." });
    if (record.status === "accepted") return res.json({ ok: true, alreadyAccepted: true });
    const { name, email } = req.body || {};
    if (!name || !email) return res.status(400).json({ ok: false, error: "Name and email are required." });
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
    record.status = "accepted";
    record.acceptedBy = name;
    record.acceptedEmail = email;
    record.acceptedIP = ip;
    record.acceptedAt = new Date().toISOString();
    record.acceptedSnapshot = record.htmlBody;
    await saveData(data);
    notifyWaltProposalAccepted(record);
    // File the signed PDF to Job Docs
      try {
        const label = (record.docKind || 'proposal').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
        const signedBanner = '<div style="margin-top:24px;padding:14px 18px;background:#e8f5e9;border:1px solid #4caf50;border-radius:8px;font-family:Arial,sans-serif;font-size:13px;color:#1b5e20;"><b>\u2713 Signed</b> \u2014 Accepted by ' + String(record.acceptedBy).replace(/</g,'&lt;') + ' (' + String(record.acceptedEmail).replace(/</g,'&lt;') + ') on ' + new Date(record.acceptedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + '. This document has been signed and is locked.</div>';
        const signedHtml = record.htmlBody.replace('</body>', signedBanner + '</body>');
        const signedPdf = await generatePDF(signedHtml);
        const _rawProj = (record.project || '').trim();
        const _matchedProj = _rawProj ? fuzzyMatchProject(_rawProj, data.projects || []) : null;
        const _fileProject = _matchedProj && (data.projects || []).some(p => (p.name || '').toLowerCase() === _matchedProj.toLowerCase()) ? _matchedProj : null;
        const savedSigned = await saveJobDocument({
          project: _fileProject,
          lead: record.lead || null,
          name: 'SIGNED - ' + (record.subject || label),
          docType: record.docKind || 'proposal',
          data: signedPdf.toString('base64'),
          mimeType: 'application/pdf',
          source: 'signed-acceptance'
        });record.signedDocId = savedSigned.id;
        if (record.lead) logLeadActivity(data, record.lead, 'accepted', ((record.docKind || 'proposal').replace('_',' ').replace(/\b\w/g, c => c.toUpperCase())) + ' accepted by ' + (record.acceptedBy || 'client'));
        await saveData(data);
      } catch (e) { console.error('signed-pdf filing:', e.message); }
    res.json({ ok: true });
  } catch (err) {
    console.error("proposal accept error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});app.get("/proposal/:token/pdf", async (req, res) => {
  try {
    const data = await loadData();
    const record = (data.proposals || []).find(p => p.id === req.params.token);
    if (!record) return res.status(404).send("<h2 style='font-family:Arial'>Proposal not found.</h2>");
    if (record.signedDocId) {
      const col = await filesCol();
      const doc = await col.findOne({ _id: new ObjectId(record.signedDocId) });
      if (doc && doc.data) {
        const buf = Buffer.from(doc.data, "base64");
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${(doc.name || "proposal").replace(/[^a-zA-Z0-9._ -]/g, "")}.pdf"`);
        return res.send(buf);
      }
    }
    const pdfBuffer = await generatePDF(record.htmlBody);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Proposal-${(record.project || "document").replace(/[^a-zA-Z0-9._ -]/g, "")}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("proposal pdf error:", err);
    res.status(500).send("<h2 style='font-family:Arial'>Error generating PDF.</h2>");
  }
});

// ── Routes ──
app.post("/api/chat", async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  try {
    const { message, history, imageData, imageType, documentData, documentName } = req.body;
    let data = await loadData();
    const uploadedFile = documentData
      ? { data: documentData, mimeType: "application/pdf", name: documentName || "Uploaded PDF" }
      : (imageData ? { data: imageData, mimeType: imageType || "image/jpeg", name: "Uploaded image" } : null);
    const chatModel = data.chatModel === "claude-sonnet-4-6" ? "claude-sonnet-4-6" : "claude-opus-4-8";
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const messages = [];
    if (history && history.length > 0) messages.push(...history.slice(-20));

    let userContent;
    const contentBlocks = [];
    if (imageData && imageType) {
      contentBlocks.push({ type: "image", source: { type: "base64", media_type: imageType, data: imageData } });
    }
    if (documentData) {
      contentBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: documentData } });
    }
    if (contentBlocks.length) {
      const label = documentName ? `[Attached PDF: ${documentName}] ` : "";
      contentBlocks.push({ type: "text", text: label + (message || "Please analyze this file.") });
      userContent = contentBlocks;
    } else {
      userContent = message;
    }
    messages.push({ role: "user", content: userContent });

    let response = await anthropic.messages.create({
      model: chatModel,
      max_tokens: 4096,
      system: buildSystemPrompt(data, data.theme?.invoiceAccentColor || '#e8a020'),
      tools: TOOLS_CACHED,
      messages,
    });

    let dataSaved = false;

    // Tool use loop
    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResultContents = [];

      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(toolUse.name, toolUse.input, data, { uploadedFile });
        if (result.ok && !result.readOnly) dataSaved = true;
        toolResultContents.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      }

      if (dataSaved) await saveData(data);

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResultContents });

      response = await anthropic.messages.create({
        model: chatModel,
        max_tokens: 4096,
        system: buildSystemPrompt(data, data.theme?.invoiceAccentColor || '#e8a020'),
        tools: TOOLS_CACHED,
        messages,
      });
    }

    const reply = response.content.find(b => b.type === "text")?.text || "";

    // Auto-increment invoice number when a doc is generated
    if (
      /<div[^>]*MULLINS CONSTRUCTION/i.test(reply) ||
      (/MULLINS CONSTRUCTION INC/i.test(reply) && /<table/i.test(reply))
    ) {
      data.nextInvoiceNumber = (data.nextInvoiceNumber || 1001) + 1;
      await saveData(data);
      dataSaved = true;
    }

    res.json({ reply, dataSaved });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Text reminders (Twilio) ──
async function sendText(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !tok || !from) return { ok: false, error: "Twilio not configured — add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER in Render env vars" };
  try {
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(sid + ":" + tok).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const j = await resp.json();
    if (!resp.ok) return { ok: false, error: j.message || resp.statusText };
    return { ok: true, sid: j.sid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const REMINDER_DEFAULTS = {
  enabled: false, phone: "",
  apptAlerts: true, apptLeadMin: 30,
  digest: false, digestTime: "06:30",
  nudge: false, nudgeTime: "18:00"
};

async function reminderTick() {
  try {
    const data = await loadData();
    const rs = { ...REMINDER_DEFAULTS, ...(data.textReminders || {}) };
    if (!rs.enabled || !rs.phone) return;
    const { isoDate } = getPSTDateTime();
    const pst = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const hhmm = String(pst.getHours()).padStart(2, "0") + ":" + String(pst.getMinutes()).padStart(2, "0");
    const nowMin = pst.getHours() * 60 + pst.getMinutes();
    let changed = false;

    // 1) Appointment alerts — fire once, within lead window (allow up to 5 min late)
    if (rs.apptAlerts) {
      const lead = parseInt(rs.apptLeadMin || 30, 10);
      for (const a of (data.appointments || [])) {
        if (a.status === "cancelled" || a.reminded || a.date !== isoDate || !a.time) continue;
        const [h, m] = a.time.split(":").map(Number);
        const diff = (h * 60 + m) - nowMin;
        if (diff <= lead && diff >= -5) {
          const when = diff > 0 ? `in ${diff} min` : "now";
          const msg = `📍 The Super: ${a.time_display}${a.person ? " with " + a.person : ""}${a.address ? " — " + a.address : ""} (${when})`;
          const r = await sendText(rs.phone, msg);
          if (r.ok) { a.reminded = true; changed = true; }
          else console.error("Appt reminder text failed:", r.error);
        }
      }
    }

    // 2) Morning digest — first tick at/after the chosen time, once per day
    if (rs.digest && rs.digestTime && hhmm >= rs.digestTime && data._lastDigestDate !== isoDate) {
      const todays = (data.appointments || [])
        .filter(a => a.date === isoDate && a.status !== "cancelled")
        .sort((x, y) => (x.time || "").localeCompare(y.time || ""));
      const lines = todays.length
        ? todays.map(a => `• ${a.time_display}${a.person ? " — " + a.person : ""}${a.address ? " — " + a.address : ""}`).join("\n")
        : "No appointments today.";
      const r = await sendText(rs.phone, `☀️ The Super — Today:\n${lines}`);
      if (r.ok) { data._lastDigestDate = isoDate; changed = true; }
      else console.error("Digest text failed:", r.error);
    }

    // 3) Evening nudge — only if nothing logged today, once per day
    if (rs.nudge && rs.nudgeTime && hhmm >= rs.nudgeTime && data._lastNudgeDate !== isoDate) {
      const hasEntries = (data.entries || []).some(e => e.date === isoDate);
      if (!hasEntries) {
        const r = await sendText(rs.phone, "🔨 The Super: No hours logged today yet — log the crew before you forget?");
        if (r.ok) { data._lastNudgeDate = isoDate; changed = true; }
        else console.error("Nudge text failed:", r.error);
      } else {
        data._lastNudgeDate = isoDate; changed = true;
      }
    }

    if (changed) await saveData(data);
  } catch (err) {
    console.error("reminderTick error:", err.message);
  }
}
setInterval(reminderTick, 60 * 1000);

// ── Reminder settings API ──
app.get("/api/reminder-settings", async (req, res) => {
  try {
    const data = await loadData();
    res.json({ ...REMINDER_DEFAULTS, ...(data.textReminders || {}), configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/reminder-settings", async (req, res) => {
  try {
    const { enabled, phone, apptAlerts, apptLeadMin, digest, digestTime, nudge, nudgeTime } = req.body;
    const data = await loadData();
    data.textReminders = {
      enabled: !!enabled,
      phone: String(phone || "").trim(),
      apptAlerts: !!apptAlerts,
      apptLeadMin: [15, 30, 60].includes(parseInt(apptLeadMin, 10)) ? parseInt(apptLeadMin, 10) : 30,
      digest: !!digest,
      digestTime: /^\d{2}:\d{2}$/.test(digestTime || "") ? digestTime : "06:30",
      nudge: !!nudge,
      nudgeTime: /^\d{2}:\d{2}$/.test(nudgeTime || "") ? nudgeTime : "18:00"
    };
    await saveData(data);
    res.json({ ok: true, settings: data.textReminders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/test-text", async (req, res) => {
  try {
    const data = await loadData();
    const phone = (req.body && req.body.phone) || (data.textReminders && data.textReminders.phone);
    if (!phone) return res.status(400).json({ error: "No phone number saved yet" });
    const r = await sendText(phone, "✅ The Super: test text — reminders are wired up and working.");
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Materials: batch add (quick-add row + screenshot staging commit) ──
app.post("/api/materials/add-batch", async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "No items" });
    if (items.length > 100) return res.status(400).json({ error: "Too many items (max 100)" });
    const data = await loadData();
    if (!data.entries) data.entries = [];
    if (!data.generalExpenses) data.generalExpenses = [];
    let added = 0;
    for (const it of items) {
      const amount = parseFloat(it.amount || 0);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(it.date || "") ? it.date : getPSTDateTime().isoDate;
      if (!amount && !(it.description || "").trim()) continue;
      if (it.isGeneral || it.project === "__general__") {
        data.generalExpenses.push({
          date,
          category: it.category || "Other",
          store: (it.store || "").trim(),
          description: (it.description || "").trim(),
          amount: String(amount),
          receiptNumber: (it.invoiceNum || "").trim()
        });
        added++;
      } else {
        const projName = (it.project || "").trim();
        if (!projName) continue;
        let entry = data.entries.find(e => e.date === date && (e.project || "") === projName);
        if (!entry) { entry = { date, project: projName, crew: [], materials: [], notes: "" }; data.entries.push(entry); }
        if (!entry.materials) entry.materials = [];
        const matObj = {
          store: (it.store || "").trim(),
          description: (it.description || "").trim(),
          cost: String(amount),
          invoiceNum: (it.invoiceNum || "").trim()
        };
        if (it.kind === "sub") matObj.kind = "sub";
        if (it.markupPct != null && it.markupPct !== "" && !isNaN(parseFloat(it.markupPct))) matObj.markupPct = parseFloat(it.markupPct);
        entry.materials.push(matObj);
        added++;
      }
    }
    await saveData(data);
    res.json({ ok: true, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Materials: parse a receipt / HD Pro purchase-history screenshot with vision ──
app.post("/api/materials/parse-image", async (req, res) => {
  try {
    const { imageData, imageType } = req.body;
    if (!imageData) return res.status(400).json({ error: "No image" });
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: imageType || "image/jpeg", data: imageData } },
          { type: "text", text: `This is a screenshot of purchase history (likely Home Depot Pro) or a receipt for a construction business. Extract EVERY purchase row visible.

Respond with ONLY a JSON array, no markdown fences, no commentary. Each element:
{"date":"YYYY-MM-DD","store":"Home Depot","description":"<store # / location / job name and any transaction context>","amount":123.45,"invoiceNum":"<invoice or receipt number if visible, else empty string>"}

Rules:
- Dates: convert to YYYY-MM-DD. If the year isn't shown, assume the current year (2026).
- amount must be a plain number (no $ or commas).
- Include Txn numbers in the description like "(Txn 1234, Inv 5678)" when visible, matching this style: "#1009 Hillsdale (Txn 4116, Inv 5512305)".
- One object per purchase line. If totals/subtotal rows appear, skip them.
- If you cannot read a field, use an empty string, never guess digits.` }
        ]
      }]
    });
    const text = response.content.map(c => c.type === "text" ? c.text : "").join("");
    const clean = text.replace(/```json|```/g, "").trim();
    let rows;
    try { rows = JSON.parse(clean); } catch (e) {
      return res.status(422).json({ error: "Could not read the screenshot clearly — try a sharper or closer screenshot." });
    }
    if (!Array.isArray(rows)) rows = [rows];
    rows = rows.filter(r => r && (r.amount || r.description)).slice(0, 100).map(r => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || "") ? r.date : "",
      store: String(r.store || "").slice(0, 60),
      description: String(r.description || "").slice(0, 200),
      amount: parseFloat(r.amount || 0) || 0,
      invoiceNum: String(r.invoiceNum || "").slice(0, 40)
    }));
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat model setting (Opus / Sonnet toggle) ──
app.get("/api/model", async (req, res) => {
  try {
    const data = await loadData();
    res.json({ model: data.chatModel || "claude-opus-4-8" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/model", async (req, res) => {
  try {
    const { model } = req.body;
    if (!["claude-opus-4-8", "claude-sonnet-4-6"].includes(model)) {
      return res.status(400).json({ error: "invalid model" });
    }
    const data = await loadData();
    data.chatModel = model;
    await saveData(data);
    res.json({ ok: true, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Appointments API ──
app.get("/api/appointments/today", async (req, res) => {
  try {
    const data = await loadData();
    const { isoDate } = getPSTDateTime();
    const appts = (data.appointments || [])
      .filter(a => a.date === isoDate && a.status !== "cancelled")
      .sort((a, b) => a.time.localeCompare(b.time));
    res.json({ date: isoDate, appointments: appts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/appointments", async (req, res) => {
  try {
    const data = await loadData();
    const appts = (data.appointments || []).filter(a => a.status !== "cancelled");
    res.json({ appointments: appts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/appointments", async (req, res) => {
  try {
    const { date, time, time_display, person, address, notes } = req.body;
    if (!date || !time || !time_display) return res.status(400).json({ error: "date, time, and time_display are required" });
    const data = await loadData();
    if (!data.appointments) data.appointments = [];
    const appt = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      date, time, time_display,
      person: person || "", address: address || "", notes: notes || "",
      status: "upcoming",
      created_at: new Date().toISOString()
    };
    data.appointments.push(appt);
    data.appointments.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    await saveData(data);
    res.json({ ok: true, appointment: appt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/appointments/:id", async (req, res) => {
  try {
    const data = await loadData();
    const idx = (data.appointments || []).findIndex(a => a.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "not found" });
    data.appointments[idx].status = "cancelled";
    await saveData(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Personal Vault API ──
app.get("/api/vault", async (req, res) => {
  try {
    const col = await vaultCol();
    const items = await col.find({}).sort({ category: 1, title: 1 }).toArray();
    res.json(items.map(v => ({
      id: v._id.toString(),
      category: v.category || "",
      title: v.title || "",
      fields: v.fields || [],
      notes: v.notes || "",
      renewalDate: v.renewalDate || "",
      updatedAt: v.updatedAt || ""
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/vault", async (req, res) => {
  try {
    const { id, category, title, fields, notes, renewalDate } = req.body;
    if (!title) return res.status(400).json({ error: "Title is required." });
    const record = {
      category: category || "",
      title: title,
      fields: Array.isArray(fields) ? fields : [],
      notes: notes || "",
      renewalDate: renewalDate || "",
      updatedAt: new Date().toISOString()
    };
    const col = await vaultCol();
    if (id) {
      await col.updateOne({ _id: new ObjectId(id) }, { $set: record });
      res.json({ ok: true, id: id });
    } else {
      const result = await col.insertOne(record);
      res.json({ ok: true, id: result.insertedId.toString() });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete("/api/vault/:id", async (req, res) => {
  try {
    const col = await vaultCol();
    await col.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Job documents API ──
app.get("/api/docs", async (req, res) => {
  try {
    const col = await filesCol();
    let query = {};
    if (req.query.clientAll) {
      const _d = await loadData();
      const _c = String(req.query.clientAll).trim().toLowerCase();
      const _projNames = (_d.projects || []).filter(p => (p.client || '').trim().toLowerCase() === _c).map(p => p.name);
      const _or = { $or: [ { client: req.query.clientAll }, { lead: req.query.clientAll }, { project: { $in: _projNames } }, { project: req.query.clientAll } ] };
      if (req.query.only === 'photos') query = { $and: [ _or, { mimeType: { $regex: '^image/' } } ] };
      else if (req.query.only === 'docs') query = { $and: [ _or, { mimeType: { $not: { $regex: '^image/' } } } ] };
      else query = _or;
    }
    else if (req.query.lead) query = { lead: req.query.lead };
    else if (req.query.crew) query = { crew: req.query.crew };
    else if (req.query.sub) query = { sub: req.query.sub };
    else if (req.query.client) query = { client: req.query.client };
    else if (req.query.project === "__unfiled__") query = { project: null, client: null, lead: null, crew: null, sub: null };
    else if (req.query.project) query = { project: req.query.project };
    const docs = await col.find(query, { projection: { data: 0, html: 0 } }).sort({ uploadedAt: -1 }).limit(200).toArray();
   res.json(docs.map(d => ({ id: d._id.toString(), project: d.project, client: d.client, name: d.name, docType: d.docType, kind: d.kind, mimeType: d.mimeType, size: d.size, uploadedAt: d.uploadedAt, source: d.source, meta: d.meta || {}, title: (d.meta && d.meta.title) || '', sig: !!d.sig, token: d.token || null }))); 
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/docs/:id/view", async (req, res) => {
  try {
    const col = await filesCol();
    const doc = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).send("<h2 style='font-family:Arial'>Document not found.</h2>");
    if (doc.kind === "generated" && doc.html) {
      res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${(doc.name || "Document").replace(/</g, "&lt;")}</title><style>body{font-family:Arial,sans-serif;background:#eef1f5;margin:0;padding:24px 12px}.wrap{max-width:820px;margin:0 auto;background:#fff;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:24px}</style></head><body><div class="wrap">${doc.html}</div></body></html>`);
    } else if (doc.data) {
      const buf = Buffer.from(doc.data, "base64");
      res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${(doc.name || "document").replace(/[^a-zA-Z0-9._ -]/g, "")}"`);
      res.send(buf);
    } else {
      res.status(404).send("<h2 style='font-family:Arial'>Document has no content.</h2>");
    }
  } catch (err) {
    res.status(500).send("<h2 style='font-family:Arial'>Error loading document.</h2>");
  }
});

app.post("/api/docs", async (req, res) => {
  try {
  const { project, client, lead, crew, sub, name, mimeType, data, docType } = req.body;
    if (!data) return res.status(400).json({ error: "No file data." });
    if (data.length > 13000000) return res.status(400).json({ error: "File too large — keep uploads under ~9 MB." });
    const saved = await saveJobDocument({ project, client, lead, crew, sub, name, docType: docType || "file", mimeType, data, source: "docs-modal" });
    if (lead) { try { const _d = await loadData(); logLeadActivity(_d, lead, 'uploaded', 'File uploaded: ' + (name || 'document')); await saveData(_d); } catch (e) { console.error('lead upload log:', e.message); } }
    res.json({ ok: true, ...saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

 app.post("/api/docs/associate-lead", async (req, res) => {
  try {
    const { lead, project } = req.body;
    if (!lead || !project) return res.status(400).json({ error: "lead and project required." });
    const col = await filesCol();
    const r = await col.updateMany({ lead: lead }, { $set: { project: project } });
    res.json({ ok: true, updated: r.modifiedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/docs/meta", async (req, res) => {
  try {
    const { id, meta } = req.body;
    if (!id || !meta || typeof meta !== "object") return res.status(400).json({ error: "id and meta required." });
    const set = {};
    for (const k of Object.keys(meta)) set["meta." + k] = meta[k];
    const col = await filesCol();
    await col.updateOne({ _id: new ObjectId(id) }, { $set: set });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/docs/:id", async (req, res) => {
  try {
    const col = await filesCol();
    await col.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/data", async (req, res) => {
  try {
    res.json(await loadData());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/data", async (req, res) => {
  try {
    await saveData(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/materials", async (req, res) => {
  try {
    const db = await connectDB();
    const doc = await db.collection('data').findOne({ _id: 'main' });
    const { from, to, project } = req.query;
    let materials = [];
    // Materials from daily entries
    if (project !== '__general__') {
      for (const entry of (doc?.entries || [])) {
        if (from && (entry.date || '') < from) continue;
        if (to && (entry.date || '') > to) continue;
        if (project && project !== entry.project) continue;
        for (let mi = 0; mi < (entry.materials || []).length; mi++) {
          const mat = entry.materials[mi];
          if (!mat.description && !mat.cost) continue;
          materials.push({
            date: entry.date || '',
            project: entry.project || '',
            store: mat.store || '',
            description: mat.description || '',
            amount: parseFloat(mat.cost || 0),
            invoiceNum: mat.invoiceNum || '',
            kind: mat.kind === 'sub' ? 'sub' : 'material',
            markupPct: (mat.markupPct != null && !isNaN(parseFloat(mat.markupPct))) ? parseFloat(mat.markupPct) : null,
            matIndex: mi,
            entryDate: entry.date || '',
            entryProject: entry.project || '',
            isGeneral: false
          });
        }
      }
    }
    // General expenses
    if (!project || project === '__general__') {
      for (let ei = 0; ei < (doc?.generalExpenses || []).length; ei++) {
        const exp = doc.generalExpenses[ei];
        if (from && (exp.date || '') < from) continue;
        if (to && (exp.date || '') > to) continue;
        materials.push({
          date: exp.date || '',
          project: '__general__',
          projectLabel: exp.category || 'General',
          category: exp.category || 'Other',
          store: exp.store || '',
          description: exp.description || '',
          amount: parseFloat(exp.amount || 0),
          invoiceNum: exp.receiptNumber || '',
          expIndex: ei,
          isGeneral: true
        });
      }
    }
    materials.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ materials, projects: (doc?.projects || []).map(p => p.name).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/material-edit", async (req, res) => {
  try {
    const db = await connectDB();
    const { isGeneral, expIndex, entryDate, entryProject, matIndex, updated } = req.body;
    const doc = await db.collection('data').findOne({ _id: 'main' });
    if (isGeneral) {
      const expenses = [...(doc?.generalExpenses || [])];
      if (expIndex < 0 || expIndex >= expenses.length) return res.status(404).json({ error: 'Not found' });
      expenses[expIndex] = { ...expenses[expIndex], date: updated.date || expenses[expIndex].date, category: updated.category || expenses[expIndex].category, store: updated.store ?? expenses[expIndex].store, description: updated.description ?? expenses[expIndex].description, amount: updated.amount != null ? String(updated.amount) : expenses[expIndex].amount, receiptNumber: updated.invoiceNum ?? expenses[expIndex].receiptNumber };
      await db.collection('data').updateOne({ _id: 'main' }, { $set: { generalExpenses: expenses } });
    } else {
      const entries = [...(doc?.entries || [])];
      const entryIdx = entries.findIndex(e => e.date === entryDate && e.project === entryProject);
      if (entryIdx === -1) return res.status(404).json({ error: 'Entry not found' });
      const mats = [...(entries[entryIdx].materials || [])];
      if (matIndex < 0 || matIndex >= mats.length) return res.status(404).json({ error: 'Material not found' });
      const newDate = updated.date || entryDate;
      const newProject = updated.project || entryProject;
      if (newDate !== entryDate || newProject !== entryProject) {
        mats.splice(matIndex, 1);
        entries[entryIdx].materials = mats;
        let targetIdx = entries.findIndex(e => e.date === newDate && e.project === newProject);
        if (targetIdx === -1) { entries.push({ date: newDate, project: newProject, materials: [] }); targetIdx = entries.length - 1; }
        if (!entries[targetIdx].materials) entries[targetIdx].materials = [];
        entries[targetIdx].materials.push({ store: updated.store || '', description: updated.description || '', cost: String(updated.amount || 0), invoiceNum: updated.invoiceNum || '', ...(updated.kind === 'sub' ? { kind: 'sub' } : {}), ...(updated.markupPct != null ? { markupPct: parseFloat(updated.markupPct) } : {}) });
      } else {
        mats[matIndex] = { ...mats[matIndex], store: updated.store ?? mats[matIndex].store, description: updated.description ?? mats[matIndex].description, cost: updated.amount != null ? String(updated.amount) : mats[matIndex].cost, invoiceNum: updated.invoiceNum ?? mats[matIndex].invoiceNum, ...(updated.kind !== undefined ? (updated.kind === 'sub' ? { kind: 'sub' } : { kind: undefined }) : {}), ...(updated.markupPct !== undefined ? { markupPct: updated.markupPct == null ? undefined : parseFloat(updated.markupPct) } : {}) };
        entries[entryIdx].materials = mats;
      }
      await db.collection('data').updateOne({ _id: 'main' }, { $set: { entries } });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/material-delete", async (req, res) => {
  try {
    const db = await connectDB();
    const { isGeneral, expIndex, entryDate, entryProject, matIndex } = req.body;
    const doc = await db.collection('data').findOne({ _id: 'main' });
    if (isGeneral) {
      const expenses = [...(doc?.generalExpenses || [])];
      if (expIndex < 0 || expIndex >= expenses.length) return res.status(404).json({ error: 'Not found' });
      expenses.splice(expIndex, 1);
      await db.collection('data').updateOne({ _id: 'main' }, { $set: { generalExpenses: expenses } });
    } else {
      const entries = [...(doc?.entries || [])];
      const entryIdx = entries.findIndex(e => e.date === entryDate && e.project === entryProject);
      if (entryIdx === -1) return res.status(404).json({ error: 'Entry not found' });
      const mats = [...(entries[entryIdx].materials || [])];
      if (matIndex < 0 || matIndex >= mats.length) return res.status(404).json({ error: 'Material not found' });
      mats.splice(matIndex, 1);
      entries[entryIdx].materials = mats;
      await db.collection('data').updateOne({ _id: 'main' }, { $set: { entries } });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/entries", async (req, res) => {
  try {
    const db = await connectDB();
    const doc = await db.collection('data').findOne({ _id: 'main' });
    let entries = doc?.entries || [];
    const { from, to } = req.query;
    if (from) entries = entries.filter(e => (e.date || '') >= from);
    if (to) entries = entries.filter(e => (e.date || '') <= to);
    entries = [...entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/theme", async (req, res) => {
  try {
    const db = await connectDB();
    const doc = await db.collection('data').findOne({ _id: 'main' });
    const defaultPalette = ['#cc4444','#e8720c','#e8c020','#2a9a2a','#1a8a8a','#1a5fa8','#6b2fbe','#b02080','#8b6914','#666666','#111111','#ffffff'];
    const defaults = { accentColor: '#e8a020', bgColor: '#1a1a2e', panelColor: '#16213e', textColor: '#eeeeee', invoiceAccentColor: '#e8a020', colorPalette: defaultPalette };
    const saved = doc?.theme || {};
    res.json({ ...defaults, ...saved, colorPalette: (saved.colorPalette && saved.colorPalette.length === 12) ? saved.colorPalette : defaultPalette });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/theme", async (req, res) => {
  try {
    const db = await connectDB();
    await db.collection('data').updateOne({ _id: 'main' }, { $set: { theme: req.body } }, { upsert: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/dashboard/flags", async (req, res) => {
  try {
    const { summary } = req.body;
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are the AI business manager for Mullins Construction Inc., run by Walt Mullins. Review this monthly work summary and flag any issues, missing data, risks, or opportunities. Be specific, concise, and actionable. Use bullet points. Keep it under 200 words.\n\n${summary}`
      }]
    });
    res.json({ flags: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "No text provided" });
    if (!ELEVENLABS_API_KEY) return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
    const stripped = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().substring(0, 4000);
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: stripped,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    if (!elRes.ok) {
      const errText = await elRes.text();
      return res.status(elRes.status).json({ error: errText });
    }
    const buf = await elRes.arrayBuffer();
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ══ STATEMENT PDF v1 — renders posted HTML through the existing generatePDF() and returns a downloadable PDF. Self-contained; touches nothing else. ══
app.post('/api/statement/pdf', async (req, res) => {
  try {
    const { html, filename } = req.body || {};
    if (!html || typeof html !== 'string' || html.length > 2000000) {
      return res.status(400).json({ error: 'Missing or oversized html' });
    }
    const pdf = await generatePDF(html);
    const safeName = String(filename || 'statement').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 80) || 'statement';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.pdf"');
    res.send(Buffer.from(pdf));
  } catch (err) {
    console.error('statement pdf error:', err.message);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`The Super is running on port ${PORT}`);
});


