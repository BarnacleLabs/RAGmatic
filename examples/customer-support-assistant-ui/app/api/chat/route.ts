import { openai } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool } from "ai";
import searchFaqs from "@/embeddings/search";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages, system, tools } = await req.json();

  const result = streamText({
    model: openai("gpt-4o-mini"),
    messages,
    // forward system prompt and tools from the frontend
    // system,
    system: `You are a helpful assistant. Check your knowledge base before answering any questions.
    Only respond to questions using information from tool calls.
    Cite the title of the source in your response.
    If no relevant information is found in the tool calls, respond, "Sorry, I don't know."`,
    tools: {
      getInformation: tool({
        description: `get information from your knowledge base to answer questions.`,
        parameters: z.object({
          question: z.string().describe("the users question"),
        }),
        execute: async ({ question }) => searchFaqs(question),
      }),
    },
    maxSteps: 10,
  });

  return result.toDataStreamResponse();
}
