const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { MongoClient } = require("mongodb");
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

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
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
  return doc;
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
- Fax: 408-448-2440
- Email: mullinsconstruction@yahoo.com

YOUR JOB:
You help Walt run his construction business. You generate professional proposals, estimates, and invoices. You track jobs, hours, materials, and clients. You know Walt's pricing, crew, and how he operates.

WALT'S CREW:
Moises (Moi), Abner (Ab), Chemo, Chepey, Isreal

BILLING RATES VARY BY PROJECT — always confirm rate before calculating.
Common rates: $110/hr, $120/hr, $125/hr
Materials markup: Each project has its own markup % stored in the project record. Use the per-project "markup" field when calculating material costs on invoices and proposals. If no markup is set for a project, do not apply one unless Walt specifies.
Out-of-scope rate: Each project may have an "oosRate" field ($/hr billed to client for OOS/extra work). Use it for OOS line items on invoices. If not set, fall back to the project's regular "rate".

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
- For out-of-scope hours: if Walt says "out of scope", "extra work", "change order", "additional work", "bill separately", or similar — use the oosHours field on that crew member entry. For a mixed day (e.g. "Abner worked 8 hours, 5 regular and 3 out of scope") set hours: "5" and oosHours: "3" — do NOT put all hours in the hours field. When generating invoices, show regular hours and OOS hours as SEPARATE line items (e.g. "Labor — Contract Work" at the regular rate and "Labor — Additional Work (Out of Scope)" at the project's oosRate — or the regular rate if oosRate is not set).

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
6. OOS LINE ITEMS: When generating change order / OOS sections on invoices, always use the project's oosRate field automatically (fall back to regular rate if oosRate not set).

EMAIL CAPABILITIES:
- You can send invoices and proposals directly to clients via email using the send_email tool.
- Client emails are in the CLIENTS data above — always check there first.
- Workflow: Generate the invoice/proposal first, then ask "Want me to email this to [client name] at [email]?" — wait for Walt to confirm, then call send_email.
- If Walt says "generate and email an invoice for Barbara" — do both in sequence: generate first, confirm the email address, then send after Walt says yes/go ahead/send it.
- After sending, confirm: "✅ Invoice emailed to [email] — sent from mullinsconstruction@yahoo.com"
- If client email is not on file, say "I don't have an email on file for [client] — what's their email?" and save it to their client record using save_client before sending.
- Subject line format: "Invoice #XXXX — Mullins Construction Inc." or "Proposal — [Job Description] — Mullins Construction"
- The html_body field should be the complete invoice/proposal HTML exactly as generated.
- When generating invoices or proposals that will be emailed, use email-safe HTML: outer container max-width 600px; use <table> for layout, not flexbox or grid; all styles inline (style="..." on each element); no external CSS dependencies; compatible with Gmail, Yahoo Mail, Outlook; font Arial or sans-serif only; no font sizes smaller than 12px.
- The document is sent as a PDF ATTACHMENT — not embedded in the email body.
- The email body (email_body field) should be a short, professional, friendly message — 3-4 sentences max. Always address client by first name. For invoices: mention the total amount due and payment instructions (check payable to Mullins Construction or Zelle). For proposals: mention the job address and invite them to reply with questions.
- PDF filename format: "Invoice-[number]-[ClientLastName].pdf" or "Proposal-[JobName]-[Date].pdf"
- After sending confirm: "✅ Email sent to [email] with PDF attachment: [filename]"

HOW YOU RESPOND:
- Plain English, direct, no fluff
- For normal conversation, reply in plain text
- When generating an invoice, proposal, or estimate: output ONLY clean HTML (no markdown, no code fences). The HTML will be rendered directly in the chat UI.
- Always use Mullins Construction branding on documents
- Ask clarifying questions only when truly needed
- You remember everything Walt tells you within this conversation

DOCUMENT HTML FORMAT:
When generating invoices or proposals, return clean HTML like this structure (use inline styles):

<div style="font-family:Arial,sans-serif;width:100%;max-width:816px;background:#fff;color:#111;padding:72px 80px;box-sizing:border-box;margin:0 auto;">
  <div style="border-bottom:3px solid ${invoiceAccentColor};padding-bottom:16px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:flex-end;">
    <div>
      <h1 style="color:${invoiceAccentColor};margin:0 0 4px;font-size:26px;letter-spacing:1px;">MULLINS CONSTRUCTION INC.</h1>
      <p style="margin:2px 0;font-size:12px;color:#555;">License #855578</p>
      <p style="margin:2px 0;font-size:12px;color:#555;">1702-L Meridian Ave #164, San Jose, CA 95125</p>
      <p style="margin:2px 0;font-size:12px;color:#555;">Phone: 408-569-3434 | Fax: 408-448-2440</p>
      <p style="margin:2px 0;font-size:12px;color:#555;">mullinsconstruction@yahoo.com</p>
    </div>
    <div style="text-align:right;">
      <div style="font-size:22px;font-weight:bold;color:#333;">INVOICE</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
    <thead><tr style="background:#f0f0f0;">
      <th style="text-align:left;padding:10px 12px;border:1px solid #ccc;">Description</th>
      <th style="text-align:center;padding:10px 12px;border:1px solid #ccc;width:80px;">Qty/Hrs</th>
      <th style="text-align:right;padding:10px 12px;border:1px solid #ccc;width:100px;">Rate</th>
      <th style="text-align:right;padding:10px 12px;border:1px solid #ccc;width:110px;">Amount</th>
    </tr></thead>
    <tbody></tbody>
  </table>
  <div style="text-align:right;margin-top:8px;">
    <span style="font-size:20px;font-weight:bold;color:#111;">TOTAL: $X,XXX.00</span>
  </div>
  <div style="margin-top:40px;font-size:13px;color:#555;border-top:1px solid #ddd;padding-top:16px;">
    <strong>Payment:</strong> Check payable to Mullins Construction — mail to 1702 Meridian Ave L164, San Jose CA 95125, or Zelle.
  </div>
</div>

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

PROJECTS:
${(data.projects||[]).map(p => `- ${p.name} [${p.status||"Active"}]${p.client?" | Client: "+p.client:""}${p.address?" | "+p.address:""}${p.startDate?" | Start: "+p.startDate:""}${p.rate?" | Billing: $"+p.rate+"/hr":""}${(p.oosRate!==undefined&&p.oosRate!=="")?" | OOS Rate: $"+p.oosRate+"/hr (for extra/change-order work)":""}${p.contractAmount?" | Contract: $"+p.contractAmount:""}${(p.markup!==undefined&&p.markup!=="")?" | Materials Markup: "+p.markup+"%":""}${p.notes?" | Scope: "+p.notes:""}`).join("\n") || "None on file"}

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
              hours: { type: "string", description: "Regular (contract) hours worked, e.g. '8' or '5'. Use '0' if all hours were out of scope or if the person did not work that day." },
              oosHours: { type: "string", description: "Out-of-scope hours for this crew member on this same entry. Use when Walt says 'out of scope', 'extra work', 'change order', or 'bill separately'. Can accompany regular hours for a mixed day — e.g. { hours: '5', oosHours: '3' } for 5 regular + 3 OOS. Omit or leave '0' if no OOS hours." },
              note: { type: "string", description: "Optional status note for this crew member on this day, e.g. 'Sick', 'Vacation', 'No show', 'Half day'. Use when Walt mentions a person's absence or status instead of hours." },
              color: { type: "string", description: "Optional hex color for the note. Match by name: red: #cc4444, orange: #e8720c, yellow: #e8c020, green: #2a9a2a, teal: #1a8a8a, blue: #1a5fa8, purple: #6b2fbe, pink: #b02080. Default for absences: #884444. Omit if no note." }
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
              cost: { type: "string", description: "Dollar amount, e.g. '245.00'" }
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
        to_email: { type: "string", description: "Recipient email address." },
        to_name: { type: "string", description: "Recipient full name." },
        subject: { type: "string", description: "Email subject line, e.g. 'Invoice #1003 — Mullins Construction Inc.' or 'Proposal — Kitchen Remodel — Mullins Construction'" },
        html_body: { type: "string", description: "Complete HTML content of the invoice or proposal exactly as generated — do not simplify or strip it." },
        client_name: { type: "string", description: "Client's first name for the email greeting." },
        email_body: { type: "string", description: "The body text of the email message. Write a professional, friendly 3-4 sentence message referencing the attached document, the job address, and the total amount due if it's an invoice. Mention payment options (check to Mullins Construction or Zelle)." },
        pdf_filename: { type: "string", description: "Filename for the PDF attachment, e.g. 'Invoice-1006-Cooney.pdf' or 'Proposal-Cooney-Kitchen.pdf'" }
      },
      required: ["to_email", "subject", "html_body"]
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
async function executeTool(toolName, input, data) {
  switch (toolName) {
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
    case "save_entry": {
      if (!data.entries) data.entries = [];
      // Fuzzy-match project name against existing projects
      const matchedProject = fuzzyMatchProject(input.project, data.projects || []);
      const entry = {
        date: input.date,
        project: matchedProject,
        crew: (input.crew || []).map(c => ({
          name: c.name,
          hours: c.hours || '0',
          ...(parseFloat(c.oosHours||0) > 0 ? { oosHours: String(c.oosHours) } : {}),
          ...(c.note ? { note: c.note } : {}),
          ...(c.color ? { color: c.color } : {})
        })),
        materials: input.materials || [],
        notes: input.notes || ""
      };
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
        const toField = input.to_name
          ? `${input.to_name} <${input.to_email}>`
          : input.to_email;
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
        const pdfBuffer = await generatePDF(emailWrapper(input.html_body));
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
        return { success: true, message: `Email sent to ${input.to_email} with PDF attachment: ${input.pdf_filename || 'document.pdf'}` };
      } catch (e) {
        console.error('Email send error:', e.message);
        return { success: false, error: e.message };
      }
    }
    default:
      return { ok: false, error: "Unknown tool: " + toolName };
  }
}

