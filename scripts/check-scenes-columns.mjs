import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

async function main() {
  const rows = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'scenes' ORDER BY ordinal_position`;
  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});