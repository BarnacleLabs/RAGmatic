import * as dotenv from "dotenv";
import { input, select, confirm } from "@inquirer/prompts";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { RAGmatic, ChunkData, EmbeddingData } from "ragmatic";
import { OpenAI } from "openai";
import { chunk } from "llm-chunk";
import FirecrawlApp from "@mendable/firecrawl-js";
import { sitePages, sitePagesChunks, SitePage } from "./schema";
import { eq, cosineDistance, desc, gt } from "drizzle-orm";

dotenv.config();

// Create Drizzle instance for database operations
const db = drizzle(process.env.DATABASE_URL!);

// Function to set up the database
async function setupDatabase() {
  console.log("Setting up database...");

  try {
    // Drop the table if it exists (for clean setup)
    await db.execute(sql`DROP TABLE IF EXISTS site_pages CASCADE`);

    // Create the site_pages table
    await db.execute(sql`
      CREATE TABLE site_pages (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        title TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    console.log("Site pages table created successfully");
  } catch (error) {
    console.error("Setup failed:", error);
    throw error;
  }
}

// Function to crawl a website
async function crawlSite(
  domain: string,
  limit: number,
  maxDepth: number,
  includePaths: string[],
  excludePaths: string[],
  allowExternalLinks: boolean,
  ignoreQueryParameters: boolean,
  onlyMainContent: boolean,
) {
  console.log(`Starting crawl of ${domain}...`);

  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY! });

  const res = await app.crawlUrl(domain, {
    limit,
    includePaths,
    excludePaths,
    maxDepth,
    allowBackwardLinks: false,
    allowExternalLinks,
    ignoreQueryParameters,
    scrapeOptions: {
      formats: ["markdown"],
      onlyMainContent,
    },
  });

  const pages = "data" in res ? res.data : [];

  if (!pages || pages.length === 0) {
    throw new Error("No pages found");
  }

  console.log(`Crawl complete! Found ${pages.length} pages.`);

  // Insert the pages into the database using our global Drizzle instance
  try {
    console.log("Storing pages in database...");
    for (const page of pages) {
      try {
        await db
          .insert(sitePages)
          .values({
            url: page.metadata?.url || "No URL",
            title: page.metadata?.title || "Untitled Page",
            content: page.markdown || "No content",
          })
          .onConflictDoUpdate({
            target: sitePages.url,
            set: {
              content: page.markdown || "No content",
              title: page.metadata?.title || "Untitled Page",
              updatedAt: new Date(),
            },
          });
        process.stdout.write(".");
      } catch (error) {
        console.error(`\nError storing page ${page.url}:`, error);
      }
    }
    console.log("\nAll pages stored successfully");
  } catch (error) {
    console.error("Error storing pages:", error);
    throw error;
  }

  return {
    pageCount: pages.length,
    urls: pages.map((page) => page.metadata?.url || "No URL"),
  };
}

// Function to start the worker for processing
async function startWorker() {
  console.log("Starting embedding worker...");

  // Initialize OpenAI client for embeddings
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Create worker
  // Set up RAGmatic with the site_pages table
  const ragmatic = await RAGmatic.create<SitePage>({
    name: "firecrawl",
    tableToWatch: "site_pages",
    embeddingDimension: 1536,
    connectionString: process.env.DATABASE_URL!,
    recordToChunksFunction: async (
      sitePage: SitePage,
    ): Promise<ChunkData[]> => {
      console.log(`Chunking page: ${sitePage.title}`);
      return chunk(sitePage.content, {
        minLength: 300,
        maxLength: 1000,
        overlap: 50,
        splitter: "paragraph",
      }).map((chunkText, index) => {
        return {
          text: chunkText,
          metadata: {
            title: sitePage.title,
            url: sitePage.url,
            index: index,
          },
        };
      });
    },
    chunkToEmbeddingFunction: async (
      chunk: ChunkData,
    ): Promise<EmbeddingData> => {
      // Create embedding using OpenAI
      const response = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: chunk.text,
      });
      console.log(`Generated embedding for: ${chunk.text.substring(0, 30)}...`);
      return {
        embedding: response.data[0].embedding,
        text: chunk.text,
        json: chunk.metadata,
      };
    },
  });

  // Start the worker
  await ragmatic.start();
  console.log("Worker started - processing embeddings in background");

  return ragmatic;
}

// Function to search for similar content
async function similarSearch(query: string, topK: number = 5) {
  console.log(`Searching for: ${query}`);

  // Generate embedding for the query
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: query,
  });
  const embedding = response.data[0].embedding;

  // Perform vector search
  try {
    const similarity = sql<number>`
      1 - (${cosineDistance(sitePagesChunks.embedding, embedding)})
    `;

    const results = await db
      .select({
        similarity,
        chunkText: sitePagesChunks.chunkText,
        metadata: sitePagesChunks.chunkJson,
        url: sitePages.url,
        title: sitePages.title,
      })
      .from(sitePagesChunks)
      .leftJoin(sitePages, eq(sitePagesChunks.docId, sitePages.id))
      .where(gt(similarity, 0.7))
      .orderBy(desc(similarity))
      .limit(topK);

    return results;
  } catch (error) {
    console.error("Search error:", error);
    throw error;
  }
}

// Function to perform agentic RAG with tool usage
async function agenticRag(query: string) {
  console.log(`Getting answer for: ${query}`);

  // Find relevant chunks first
  const chunks = await similarSearch(query, 5);
  console.log(`Found ${chunks.length} relevant chunks`);

  if (chunks.length === 0) {
    return {
      answer:
        "I couldn't find any relevant information to answer your question.",
      chunks: [],
    };
  }

  // Prepare context from chunks
  const context = chunks
    .map(
      (chunk, i) =>
        `[${i + 1}] ${chunk.chunkText}\nSource: ${chunk.title} (${chunk.url})`,
    )
    .join("\n\n");

  // Create OpenAI client
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Call OpenAI with tool usage for agentic RAG
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are a helpful assistant that answers questions based on the provided context. 
        When answering, cite your sources using the reference numbers provided in brackets [1], [2], etc.
        If the information to answer the question is not in the context, say so.
        Always reference the exact sources you used from the provided context.`,
      },
      {
        role: "user",
        content: `Context:\n${context}\n\nQuestion: ${query}`,
      },
    ],
    temperature: 0.7,
    tools: [
      {
        type: "function",
        function: {
          name: "analyze_sources",
          description:
            "Analyze which sources were most useful for answering the question",
          parameters: {
            type: "object",
            properties: {
              useful_sources: {
                type: "array",
                items: {
                  type: "integer",
                },
                description:
                  "Array of source reference numbers (1-indexed) that were useful",
              },
              reasoning: {
                type: "string",
                description:
                  "Brief explanation of why these sources were useful",
              },
            },
            required: ["useful_sources", "reasoning"],
          },
        },
      },
    ],
    tool_choice: "auto",
  });

  // Extract the main answer
  const answer = completion.choices[0].message.content || "No answer generated";

  // Get tool calls for source analysis
  let sourceAnalysis = null;
  if (
    completion.choices[0].message.tool_calls &&
    completion.choices[0].message.tool_calls.length > 0
  ) {
    try {
      const toolCall = completion.choices[0].message.tool_calls[0];
      if (toolCall.function.name === "analyze_sources") {
        sourceAnalysis = JSON.parse(toolCall.function.arguments);
      }
    } catch (error) {
      console.error("Error parsing tool call:", error);
    }
  }

  // Only return chunks that were actually used
  let usedChunks = chunks;
  if (
    sourceAnalysis &&
    sourceAnalysis.useful_sources &&
    sourceAnalysis.useful_sources.length > 0
  ) {
    usedChunks = sourceAnalysis.useful_sources
      .filter((idx: number) => idx >= 1 && idx <= chunks.length)
      .map((idx: number) => chunks[idx - 1]);
  }

  return {
    answer,
    chunks: usedChunks,
    analysis: sourceAnalysis,
  };
}

