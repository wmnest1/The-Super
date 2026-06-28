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
- When asked to generate a document, produce it fully formatted and ready to use
- Always use Mullins Construction branding on documents
- For invoices: show scope, hours, rate, materials, markup if applicable, total
- For proposals: include scope, exclusions, and a signature line
- Ask clarifying questions only when truly needed
- You remember everything Walt tells you within this conversation

DOCUMENT FORMATS:
Invoices include: Property address, client name, date, scope of work performed, total, payment instructions (check to 1702 Meridian Ave L164, San Jose CA 95125 or Zelle)
Proposals include: Property address, client name, scope, exclusions, total or unit pricing, signature block`;
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
