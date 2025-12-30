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
      return res.status(400).send("Scan failed");
    }

    // Decode + verify QR
    const decoded = Buffer.from(String(d).trim(), "base64url").toString("utf8");
    const parts = decoded.split("|");
    if (parts.length !== 3) return res.status(400).send("Bad payload");

    const [storeId, ts, sig] = parts;
    const base = `${storeId}|${ts}`;
    if (hmac(base) !== sig) return res.status(401).send("Invalid QR");

    // Customer id via cookie
    const cookieName = "cid";
    const cookieHeader = req.headers.cookie || "";
    const match = cookieHeader.match(/(?:^|;\s*)cid=([^;]+)/);
    let cid = match ? decodeURIComponent(match[1]) : crypto.randomUUID();

    if (!match) {
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${encodeURIComponent(cid)}; Path=/; Max-Age=31536000; SameSite=Lax`
      );
    }

    const customer = await getOrCreateCustomer(cid);

    // 10-minute rate limit
    const last = customer.last_scan_at ? new Date(customer.last_scan_at).getTime() : 0;
    const isTest = req.query.test === "1";

if (!isTest && Date.now() - last < 10 * 60 * 1000) {

      return res.send(`
        <html>
          <body style="font-family:system-ui;padding:24px">
            <h2>☕ Already scanned</h2>
            <p>Please wait a few minutes before scanning again.</p>
          </body>
        </html>
      `);
    }

    // Loyalty logic (5 stamps = 1 free)
let { stamp_count, free_available } = customer;
let earnedReward = false;

if (stamp_count >= 4) {        // ✅ reward on 5th scan
  stamp_count = 0;
  free_available += 1;
  earnedReward = true;
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
      `INSERT INTO scans (customer_id, store_id)
       VALUES ($1, $2)`,
      [cid, storeId]
    );

    // ---- CUSTOMER UI (progress icons) ----
    const totalStamps = 5;
    const filled = stamp_count;
    const empty = totalStamps - filled;

    const cups =
      "☕".repeat(filled) +
      "<span class='empty'>" + "☕".repeat(empty) + "</span>";

    return res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Loyalty Stamp</title>
          <style>
  /* ...your existing styles... */

  .confetti {
    position: fixed;
    top: -10px;
    width: 10px;
    height: 14px;
    border-radius: 2px;
    opacity: 0.9;
    pointer-events: none;
    z-index: 9999;
   animation: confetti-fall 1.8s linear forwards;
  }

  @keyframes confetti-fall {
    to {
      transform: translate3d(var(--dx), 110vh, 0) rotate(var(--rot));
    }
  }

            body {
              font-family: system-ui;
              padding: 24px;
              background: #fafafa;
            }
            .card {
              max-width: 520px;
              margin: 0 auto;
              background: #fff;
              padding: 24px;
              border-radius: 18px;
              box-shadow: 0 6px 24px rgba(0,0,0,.08);
              text-align: center;
            }
            .cups {
              font-size: 32px;
              letter-spacing: 6px;
              margin: 16px 0;
            }
            .empty {
              opacity: 0.2;
            }
            .reward {
              margin-top: 16px;
              padding: 14px;
              border-radius: 12px;
              background: #111;
              color: #fff;
              font-weight: 600;
            }
    .logo {
  width: 240px;       /* 👈 increase this */
  max-width: 90%;     /* keeps it safe on small phones */
  margin: 0 auto 16px;
  display: block;
}

.redeem {
  margin-top: 14px;
  padding: 14px;
  width: 100%;
  border-radius: 12px;
  border: none;
  background: #0b5;
  color: #fff;
  font-size: 16px;
  font-weight: 600;
}
.logo {
  animation: fadeIn 2.5s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

          </style>
<script>
  function launchConfetti() {
    const count = 80;

    for (let i = 0; i < count; i++) {
      const piece = document.createElement("div");
      piece.className = "confetti";
      piece.style.left = Math.random() * 100 + "vw";

      const w = 6 + Math.random() * 8;
      const h = 10 + Math.random() * 10;
      piece.style.width = w + "px";
      piece.style.height = h + "px";

      const colors = ["#111", "#ff4d4d", "#ffd166", "#06d6a0", "#4d96ff", "#b5179e"];
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];

      const ms = 1200 + Math.random() * 1400;
      piece.style.animationDuration = ms + "ms";
      piece.style.animationDelay = Math.random() * 200 + "ms";
      piece.style.setProperty("--dx", Math.random() * 60 - 30 + "vw");
      piece.style.setProperty("--rot", Math.random() * 720 - 360 + "deg");

      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), ms + 500);
    }
  }

  const earned = ${earnedReward ? "true" : "false"};
window.addEventListener("load", () => {
  if (earned) launchConfetti();

  });

  // Redirect only if NOT earning a reward
  if (!earned) {
    setTimeout(() => {
      window.location.href = "/";
    }, 10000);
  }

  async function redeem() {
    const pin = prompt("Staff PIN");
    if (!pin) return;

    const res = await fetch("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });

    if (res.ok) {
      alert("Redeemed successfully ☕");
      location.reload();
    } else {
      alert("Invalid PIN");
    }
  }
</script>

        </head>
        <body>
          <div class="card">
          <img src="/logo.png" alt="Waters Edge" class="logo" />
            <h2>✅ Stamp added</h2>

            <div class="cups">${cups}</div>

            <p>${stamp_count} of ${totalStamps} coffees collected</p>

            ${
              free_available > 0
                ? `<div class="reward">🎉 Free drink available!</div>`
                : `<p>Only ${totalStamps - stamp_count} more to go ☕</p>`
            }
          </div>
        </body>
      </html>
      ${
  free_available > 0
    ? `
      <div class="reward">🎉 Free drink available!</div>
      <button class="redeem" onclick="redeem()">Redeem</button>
    `
    : `<p>Only ${totalStamps - stamp_count} more to go ☕</p>`
}

    `);
  } catch (err) {
    console.error("scan error:", err);
    return res.status(400).send("Scan failed");
  }
});
  
/** (Optional) keep POST /api/scan if you want a future in-app scanner.
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

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
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
