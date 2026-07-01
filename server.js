const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { MongoClient } = require("mongodb");

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
  return `You are The Super — the private business management AI for Walt Mullins of Mullins Construction Inc.

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

CURRENT DATE & TIME: ${dateTime}
TODAY'S ISO DATE (for save_entry): ${isoDate}
Use this for notes, logs, hour entries, and any time-sensitive responses.

NEXT INVOICE/PROPOSAL NUMBER: ${invoiceNum}
Always use this number on the next document you generate. It goes in the top-right header area alongside INVOICE or PROPOSAL.

DOCUMENT DATE: Default to ${dateOnly} on all invoices and proposals. If Walt specifies a different date, use that instead. Show date only — never show a time on invoices or proposals.

DATA SAVING INSTRUCTIONS:
When Walt tells you to log hours, record work, add a client, add a project, add crew, or save any business data — USE THE APPROPRIATE TOOL to save it immediately. Do not ask him to open the Data panel. Just save it and confirm what you saved.
- For save_entry: always put Walt's original spoken or typed text verbatim into the "notes" field so he can verify what was captured.
- For crew member absences via chat: if Walt says "Moi is out sick", "Abner no show today", "mark Chemo as vacation" — use save_entry with hours: "0" and set the crew member's note field to a short description (e.g. "Sick", "No show", "Vacation"). If Walt names a color (e.g. "mark Moi out in red"), set color to the matching hex (red: #cc4444, orange: #e8720c, yellow: #e8c020, green: #2a9a2a, blue: #1a5fa8, purple: #6b2fbe, pink: #b02080). Default note color is #884444.
- For "NO WORK" specifically: if Walt says "Moi no work today", "Abner didn't work", "Chemo off today", "mark Isreal as no work", "Chepey not working", "nobody worked", or any phrasing meaning a person did zero work for the day — set that person's hours: "0", oosHours: "0", note: "NO WORK", color: "#cc3333". Log it immediately without asking for clarification.
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
        notes: { type: "string", description: "What was done, any relevant notes." }
      },
      required: ["date", "project"]
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
  }
];

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

// ── Tool executor ──
function executeTool(toolName, input, data) {
  switch (toolName) {
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
    default:
      return { ok: false, error: "Unknown tool: " + toolName };
  }
}

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
      tools: TOOLS,
      messages,
    });

    let dataSaved = false;

    // Tool use loop
    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResultContents = [];

      for (const toolUse of toolUseBlocks) {
        const result = executeTool(toolUse.name, toolUse.input, data);
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
        tools: TOOLS,
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
