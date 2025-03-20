import { moviesChunks } from "./ragmatic.schema";
import { movies } from "../../db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { cosineDistance, desc, eq, gt, sql } from "drizzle-orm";
import { CohereClient } from "cohere-ai";
import * as dotenv from "dotenv";

dotenv.config();

// Database connection
const db = drizzle(process.env.DATABASE_URL!);

// Interface for search results
export interface SearchResult {
  similarity: number;
  chunk: string;
  metadata: any;
  docId: number;
  title: string | null;
  year: number | null;
}

// Search options
export interface CohereSearchOptions {
  query: string;
  topK?: number;
}

// Cohere-specific embedding generator
const generateEmbedding = async (input: string): Promise<number[]> => {
  try {
    const cohere = new CohereClient({
      token: process.env.COHERE_API_KEY!,
    });

    const response = await cohere.embed({
      texts: [input.replaceAll("\n", " ")],
      model: "embed-english-v3.0",
      inputType: "search_query",
    });

    return (response.embeddings as number[][])[0];
  } catch (error) {
    console.error(
      "\nError generating Cohere embedding. Check your Cohere API key.",
    );
    return [];
  }
};

// Check if the pipeline table exists and has records
const checkPipelineExists = async (): Promise<boolean> => {
  try {
    const count = await db
      .select({ count: sql<number>`count(*)` })
      .from(moviesChunks)
      .then((result) => Number(result[0].count))
      .catch(() => 0);

    return count > 0;
  } catch (error) {
    return false;
  }
};

// Find similar movies using Cohere embeddings
const findSimilarMovies = async (
  queryEmbedding: number[],
  topK: number = 4,
): Promise<SearchResult[]> => {
  const similarity = sql<number>`
    1 - (${cosineDistance(moviesChunks.embedding, queryEmbedding)})
  `;

  const similarMovies = await db
    .select({
      similarity,
      chunk: moviesChunks.chunkText,
      metadata: moviesChunks.chunkJson,
      docId: moviesChunks.docId,
      title: movies.title,
      year: movies.year,
    })
    .from(moviesChunks)
    .leftJoin(movies, eq(moviesChunks.docId, movies.id))
    .where(gt(similarity, 0.2))
    .orderBy((t) => desc(t.similarity))
    .limit(topK);

  return similarMovies;
};

// Main search function
export const searchWithCohere = async (
  options: CohereSearchOptions,
): Promise<{ results: SearchResult[]; success: boolean }> => {
  const { query, topK = 4 } = options;

  try {
    // Check if pipeline exists
    const exists = await checkPipelineExists();
    if (!exists) {
      console.log(
        "\nCohere pipeline has not been run yet or has no embeddings. Run: npm run cohere",
      );
      return { results: [], success: false };
    }

    // Generate embedding
    const embedding = await generateEmbedding(query);
    if (embedding.length === 0) {
      return { results: [], success: false };
    }

    // Search using embedding
    const results = await findSimilarMovies(embedding, topK);
    return { results, success: true };
  } catch (error) {
    console.error("\nError searching with Cohere:", error);
    return { results: [], success: false };
  }
};
