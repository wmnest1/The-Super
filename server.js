const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const empty = { clients: [], projects: [], crew: [], subs: [], unitPrices: [], entries: [] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(empty, null, 2));
      return empty;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return { clients: [], projects: [], crew: [], subs: [], unitPrices: [], entries: [] }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function buildSystemPrompt(data) {
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

CURRENT DATA:
Clients: ${JSON.stringify(data.clients)}
Projects: ${JSON.stringify(data.projects)}
Crew: ${JSON.stringify(data.crew)}
Subs: ${JSON.stringify(data.subs)}
Unit Prices: ${JSON.stringify(data.unitPrices)}

HOW YOU RESPOND:
- Plain English, direct, no fluff
- For normal conversation, reply in plain text
- When generating an invoice, proposal, or estimate: output ONLY clean HTML (no markdown, no code fences). The HTML will be rendered directly in the chat UI.
- Always use Mullins Construction branding on documents
- Ask clarifying questions only when truly needed
- You remember everything Walt tells you within this conversation

DOCUMENT HTML FORMAT:
When generating invoices or proposals, return clean HTML like this structure (use inline styles):

<div style="font-family:Arial,sans-serif;max-width:680px;background:#fff;color:#111;padding:32px;border-radius:8px;">
  <div style="border-bottom:3px solid #e8a020;padding-bottom:16px;margin-bottom:24px;">
    <h1 style="color:#e8a020;margin:0;font-size:24px;">MULLINS CONSTRUCTION INC.</h1>
    <p style="margin:4px 0;font-size:13px;color:#555;">License #855578 | 1702-L Meridian Ave #164, San Jose, CA 95125</p>
    <p style="margin:4px 0;font-size:13px;color:#555;">Phone: 408-569-3434 | Fax: 408-448-2440 | mullinsconstruction@yahoo.com</p>
  </div>
  <h2 style="color:#333;font-size:18px;margin:0 0 16px;">INVOICE / PROPOSAL</h2>
  <!-- document body -->
  <table style="width:100%;border-collapse:collapse;margin:16px 0;">
    <tr style="background:#f5f5f5;"><th style="text-align:left;padding:8px;border:1px solid #ddd;">Description</th><th style="text-align:right;padding:8px;border:1px solid #ddd;">Amount</th></tr>
    <!-- rows -->
  </table>
  <div style="text-align:right;font-size:18px;font-weight:bold;margin-top:16px;color:#e8a020;">TOTAL: $X,XXX.00</div>
  <div style="margin-top:24px;font-size:13px;color:#555;border-top:1px solid #ddd;padding-top:12px;">
    Payment: Check payable to Mullins Construction, mail to 1702 Meridian Ave L164, San Jose CA 95125 — or Zelle
  </div>
</div>

Invoices include: property address, client name, date, scope of work performed, line items with hours/rate, materials, markup if applicable, total, payment instructions.
Proposals include: property address, client name, scope, exclusions, total or unit pricing, signature block with date line.`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const data = loadData();
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    
    const messages = [];
    if (history && history.length > 0) messages.push(...history.slice(-20));
    messages.push({ role: 'user', content: message });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: buildSystemPrompt(data),
      messages
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data', (req, res) => res.json(loadData()));

app.post('/api/data', (req, res) => {
  saveData(req.body);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`The Super is running on port ${PORT}`);
});
