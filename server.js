// Relay Saweria -> Roblox (Open Cloud Messaging Service)
// Saweria webhook (POST + header Saweria-Callback-Signature) -> publish ke topic -> SaweriaHandler di game.
const express = require("express");
const { createMiddleware } = require("saweria-webhook-express");

const {
  STREAM_KEY,
  ROBLOX_API_KEY,
  UNIVERSE_ID,
  PLACE_ID,
  TOPIC = "SaweriaDonation_v1",
  TEST_TOKEN,
  PORT = 8080,
} = process.env;

if (!STREAM_KEY || !ROBLOX_API_KEY || (!UNIVERSE_ID && !PLACE_ID)) {
  console.error("STREAM_KEY, ROBLOX_API_KEY, dan UNIVERSE_ID atau PLACE_ID wajib diisi (lihat .env.example)");
  process.exit(1);
}

let universeId = UNIVERSE_ID || null;

async function resolveUniverseId() {
  if (universeId) return universeId;
  const res = await fetch(`https://apis.roblox.com/universes/v1/places/${PLACE_ID}/universe`);
  if (!res.ok) throw new Error(`Gagal mencari universe id (HTTP ${res.status}); isi UNIVERSE_ID manual`);
  universeId = String((await res.json()).universeId);
  console.log("Universe id:", universeId);
  return universeId;
}

// Pesan Open Cloud maksimal ~1 KB, jadi teks dipotong.
const cut = (value, max) => Array.from(String(value ?? "")).slice(0, max).join("");

async function publish(topic, payload) {
  const id = await resolveUniverseId();
  const res = await fetch(`https://apis.roblox.com/messaging-service/v1/universes/${id}/topics/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: { "x-api-key": ROBLOX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ message: JSON.stringify(payload) }),
  });
  if (!res.ok) throw new Error(`Publish gagal: HTTP ${res.status} ${await res.text()}`);
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("ok"));

// URL ini dipasang di Saweria: https://<domain-kamu>/saweria
app.post("/saweria", createMiddleware(STREAM_KEY), (req, res) => {
  const d = req.body || {};
  if (d.type && d.type !== "donation") return res.sendStatus(200);

  const payload = {
    id: String(d.id),
    name: cut(d.donator_name, 40),
    idr: Number(d.amount_raw),
    text: cut(d.message, 120),
    createdAt: d.created_at,
  };
  console.log("Donasi Saweria:", payload.id, payload.name, payload.idr);

  // Balas cepat ke Saweria, publish di belakang
  res.sendStatus(200);
  publish(TOPIC, payload).catch((err) => console.error(err.message));
});

// Tes ujung-ke-ujung: POST /test  header x-test-token, body {"name":"Budi","idr":10000,"text":"halo","studio":true}
// studio:true -> publish ke "<TOPIC>_Studio" (didengarkan Roblox Studio, bukan server live)
if (TEST_TOKEN) {
  app.post("/test", async (req, res) => {
    if (req.get("x-test-token") !== TEST_TOKEN) return res.sendStatus(401);
    const b = req.body || {};
    const payload = {
      id: `test-${Date.now()}`,
      name: cut(b.name || "Tester", 40),
      idr: Number(b.idr) || 10000,
      text: cut(b.text || "", 120),
      createdAt: new Date().toISOString(),
    };
    try {
      await publish(b.studio ? `${TOPIC}_Studio` : TOPIC, payload);
      res.json({ ok: true, payload });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });
}

app.listen(PORT, () => console.log("Saweria relay jalan di port", PORT));
