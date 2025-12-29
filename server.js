import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, getOrCreateCustomer, pool } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

await initDb();

const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY;
const STORE_ID = process.env.STORE_ID;

function hmac(payload) {
  return crypto.createHmac("sha256", APP_SECRET).update(payload).digest("hex");
}

// Admin: generate store QR
app.get("/api/admin/qr", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.sendStatus(403);

  const ts = Date.now().toString();
  const base = `${STORE_ID}|${ts}`;
  const sig = hmac(base);

  // Encode as base64url so it’s URL-safe
  const d = Buffer.from(`${base}|${sig}`, "utf8").toString("base64url");

  const url = `https://${req.get("host")}/scan?d=${d}`;
  const qr = await QRCode.toDataURL(url, { scale: 8 });

  res.json({ store_id: STORE_ID, url, qr_data_url: qr });
});
});

// Customer status
app.get("/api/customer/:id", async (req, res) => {
  const customer = await getOrCreateCustomer(req.params.id);
  res.json({ customer });
});

// Scan
app.post("/api/scan", async (req, res) => {
  const { customer_id, qr_payload } = req.body;
  if (!customer_id || !qr_payload) return res.sendStatus(400);

  const [storeId, ts, sig] = qr_payload.split("|");
  const base = `${storeId}|${ts}`;
  if (hmac(base) !== sig) return res.sendStatus(401);

  const customer = await getOrCreateCustomer(customer_id);

  const last = customer.last_scan_at
    ? new Date(customer.last_scan_at).getTime()
    : 0;

  if (Date.now() - last < 10 * 60 * 1000) {
    return res.status(429).json({ error: "rate_limited" });
  }

  let { stamp_count, free_available } = customer;
  if (stamp_count >= 5) {
    stamp_count = 0;
    free_available += 1;
  } else {
    stamp_count += 1;
  }

  await pool.query(
    `UPDATE customers
     SET stamp_count=$1, free_available=$2, last_scan_at=now()
     WHERE id=$3`,
    [stamp_count, free_available, customer_id]
  );

  await pool.query(
    "INSERT INTO scans (customer_id, store_id) VALUES ($1,$2)",
    [customer_id, storeId]
  );

  const updated = await getOrCreateCustomer(customer_id);
  res.json({ customer: updated });
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

app.get("/scan", async (req, res) => {
  const d = req.query.d;
  if (!d) return res.status(400).send("Missing d");

  // d is base64url of "STORE_ID|timestamp|sig"
  let payload;
  try {
    payload = Buffer.from(d, "base64url").toString("utf8");
  } catch {
    return res.status(400).send("Bad d");
  }

  const [storeId, ts, sig] = payload.split("|");
  if (!storeId || !ts || !sig) return res.status(400).send("Bad payload");

  const base = `${storeId}|${ts}`;
  if (hmac(base) !== sig) return res.status(401).send("Invalid QR");

  // Customer id stored in cookie so same phone keeps progress
  const cookieName = "cid";
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)cid=([^;]+)/);
  let cid = match ? decodeURIComponent(match[1]) : crypto.randomUUID();

  // If new, set cookie (1 year)
  if (!match) {
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${encodeURIComponent(cid)}; Path=/; Max-Age=31536000; SameSite=Lax`
    );
  }

  const customer = await getOrCreateCustomer(cid);

  // 10-minute rate limit
  const last = customer.last_scan_at ? new Date(customer.last_scan_at).getTime() : 0;
  if (Date.now() - last < 10 * 60 * 1000) {
    return res.status(429).send("Too soon — try again in a few minutes.");
  }

  // Loyalty logic
  let { stamp_count, free_available } = customer;
  if (stamp_count >= 5) {
    stamp_count = 0;
    free_available += 1;
  } else {
    stamp_count += 1;
  }

  await pool.query(
    `UPDATE customers
     SET stamp_count=$1, free_available=$2, last_scan_at=now()
     WHERE id=$3`,
    [stamp_count, free_available, cid]
  );

  await pool.query(
    "INSERT INTO scans (customer_id, store_id) VALUES ($1,$2)",
    [cid, storeId]
  );

  // Simple success page
  res.send(`
    <html><body style="font-family:system-ui;padding:24px">
      <h2>✅ Stamp added</h2>
      <p>Stamps: <
