const pg = require("pg");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pool = new pg.Pool({
  connectionString: `postgres://localhost:5432/template1`,
});
pool.on("error", () => {});
pool.on("connect", (client) => {
  client.on("error", () => {});
});

async function main() {
  console.log("Waiting for postgres...");
  for (let n = 1; n < 30; n++) {
    try {
      const client = await pool.connect();
      const result = await client.query("select 1");
      client.release();
      break;
    } catch (e) {
      const delay = 100 * n;
      console.log(`Connection failed: ${e}; trying again in ${delay}ms`);
      // try again
      await sleep(delay);
    }
  }
  console.log("Connection successful");
  pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
