import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      stamp_count INTEGER NOT NULL DEFAULT 0,
      free_available INTEGER NOT NULL DEFAULT 0,
      last_scan_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS scans (
      id SERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      scanned_at TIMESTAMPTZ DEFAULT now()
    );

    await pool.query(`
  CREATE TABLE IF NOT EXISTS redemptions (
    id bigserial PRIMARY KEY,
    customer_id text NOT NULL,
    store_id text NOT NULL,
    redeemed_at timestamptz NOT NULL DEFAULT now()
  );
  `);
}

export async function getOrCreateCustomer(id) {
  const { rows } = await pool.query(
    "SELECT * FROM customers WHERE id=$1",
    [id]
  );

  if (rows.length) return rows[0];

  await pool.query(
    "INSERT INTO customers (id) VALUES ($1)",
    [id]
  );

  const res = await pool.query(
    "SELECT * FROM customers WHERE id=$1",
    [id]
  );
  return res.rows[0];
}