// Main function to run the CLI
async function main() {
  console.log("🔥 FireCrawl RAG Example 🔥");
  console.log("---------------------------");

  // Check if .env variables are set
  if (!process.env.DATABASE_URL) {
    console.error("Error: DATABASE_URL not set in .env file");
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY not set in .env file");
    process.exit(1);
  }

  if (!process.env.FIRECRAWL_API_KEY) {
    console.error("Error: FIRECRAWL_API_KEY not set in .env file");
    process.exit(1);
  }

  try {
    // First step: Setup database
    // Check if the site_pages table exists and if not, setup the database
    const tableExists = await db.execute(sql`
      SELECT
        EXISTS (
          SELECT
            1
          FROM
            information_schema.tables
          WHERE
            table_name = 'site_pages'
        )
    `);

    if (!tableExists) {
      await setupDatabase();
    } else {
      // check if the site_pages table exists
      const shouldSetup = await confirm({
        message: "Do you want to clear the existing data and start over?",
        default: false,
      });

      if (shouldSetup) {
        await setupDatabase();
      }
    }

    // Second step: Crawl website
    const domain = await input({
      message: "Enter the website domain to crawl (e.g., example.com):",
      default: "https://www.bbc.com",
      validate: (value) => {
        const url = new URL(value);
        return url.hostname ? true : "Please enter a valid URL";
      },
    });

    const setAdvancedCrawlOptions = await confirm({
      message: "Do you want to set advanced crawl options?",
      default: false,
    });

    let limit = 2;
    let maxDepth = 2;
    let includePaths: string[] = [];
    let excludePaths: string[] = [];
    let allowExternalLinks = false;
    let ignoreQueryParameters = false;
    let onlyMainContent = true;

    if (setAdvancedCrawlOptions) {
      maxDepth = parseInt(
        await input({
          message: "Enter the maximum depth of the crawl",
          default: "2",
          validate: (value) => {
            const num = parseInt(value);
            return !isNaN(num) && num > 0
              ? true
              : "Please enter a valid number";
          },
        }),
      );

      limit =
        parseInt(
          await input({
            message: "How many pages do you want to crawl max?",
            default: "2",
            validate: (value) => {
              const num = parseInt(value);
              return !isNaN(num) && num > 2
                ? true
                : "Please enter a valid number (min 2)";
            },
          }),
        ) - 1;

      includePaths = (
        await input({
          message:
            "Enter the paths to include in the crawl (comma-separated, e.g., /path1,/path2) or leave empty for all",
          default: "",
        })
      ).split(",");

      excludePaths = (
        await input({
          message:
            "Enter the paths to exclude from the crawl (comma-separated, e.g., /path1,/path2) or leave empty for none",
          default: "",
        })
      ).split(",");

      allowExternalLinks = await confirm({
        message: "Follow external links?",
        default: false,
      });

      ignoreQueryParameters = await confirm({
        message: "Ignore query parameters?",
        default: false,
      });

      onlyMainContent = await confirm({
        message: "Only the main content?",
        default: true,
      });
    }

    const { pageCount, urls } = await crawlSite(
      domain,
      limit,
      maxDepth,
      includePaths,
      excludePaths,
      allowExternalLinks,
      ignoreQueryParameters,
      onlyMainContent,
    );
    console.log(
      `Successfully stored ${pageCount} pages from ${domain}: ${urls.join(", ")}`,
    );

    // Third step: Start worker for embedding generation
    console.log("Now we need to process the pages to generate embeddings...");
    const worker = await startWorker();

    console.log("Processing pages in the background...");

    // Wait a bit for the worker to start processing
    await new Promise((resolve) => setTimeout(resolve, 8000));

    let isProcessing = true;
    while (isProcessing) {
      const action = await select({
        message: "What would you like to do?",
        choices: [
          { name: "Check processing status", value: "status" },
          { name: "Search for information", value: "search" },
          { name: "Ask a question (RAG)", value: "rag" },
          { name: "Exit", value: "exit" },
        ],
      });

      switch (action) {
        case "status": {
          // Count pages and chunks using our global Drizzle instance
          const pageCount = await db
            .select({ count: sql<number>`count(*)` })
            .from(sitePages);

          const chunkCount = await db
            .select({ count: sql<number>`count(*)` })
            .from(sitePagesChunks);

          console.log(
            `Status: ${pageCount[0].count} pages crawled, ${chunkCount[0].count} chunks processed`,
          );
          break;
        }

        case "search": {
          const searchQuery = await input({
            message: "Enter your search query:",
          });

          const results = await similarSearch(searchQuery);

          if (results.length === 0) {
            console.log(
              "No results found. Try a different query or wait for more pages to be processed.",
            );
          } else {
            console.log("\nSearch Results:");
            console.log("---------------");

            results.forEach((result, i) => {
              console.log(
                `\n[Result ${i + 1}] Similarity: ${(result.similarity * 100).toFixed(2)}%`,
              );
              console.log(`Title: ${result.title}`);
              console.log(`URL: ${result.url}`);
              console.log(`Excerpt: ${result.chunkText?.substring(0, 150)}...`);
            });
          }
          break;
        }

        case "rag": {
          const question = await input({
            message: "Enter your question:",
          });

          const result = await agenticRag(question);

          console.log("\n🤖 Answer:");
          console.log("---------");
          console.log(result.answer);

          if (result.analysis) {
            console.log("\n📊 Source Analysis:");
            console.log("------------------");
            console.log(
              `Used sources: ${result.analysis.useful_sources.join(", ")}`,
            );
            console.log(`Reasoning: ${result.analysis.reasoning}`);
          }

          console.log("\n📑 Referenced Sources:");
          console.log("---------------------");
          result.chunks.forEach((chunk, i) => {
            console.log(`\n[Source ${i + 1}]`);
            console.log(`From: ${chunk.title} (${chunk.url})`);
            console.log(`Content: ${chunk.chunkText?.substring(100, 400)}...`);
          });
          break;
        }

        case "exit": {
          isProcessing = false;
          await worker.stop();
          console.log("Paused worker. Exiting...");
          break;
        }
      }
    }
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

// Handle interrupt signals (CTRL+C/CMD+C)
process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT (CTRL+C). Shutting down gracefully...");
  console.log("Exiting...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM. Shutting down gracefully...");
  console.log("Exiting...");
  process.exit(0);
});

// Run the main function
main().catch(console.error);
