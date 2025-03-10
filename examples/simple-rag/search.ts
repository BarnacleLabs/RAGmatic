import OpenAI from "openai";
import { drizzle } from "drizzle-orm/node-postgres";
import { cosineDistance, desc, eq, gt, sql, inArray } from "drizzle-orm";
import { movies, moviesChunks } from "./schema";
import * as dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export const generateEmbedding = async (value: string): Promise<number[]> => {
  const input = value.replaceAll("\n", " ");
  const { data } = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input,
  });
  return data[0].embedding;
};

const db = drizzle(process.env.PG_CONNECTION_STRING!);

const findSimilarMovies = async (description: string) => {
  const embedding = await generateEmbedding(description);
  const similarity = sql<number>`
    1 - (${cosineDistance(moviesChunks.embedding, embedding)})
  `;
  // We left join the movies table to get the title and year of the movie
  // this means you can also implement hybrid rag very easily eg.: by filtering on the years for example
  const similarMovies = await db
    .select({
      similarity,
      chunk: moviesChunks.chunkText,
      docId: moviesChunks.docId,
      title: movies.title,
      year: movies.year,
    })
    .from(moviesChunks)
    .leftJoin(movies, eq(moviesChunks.docId, movies.id))
    .where(gt(similarity, 0.5))
    .orderBy((t) => desc(t.similarity))
    .limit(4);
  return similarMovies;
};

// Get user input from command line
const description = process.argv[2] || "A movie about a man who is a superhero";
const similarMovies = await findSimilarMovies(description);
console.log(similarMovies);

process.exit(0);
