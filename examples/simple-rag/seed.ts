import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
// @ts-ignore
import pg from "pg";
import * as dotenv from "dotenv";
import { movies } from "./schema";

dotenv.config();

interface Movie {
  title: string;
  year: number;
  description: string;
}

const moviesSeed: Movie[] = [
  {
    title: "The Shawshank Redemption",
    year: 1994,
    description:
      "Over the course of several years, two convicts form a friendship, seeking consolation and, eventually, redemption through basic compassion.",
  },
  {
    title: "The Godfather",
    year: 1972,
    description:
      "The aging patriarch of an organized crime dynasty in postwar New York City transfers control of his clandestine empire to his reluctant youngest son.",
  },
  {
    title: "The Dark Knight",
    year: 2008,
    description:
      "When the menace known as the Joker wreaks havoc and chaos on the people of Gotham, Batman must accept one of the greatest psychological and physical tests of his ability to fight injustice.",
  },
  {
    title: "The Godfather Part II",
    year: 1974,
    description:
      "The early life and career of Vito Corleone in 1920s New York City is portrayed, while his son, Michael, expands and tightens his grip on the family crime syndicate.",
  },
  {
    title: "12 Angry Men",
    year: 1957,
    description:
      "The jury in a New York City murder trial is frustrated by a single member whose skeptical caution forces them to more carefully consider the evidence before jumping to a hasty verdict.",
  },
  {
    title: "Schindler's List",
    year: 1993,
    description:
      "In German-occupied Poland during World War II, industrialist Oskar Schindler gradually becomes concerned for his Jewish workforce after witnessing their persecution by the Nazis.",
  },
  {
    title: "The Lord of the Rings: The Return of the King",
    year: 2003,
    description:
      "Gandalf and Aragorn lead the World of Men against Sauron's army to draw his gaze from Frodo and Sam as they approach Mount Doom with the One Ring.",
  },
  {
    title: "Pulp Fiction",
    year: 1994,
    description:
      "The lives of two mob hitmen, a boxer, a gangster and his wife, and a pair of diner bandits intertwine in four tales of violence and redemption.",
  },
  {
    title: "The Lord of the Rings: The Fellowship of the Ring",
    year: 2001,
    description:
      "A meek Hobbit from the Shire and eight companions set out on a journey to destroy the powerful One Ring and save Middle-earth from the Dark Lord Sauron.",
  },
  {
    title: "The Good, the Bad and the Ugly",
    year: 1966,
    description:
      "A bounty hunting scam joins two men in an uneasy alliance against a third in a race to find a fortune in gold buried in a remote cemetery.",
  },
];

async function main() {
  const dbClient = new pg.Client({
    connectionString: process.env.PG_CONNECTION_STRING,
  });

  await dbClient.connect();
  const db = drizzle(dbClient);

  // Drop the table if it exists
  await db.execute(sql`DROP TABLE IF EXISTS movies CASCADE`);

  // Create the table
  await db.execute(sql`
    CREATE TABLE movies (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      YEAR INTEGER NOT NULL,
      description TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Insert the movies
  await db.insert(movies).values(
    moviesSeed.map((movie) => ({
      title: movie.title,
      year: movie.year,
      description: movie.description,
    })),
  );

  await dbClient.end();
}

main()
  .then(() => {
    console.log("Movies inserted");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
