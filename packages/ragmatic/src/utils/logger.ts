// Define our own simple logger interface to avoid dependency on Winston types
export interface Logger {
  error(message: string, meta?: Record<string, any>): void;
  warn(message: string, meta?: Record<string, any>): void;
  info(message: string, meta?: Record<string, any>): void;
  debug(message: string, meta?: Record<string, any>): void;
}

export interface LoggerConfig {
  level?: "error" | "warn" | "info" | "debug" | "trace";
  format?: "json" | "text";
  service?: string;
  trackerName?: string;
  silent?: boolean;
}

// Default log level if not specified
const DEFAULT_LOG_LEVEL = "info";

/**
 * Creates a configurable logger for RAGmatic
 *
 * @param config Configuration for the logger
 * @returns Logger instance
 */
export function createLogger(config: LoggerConfig = {}): Logger {
  try {
    // Dynamically import winston - this prevents type issues
    // while still providing the rich functionality when available
    const winston = require("winston");

    const level =
      config.level || process.env.RAGMATIC_LOG_LEVEL || DEFAULT_LOG_LEVEL;
    const isJson =
      (config.format || process.env.RAGMATIC_LOG_FORMAT || "text") === "json";
    const service = config.service || config.trackerName || "ragmatic";
    const silent = config.silent || process.env.RAGMATIC_LOG_SILENT === "true";

    // Custom format for human-readable logs
    const textFormat = winston.format.printf(
      ({ level, message, timestamp, ...rest }: any) => {
        const meta = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
        return `${timestamp} [${level.toUpperCase()}] [${service}]: ${message}${meta}`;
      },
    );

    return winston.createLogger({
      level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        isJson ? winston.format.json() : textFormat,
      ),
      defaultMeta: { service },
      silent,
      transports: [new winston.transports.Console()],
    });
  } catch (error) {
    // Fallback console logger if winston is not available
    const logLevels = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
    const selectedLevel =
      config.level || process.env.RAGMATIC_LOG_LEVEL || DEFAULT_LOG_LEVEL;
    const levelValue = logLevels[selectedLevel as keyof typeof logLevels] || 2;
    const silent = config.silent || process.env.RAGMATIC_LOG_SILENT === "true";

    const service = config.service || config.trackerName || "ragmatic";

    if (silent) {
      return {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
      };
    }

    return {
      error: (message: string, meta?: Record<string, any>) => {
        if (levelValue >= 0)
          console.error(`[ERROR] [${service}]: ${message}`, meta || "");
      },
      warn: (message: string, meta?: Record<string, any>) => {
        if (levelValue >= 1)
          console.warn(`[WARN] [${service}]: ${message}`, meta || "");
      },
      info: (message: string, meta?: Record<string, any>) => {
        if (levelValue >= 2)
          console.info(`[INFO] [${service}]: ${message}`, meta || "");
      },
      debug: (message: string, meta?: Record<string, any>) => {
        if (levelValue >= 3)
          console.debug(`[DEBUG] [${service}]: ${message}`, meta || "");
      },
    };
  }
}

// Default logger instance
export const logger = createLogger();
