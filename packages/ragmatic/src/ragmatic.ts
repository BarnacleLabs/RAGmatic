import { setup } from "./dbSetup";
import { Worker } from "./worker";
import {
  destroyTracker,
  reprocessDocuments,
  countRemainingDocuments,
} from "./trackerUtils";
import { DBClient, RAGmaticConfig, RAGmatic as RAGmaticI } from "./types";

export class RAGmatic<T> implements RAGmaticI<T> {
  // create singleton instances per tracker name
  private static instances: Map<string, RAGmaticI<any>> = new Map();

  private worker: Worker<T>;
  private name: string;
  private connectionString: string | undefined;
  private dbClient: DBClient | undefined;

  private constructor(
    worker: Worker<T>,
    name: string,
    connectionString: string | undefined,
    dbClient: DBClient | undefined,
  ) {
    // private constructor, only used by static create
    this.worker = worker;
    this.name = name;
    this.connectionString = connectionString;
    this.dbClient = dbClient;
  }

  static async create<T>(config: RAGmaticConfig<T>): Promise<RAGmatic<T>> {
    if (RAGmatic.instances.has(config.name)) {
      return RAGmatic.instances.get(config.name) as RAGmatic<T>;
    }
    await setup({
      connectionString: config.connectionString,
      dbClient: config.dbClient,
      trackerName: config.name,
      documentsTable: config.tableToWatch,
      docIdType: config.docIdType,
      embeddingDimension: config.embeddingDimension,
      skipEmbeddingIndexSetup: config.skipEmbeddingIndexSetup,
      logger: config.logger,
    });
    const worker = new Worker<T>({
      connectionString: config.connectionString,
      dbClient: config.dbClient,
      trackerName: config.name,
      chunkGenerator: config.transformDocumentToChunks,
      hashFunction: config.hashFunction,
      embeddingGenerator: config.embedChunk,
      pollingIntervalMs: config.pollingIntervalMs,
      batchSize: config.batchSize,
      maxRetries: config.maxRetries,
      initialRetryDelayMs: config.initialRetryDelayMs,
      stalledJobTimeoutMinutes: config.stalledJobTimeoutMinutes,
      logger: config.logger,
    });
    const ragmatic = new RAGmatic(
      worker,
      config.name,
      config.connectionString,
      config.dbClient,
    );
    RAGmatic.instances.set(config.name, ragmatic);
    return ragmatic;
  }

  async destroy() {
    await destroyTracker(
      this.connectionString ?? (this.dbClient as DBClient),
      this.name,
    );
    RAGmatic.instances.delete(this.name);
  }

  async start() {
    return await this.worker.start();
  }

  async stop() {
    return await this.worker.stop();
  }

  async reprocessAll() {
    return await reprocessDocuments(
      this.connectionString ?? (this.dbClient as DBClient),
      this.name,
    );
  }

  async countRemainingDocuments() {
    return countRemainingDocuments(
      this.connectionString ?? (this.dbClient as DBClient),
      this.name,
    );
  }
}

export default RAGmatic;
