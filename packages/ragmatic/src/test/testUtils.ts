import { createLogger } from "../utils/logger";

/**
 * Creates a silent logger for use in tests
 *
 * This logger only shows error level logs and nothing else,
 * which helps reduce noise during test runs.
 */
export const createTestLogger = () => {
  return createLogger({
    level: "error",
    service: "test",
  });
};