// ── Email route ──
app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, html, text, attachPdf, pdfFilename, clientName, emailBody } = req.body;
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
      const pdfBuffer = await generatePDF(emailWrapper(html));
      mailOptions.attachments.push({
        filename: pdfFilename || 'Mullins-Construction-Document.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf'
      });
    }
    await emailTransporter.sendMail(mailOptions);
    res.json({ success: true, sentTo: to });
  } catch (e) {
    console.error('Email error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Routes ──
app.post("/api/chat", async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  try {
    const { message, history, imageData, imageType } = req.body;
    let data = await loadData();
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const messages = [];
    if (history && history.length > 0) messages.push(...history.slice(-20));

    let userContent;
    if (imageData && imageType) {
      userContent = [
        { type: "image", source: { type: "base64", media_type: imageType, data: imageData } },
        { type: "text", text: message || "Please analyze this image." }
      ];
    } else {
      userContent = message;
    }
    messages.push({ role: "user", content: userContent });

    let response = await anthropic.messages.create({
      model: "claude-opus-4-8",
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
        const result = await executeTool(toolUse.name, toolUse.input, data);
        if (result.ok) dataSaved = true;
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
        model: "claude-opus-4-8",
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
        entries[targetIdx].materials.push({ store: updated.store || '', description: updated.description || '', cost: String(updated.amount || 0), invoiceNum: updated.invoiceNum || '' });
      } else {
        mats[matIndex] = { ...mats[matIndex], store: updated.store ?? mats[matIndex].store, description: updated.description ?? mats[matIndex].description, cost: updated.amount != null ? String(updated.amount) : mats[matIndex].cost, invoiceNum: updated.invoiceNum ?? mats[matIndex].invoiceNum };
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`The Super is running on port ${PORT}`);
});
