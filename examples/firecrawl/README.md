# FireCrawl RAG Example

This example demonstrates a complete RAG (Retrieval Augmented Generation) pipeline using:

- **@mendable/firecrawl-js** for crawling web pages
- **RAGmatic** for tracking and processing documents
- **Drizzle ORM** for database interactions
- **OpenAI** for embeddings and agentic RAG
- **llm-chunk** for chunking content
- **@inquirer/prompts** for CLI interface

## Features

- 🔍 Crawl any website and extract content
- 📥 Store web pages as markdown in PostgreSQL
- 🧠 Process and embed content with OpenAI embeddings
- 🔎 Vector search over crawled content
- 🤖 Answer questions using agentic RAG with source attribution
- 💻 Interactive CLI interface

## Setup

1. Clone this repository
2. Create a `.env` file based on `.env.example`
3. Install dependencies:

```bash
pnpm install
```

4. Start the PostgreSQL database:

```bash
pnpm run db:up
```

## Running the Example

Simply run:

```bash
pnpm start
```

The interactive CLI will guide you through:

1. Setting up the database
2. Crawling a website of your choice
3. Processing and embedding the content
4. Searching for information
5. Asking questions using RAG

## How It Works

1. The web crawler extracts content from pages and converts it to markdown
2. Content is stored in a PostgreSQL database table
3. RAGmatic processes documents and generates chunks
4. OpenAI creates embeddings for these chunks
5. Vector search finds relevant content for queries
6. OpenAI's tool usage creates answers with source attribution

## Advanced Features

- **Tool usage**: The RAG system uses OpenAI's function calling to analyze and cite sources
- **Background processing**: Worker runs in the background while you can interact with the system
- **Source attribution**: Answers include references to the specific chunks used
- **Interactive CLI**: Easy-to-use interface with Inquirer
