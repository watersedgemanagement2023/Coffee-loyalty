import pkg from "pg";
const { Pool } = pkg;

// 1️⃣ Create & export the database pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Supabase on Render
});

// 2️⃣ Initialise tables
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      stamp_count INTEGER NOT NULL DEFAULT 0,
      free_available INTEGER NOT NULL DEFAULT 0,
      last_scan_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scans (
      id SERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      scanned_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS redemptions (
      id SERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      redeemed_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

// 3️⃣ Get or create customer (THIS FIXES THE CRASH)
export async function getOrCreateCustomer(customerId) {
  const { rows } = await pool.query(
    `SELECT * FROM customers WHERE id = $1`,
    [customerId]
  );

  if (rows.length > 0) {
    return rows[0];
  }

  const insert = await pool.query(
    `INSERT INTO customers (id)
     VALUES ($1)
     RETURNING *`,
    [customerId]
  );

  return insert.rows[0];
}

