const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

const EMPTY_DATA = () => ({
  clients: [],
  projects: [],
  crew: [],
  subs: [],
  unitPrices: [],
  entries: [],
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

function buildSystemPrompt(data) {
  const invoiceNum = data.nextInvoiceNumber || 1001;
  const { dateOnly, dateTime, isoDate } = getPSTDateTime();
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
Materials markup: 15% on some jobs, none on others — confirm per job.

CURRENT DATE & TIME: ${dateTime}
TODAY'S ISO DATE (for save_entry): ${isoDate}
Use this for notes, logs, hour entries, and any time-sensitive responses.

NEXT INVOICE/PROPOSAL NUMBER: ${invoiceNum}
Always use this number on the next document you generate. It goes in the top-right header area alongside INVOICE or PROPOSAL.

DOCUMENT DATE: Default to ${dateOnly} on all invoices and proposals. If Walt specifies a different date, use that instead. Show date only — never show a time on invoices or proposals.

DATA SAVING INSTRUCTIONS:
When Walt tells you to log hours, record work, add a client, add a project, add crew, or save any business data — USE THE APPROPRIATE TOOL to save it immediately. Do not ask him to open the Data panel. Just save it and confirm what you saved.
- For save_entry: always put Walt's original spoken or typed text verbatim into the "notes" field so he can verify what was captured.
- For project name: pick the closest matching project from the PROJECTS list above. "Cronce job" → "Cronce Remodel", "Viraj house" → "Viraj Remodel", etc. Never invent a new project name if an existing one is a reasonable match.

CURRENT DATA:

CLIENTS:
${(data.clients||[]).map(c => `- ${c.name}${c.phone?" | "+c.phone:""}${c.email?" | "+c.email:""}${c.address?" | "+c.address:""}${c.notes?" | Notes: "+c.notes:""}`).join("\n") || "None on file"}

PROJECTS:
${(data.projects||[]).map(p => `- ${p.name} [${p.status||"Active"}]${p.client?" | Client: "+p.client:""}${p.address?" | "+p.address:""}${p.startDate?" | Start: "+p.startDate:""}${p.rate?" | Billing: $"+p.rate+"/hr":""}${p.contractAmount?" | Contract: $"+p.contractAmount:""}${p.notes?" | Scope: "+p.notes:""}`).join("\n") || "None on file"}

CREW:
${(data.crew||[]).map(c => `- ${c.name}${c.nickname?" ("+c.nickname+")":""}${c.role?" | "+c.role:""}${c.hourlyRate?" | Pay: $"+c.hourlyRate+"/hr":""}${c.phone?" | "+c.phone:""}${c.notes?" | "+c.notes:""}`).join("\n") || "None on file"}

SUBCONTRACTORS:
${(data.subs||[]).map(s => `- ${s.company||s.name}${s.trade?" | "+s.trade:""}${s.contact?" | Contact: "+s.contact:""}${s.phone?" | "+s.phone:""}${s.rate?" | Rate: "+s.rate:""}${s.cslbNumber?" | CSLB #"+s.cslbNumber+(s.cslbExpiration?" exp "+s.cslbExpiration:""):""}${s.glCarrier?" | GL: "+s.glCarrier+(s.glExpiration?" exp "+s.glExpiration:""):""}${s.wcCarrier?" | WC: "+s.wcCarrier+(s.wcExpiration?" exp "+s.wcExpiration:""):""}${s.notes?" | Notes: "+s.notes:""}`).join("\n") || "None on file"}

UNIT PRICES:
${(data.unitPrices||[]).map(u => `- ${u.description}${u.category?" ["+u.category+"]":""}${u.price?" | $"+u.price+" per "+(u.unit||"ea"):""}${u.notes?" | "+u.notes:""}`).join("\n") || "None on file"}

DAILY ENTRIES LOG (hours worked & materials purchased, newest first):
${(data.entries||[]).length === 0 ? "No entries logged yet" : [...(data.entries||[])].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(e => {
  const crew = (e.crew||[]).map(c=>`${c.name} ${c.hours}hr`).join(", ");
  const mats = (e.materials||[]).map(m=>`${m.description} $${m.cost}`).join(", ");
  const totalHrs = (e.crew||[]).reduce((s,c)=>s+parseFloat(c.hours||0),0);
  const totalMat = (e.materials||[]).reduce((s,m)=>s+parseFloat(m.cost||0),0);
  return `- [${e.date}] ${e.project}${crew?" | Crew: "+crew+" ("+totalHrs+"hr total)":""}${mats?" | Materials: "+mats+" ($"+totalMat.toFixed(2)+" total)":""}${e.notes?" | "+e.notes:""}`;
}).join("\n")}

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
  <div style="border-bottom:3px solid #e8a020;padding-bottom:16px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:flex-end;">
    <div>
      <h1 style="color:#e8a020;margin:0 0 4px;font-size:26px;letter-spacing:1px;">MULLINS CONSTRUCTION INC.</h1>
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
              hours: { type: "string", description: "Hours worked, e.g. '8' or '6.5'" }
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
        rate: { type: "string", description: "Billing rate per hour to client" },
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
        crew: input.crew || [],
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
    default:
      return { ok: false, error: "Unknown tool: " + toolName };
  }
}

// ── Routes ──
app.post("/api/chat", async (req, res) => {
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
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: buildSystemPrompt(data),
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
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: buildSystemPrompt(data),
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

app.post("/api/dashboard/flags", async (req, res) => {
  try {
    const { summary } = req.body;
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`The Super is running on port ${PORT}`);
});
