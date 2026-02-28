import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock chalk to return plain strings for easy assertion
vi.mock("chalk", () => {
  const handler: ProxyHandler<object> = {
    get: (_target, _prop) => (str: string) => str,
    apply: (_target, _thisArg, args) => args[0],
  };
  const chainable = new Proxy(() => {}, handler);
  return {
    default: new Proxy(
      {},
      {
        get: () => chainable,
      },
    ),
  };
});

// Mock ora
vi.mock("ora", () => ({
  default: vi.fn((opts: { text: string; prefixText: string }) => ({
    text: opts.text,
    prefixText: opts.prefixText,
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { logger } from "../logger.js";

describe("logger (unit)", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tableSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tableSpy = vi.spyOn(console, "table").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["COVERIT_DEBUG"];
  });

  describe("debug", () => {
    it("should not output when COVERIT_DEBUG is not set", () => {
      delete process.env["COVERIT_DEBUG"];
      logger.debug("test message");
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it("should output when COVERIT_DEBUG is 1", () => {
      process.env["COVERIT_DEBUG"] = "1";
      logger.debug("test message");
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.any(String),
        "test message",
      );
    });

    it("should not output when COVERIT_DEBUG is a non-1 value", () => {
      process.env["COVERIT_DEBUG"] = "true";
      logger.debug("test message");
      expect(debugSpy).not.toHaveBeenCalled();
    });
  });

  describe("info", () => {
    it("should log to console.log with the message", () => {
      logger.info("hello info");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.any(String), "hello info");
    });
  });

  describe("warn", () => {
    it("should log to console.warn with the message", () => {
      logger.warn("warning!");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.any(String), "warning!");
    });
  });

  describe("error", () => {
    it("should log to console.error with the message", () => {
      logger.error("something failed");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        "something failed",
      );
    });
  });

  describe("success", () => {
    it("should log to console.log with a success message", () => {
      logger.success("done!");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(expect.any(String), "done!");
    });
  });

  describe("spinner", () => {
    it("should return a started spinner with the given text", () => {
      const spinner = logger.spinner("Loading...");
      expect(spinner).toBeDefined();
      expect(spinner.text).toBe("Loading...");
      expect(spinner.start).toHaveBeenCalled();
    });
  });

  describe("table", () => {
    it("should call console.table when given an array", () => {
      const data = [{ a: 1 }, { a: 2 }];
      logger.table(data);
      expect(tableSpy).toHaveBeenCalledWith(data);
    });

    it("should format key-value pairs when given an object", () => {
      const data = { name: "coverit", version: "1.0" };
      logger.table(data);
      // Should call console.log once per entry
      expect(logSpy).toHaveBeenCalledTimes(2);
    });
  });
});
