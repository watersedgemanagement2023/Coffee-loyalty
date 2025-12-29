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

/**
 * Admin: generate store QR that opens a URL (so phone camera opens browser, not Notes)
 */
app.get("/api/admin/qr", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.sendStatus(403);

  const ts = Date.now().toString();
  const base = `${STORE_ID}|${ts}`;
  const sig = hmac(base);

  // URL-safe encoded payload
  const d = Buffer.from(`${base}|${sig}`, "utf8").toString("base64url");

const baseUrl = process.env.PUBLIC_BASE_URL || "https://coffee-loyalty.onrender.com";
const url = `${baseUrl}/scan/${d}`;

console.log("QR URL:", url); // TEMP DEBUG ✅

const qr = await QRCode.toDataURL(url, { scale: 8 });

res.json({
  store_id: STORE_ID,
  url,
  qr_data_url: qr
});

});

/**
 * Customer status (for debugging)
 */
app.get("/api/customer/:id", async (req, res) => {
  const customer = await getOrCreateCustomer(req.params.id);
  res.json({ customer });
});

/**
 * Camera-scan endpoint: customer scans QR -> browser opens -> stamp added
 */
app.get("/scan/:d", async (req, res) => {
  try {
    const d = req.params.d;

    if (!d) {
      return res.status(400).send(`
        <html><body style="font-family:system-ui;padding:24px">
          <h2>Scan Failed</h2>
          <p>Please scan the QR code again.</p>
          <p>The Team at Waters Edge thanks you.</p>
        </body></html>
      `);
    }

    console.log("[scan] app_secret set:", !!APP_SECRET);
    console.log("[scan] d length:", String(d).length);

    let decoded;
    try {
      decoded = Buffer.from(String(d).trim(), "base64url").toString("utf8");
    } catch (e) {
      console.log("[scan] decode failed:", e?.message);
      return res.status(400).send("bad payload");
    }

    const parts = decoded.split("|");
    console.log("[scan] parts:", parts.length);

    if (parts.length !== 3) {
      console.log("[scan] decoded preview:", decoded.slice(0, 120));
      return res.status(400).send("bad payload");
    }

    const [storeId, ts, sig] = parts;

    const base = `${storeId}|${ts}`;
    const expected = hmac(base);

    const ok = sig === expected;
    console.log("[scan] sig match:", ok);

    if (!ok) return res.status(401).send("invalid signature");

    return res.send("OK");
  } catch (err) {
    console.error("[scan] exception:", err);
    return res.status(400).send("bad payload");
  }
});


/**
 * (Optional) keep POST /api/scan if you want a future in-app scanner.
 * You can delete this later; it doesn't break anything.
 */
app.post("/api/scan", async (req, res) => {
  const { customer_id, qr_payload } = req.body;
  if (!customer_id || !qr_payload) return res.sendStatus(400);

  const [storeId, ts, sig] = qr_payload.split("|");
  const base = `${storeId}|${ts}`;
  if (hmac(base) !== sig) return res.sendStatus(401);

  const customer = await getOrCreateCustomer(customer_id);

  const last = customer.last_scan_at ? new Date(customer.last_scan_at).getTime() : 0;
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

// Customer "me" (cookie-based) status
app.get("/api/me", async (req, res) => {
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
  res.json({ customer });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const REDEEM_PIN = process.env.REDEEM_PIN;

// Redeem a free drink (requires staff PIN)
app.post("/api/redeem", async (req, res) => {
  const { pin } = req.body;
  if (!REDEEM_PIN) return res.status(500).json({ error: "redeem_pin_not_set" });
  if (pin !== REDEEM_PIN) return res.status(403).json({ error: "bad_pin" });

  // Get customer id from cookie (same as /api/me)
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)cid=([^;]+)/);
  if (!match) return res.status(400).json({ error: "no_customer_cookie" });

  const cid = decodeURIComponent(match[1]);
  const customer = await getOrCreateCustomer(cid);

  if (customer.free_available <= 0) {
    return res.status(400).json({ error: "no_free_drinks" });
  }

  const newFree = customer.free_available - 1;

  await pool.query(
    `UPDATE customers
     SET free_available=$1
     WHERE id=$2`,
    [newFree, cid]
  );

  await pool.query(
    `INSERT INTO redemptions (customer_id, store_id)
     VALUES ($1, $2)`,
    [cid, STORE_ID]
  );

  const updated = await getOrCreateCustomer(cid);
  res.json({ customer: updated });
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
