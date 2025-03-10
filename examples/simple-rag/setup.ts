import { setup } from "ragmatic";
import * as dotenv from "dotenv";

dotenv.config();

async function setupDb() {
  await setup({
    connectionString: process.env.PG_CONNECTION_STRING!,
    documentsTable: "movies",
    trackerName: "default",
    embeddingDimension: 1536,
  });
}

setupDb()
  .then(() => {
    console.log("Database setup complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
