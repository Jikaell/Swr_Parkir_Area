// Relay donasi (BagiBagi / Saweria) -> Roblox (Open Cloud Messaging Service)
// Webhook platform donasi -> publish ke topic -> SaweriaHandler di game (nama script tetap, topic tetap).
const crypto = require("crypto");
const express = require("express");

const {
  WEBHOOK_SECRET, // rahasia di URL webhook BagiBagi: /bagibagi/<WEBHOOK_SECRET>
  STREAM_KEY, // opsional: hanya kalau Saweria masih dipakai (/saweria)
  ROBLOX_API_KEY,
  UNIVERSE_ID,
  PLACE_ID,
  TOPIC = "SaweriaDonation_v1", // harus sama dengan CONFIG.TOPIC di ServerScriptService.SaweriaHandler
  TEST_TOKEN,
  PORT = 8080,
} = process.env;

const missingEnv = [
  !ROBLOX_API_KEY && "ROBLOX_API_KEY",
  !UNIVERSE_ID && !PLACE_ID && "UNIVERSE_ID atau PLACE_ID",
  !WEBHOOK_SECRET && !STREAM_KEY && "WEBHOOK_SECRET (BagiBagi) atau STREAM_KEY (Saweria)",
].filter(Boolean);
if (missingEnv.length) console.error("Environment variable belum diisi:", missingEnv.join(", "));

let universeId = UNIVERSE_ID || null;
async function resolveUniverseId() {
  if (universeId) return universeId;
  const res = await fetch(`https://apis.roblox.com/universes/v1/places/${PLACE_ID}/universe`);
  if (!res.ok) throw new Error(`Gagal mencari universe id (HTTP ${res.status}); isi UNIVERSE_ID manual`);
  universeId = String((await res.json()).universeId);
  return universeId;
}

// Pesan Open Cloud maksimal ~1 KB, jadi teks dipotong.
const cut = (value, max) => Array.from(String(value ?? "")).slice(0, max).join("");

// Nominal bisa angka atau teks ("10000", "10.000", "Rp 10.000,00", "10000.00")
function parseIDR(value) {
  if (typeof value === "number") return Math.floor(value);
  const s = String(value ?? "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  const cleaned = s.replace(/[^\d.,]/g, "").replace(/[.,]\d{1,2}$/, "");
  return Number(cleaned.replace(/[.,]/g, "")) || 0;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

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
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => res.send(missingEnv.length ? `Env belum diisi: ${missingEnv.join(", ")}` : "ok"));

const notReady = () => missingEnv.length > 0;

// ===== BagiBagi =====
// Pasang di BagiBagi (bagibagi.co/stream-overlay > Integrasi > Custom Webhook Url):
//   https://<domain>/bagibagi/<WEBHOOK_SECRET>
// Isi webhook BagiBagi (JSON): name, amount, message. Tidak ada id dari BagiBagi, jadi id dibuat acak per donasi.
app.post("/bagibagi/:secret", async (req, res) => {
  if (!WEBHOOK_SECRET || !safeEqual(req.params.secret, WEBHOOK_SECRET)) return res.sendStatus(401);
  if (notReady()) return res.status(500).send("Env belum lengkap");
  const d = req.body || {};
  console.log("Webhook BagiBagi, field:", Object.keys(d).join(","));

  const idr = parseIDR(d.amount ?? d.nominal);
  if (!idr) return res.status(400).send("amount tidak valid");
  const payload = {
    id: String(d.id ?? d.donation_id ?? d.transaction_id ?? crypto.randomUUID()),
    name: cut(d.name ?? d.donator_name ?? "Anonymous", 40),
    idr,
    text: cut(d.message ?? d.msg ?? "", 120),
    createdAt: new Date().toISOString(),
  };
  console.log("Donasi BagiBagi:", payload.id, payload.name, payload.idr);
  try {
    await publish(TOPIC, payload); // publish dulu baru balas (serverless bisa berhenti setelah respons)
    res.json({ success: true });
  } catch (err) {
    console.error(err.message);
    res.sendStatus(502);
  }
});

// ===== Saweria (opsional, hanya aktif kalau STREAM_KEY diisi) =====
if (STREAM_KEY) {
  const { createMiddleware } = require("saweria-webhook-express");
  app.post("/saweria", createMiddleware(STREAM_KEY), async (req, res) => {
    if (notReady()) return res.status(500).send("Env belum lengkap");
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
    try {
      await publish(TOPIC, payload);
      res.sendStatus(200);
    } catch (err) {
      console.error(err.message);
      res.sendStatus(502);
    }
  });
}

// ===== Tes ujung-ke-ujung =====
// POST /test  header x-test-token, body {"name":"Budi","idr":10000,"text":"halo","studio":true}
// studio:true -> publish ke "<TOPIC>_Studio" (didengarkan Roblox Studio, bukan server live)
if (TEST_TOKEN) {
  app.post("/test", async (req, res) => {
    if (!safeEqual(req.get("x-test-token") ?? "", TEST_TOKEN)) return res.sendStatus(401);
    if (notReady()) return res.status(500).json({ ok: false, error: `Env belum diisi: ${missingEnv.join(", ")}` });
    const b = req.body || {};
    const payload = {
      id: `test-${Date.now()}`,
      name: cut(b.name || "Tester", 40),
      idr: parseIDR(b.idr) || 10000,
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

module.exports = app; // Vercel memakai export ini

if (require.main === module) {
  app.listen(PORT, () => console.log("Relay jalan di port", PORT));
}
