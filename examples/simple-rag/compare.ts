import OpenAI from "openai";
import { drizzle } from "drizzle-orm/node-postgres";
import { cosineDistance, desc, eq, gt, sql } from "drizzle-orm";
import { movies } from "./db/schema";
import { moviesChunks } from "./pipelines/openai/ragmatic.schema";
import { moviesChunks as moviesChunksHyde } from "./pipelines/openai-hyde/ragmatic.schema";
import * as dotenv from "dotenv";

dotenv.config();

export const generateEmbedding = async (input: string): Promise<number[]> => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const { data } = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: input.replaceAll("\n", " "),
  });
  return data[0].embedding;
};

const db = drizzle(process.env.DATABASE_URL!);

const findSimilarMovies = async (
  chunksTable: typeof moviesChunks | typeof moviesChunksHyde,
  queryEmbedding: number[],
  topK: number = 4,
) => {
  const similarity = sql<number>`
    1 - (${cosineDistance(chunksTable.embedding, queryEmbedding)})
  `;
  // You don't need to left join the movies table,
  // but if you do you can eg. get the year of the movie or filter on it
  const similarMovies = await db
    .select({
      similarity,
      chunk: chunksTable.chunkText,
      metadata: chunksTable.chunkJson,
      docId: chunksTable.docId,
      title: movies.title,
      year: movies.year,
    })
    .from(chunksTable)
    .leftJoin(movies, eq(chunksTable.docId, movies.id))
    .where(gt(similarity, 0.2))
    .orderBy((t) => desc(t.similarity))
    .limit(topK);
  return similarMovies;
};

// Get user input from command line
const query = process.argv[2] || "a black and white movie about a trial";
const queryEmbedding = await generateEmbedding(query);

// Compare the results of the two pipelines
const similarMovies = await findSimilarMovies(moviesChunks, queryEmbedding);
console.log(`Similar movies to "${query}" (OpenAI):`, similarMovies);

const similarMoviesHyde = await findSimilarMovies(
  moviesChunksHyde,
  queryEmbedding,
);
console.log(`Similar movies to "${query}" (OpenAI-Hyde):`, similarMoviesHyde);

process.exit(0);
