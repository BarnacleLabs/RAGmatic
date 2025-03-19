import * as dotenv from "dotenv";
import { searchWithOpenAI } from "./pipelines/openai/search";
import { searchWithOpenAIHyde } from "./pipelines/openai-hyde/search";
import { searchWithCohere } from "./pipelines/cohere/search";
import { searchWithOllama } from "./pipelines/ollama/search";

dotenv.config();

// Get user input from command line
const query = process.argv[2] || "a black and white movie about a trial";

const compareSearchResults = async () => {
  // Run all searches in parallel for efficiency
  const [openaiResult, hydeResult, cohereResult, ollamaResult] =
    await Promise.all([
      searchWithOpenAI({ query }),
      searchWithOpenAIHyde({ query }),
      searchWithCohere({ query }),
      searchWithOllama({ query }),
    ]);

  // Display results
  if (openaiResult.success) {
    console.log(
      `\nSimilar movies to "${query}" (OpenAI):`,
      openaiResult.results,
    );
  }

  if (hydeResult.success) {
    console.log(
      `\nSimilar movies to "${query}" (OpenAI-Hyde):`,
      hydeResult.results,
    );
  }

  if (cohereResult.success) {
    console.log(
      `\nSimilar movies to "${query}" (Cohere):`,
      cohereResult.results,
    );
  }

  if (ollamaResult.success) {
    console.log(
      `\nSimilar movies to "${query}" (Ollama/Nomic):`,
      ollamaResult.results,
    );
  }

  // Handle case where no pipelines are available
  if (
    !openaiResult.success &&
    !hydeResult.success &&
    !cohereResult.success &&
    !ollamaResult.success
  ) {
    console.log(
      "\nNo embedding pipelines have been run yet. Please run at least one of:",
    );
    console.log("- npm run openai");
    console.log("- npm run openai-hyde");
    console.log("- npm run cohere");
    console.log("- npm run ollama");
  }
};

compareSearchResults()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error comparing search results:", error);
    process.exit(1);
  });
