import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createServer, startHttpMcpServer } from "../src/main/mcp-server.js";

async function connectMcpServer() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ appDataRoot: "unused-test-data" });
  const client = new Client({ name: "desktop-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("desktop MCP resident-loader tools", () => {
  it("advertises explicit upload and lifecycle tools", async () => {
    const { client, server } = await connectMcpServer();
    try {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        "flash_device",
        "flash_device_ota",
        "enter_bootloader",
        "resume_application",
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  describe("desktop MCP HTTP sessions", () => {
    it("supports simultaneous clients and reconnects after a client closes", async () => {
      const server = await startHttpMcpServer(0);
      const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
      const clients: Client[] = [];
      async function connect() {
        const client = new Client({ name: "http-session-test", version: "1.0.0" });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(url));
        return client;
      }

      try {
        const [first, second] = await Promise.all([connect(), connect()]);
        expect((await first.listTools()).tools.some((tool) => tool.name === "flash_device")).toBe(true);
        await first.close();
        expect((await second.listTools()).tools.some((tool) => tool.name === "resume_application")).toBe(true);
        const third = await connect();
        expect((await third.listTools()).tools.some((tool) => tool.name === "enter_bootloader")).toBe(true);
        const unknownSession = await fetch(url, { headers: { "mcp-session-id": "unknown" } });
        expect(unknownSession.status).toBe(404);
      } finally {
        await Promise.all(clients.map((client) => client.close()));
        await server.close();
      }
    });
  });

  it("rejects caller-supplied flash addresses before reading an image or opening a port", async () => {
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "flash_device",
        arguments: {
          device_type: "esp32",
          file_path: "missing-image.bin",
          address: "0x0",
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Caller-supplied flash addresses are unsupported"),
      }));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports a lost handoff reply when the loader is subsequently confirmed", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("FPGA Companion - Network Recovery"))
      .mockRejectedValueOnce(new DOMException("request timed out", "AbortError"))
      .mockResolvedValueOnce(new Response("Papilio ESP Bootloader"));
    vi.stubGlobal("fetch", fetch);
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "enter_bootloader",
        arguments: { transport: "http", ip: "192.0.2.1" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"handoffWarning": "Handoff response was not received: request timed out."'),
      }));
      expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllGlobals();
    }
  });

  it("reports an unacknowledged resume only after the application is observed", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Papilio ESP Bootloader"))
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockResolvedValueOnce(new Response("FPGA Companion - Network Recovery"));
    vi.stubGlobal("fetch", fetch);
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "resume_application",
        arguments: { transport: "http", ip: "192.0.2.1" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({
        text: expect.stringMatching(/"resumeAcknowledged": false[\s\S]*"resumeWarning":[\s\S]*"bootObserved": true/),
      }));
      expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllGlobals();
    }
  });

  it("retains upload acknowledgement when a lost resume reply is followed by application boot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "papilio-resume-test-"));
    const image = path.join(directory, "fpga.bin");
    await writeFile(image, Buffer.from([...new Array(22).fill(0xff), 0xa5, 0xc3]));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Papilio ESP Bootloader"))
      .mockResolvedValueOnce(new Response("FPGA flash update successful!"))
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(new Response("FPGA Companion - Network Recovery"));
    vi.stubGlobal("fetch", fetch);
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "flash_device_ota",
        arguments: { ip: "192.0.2.1", device_type: "fpga", file_path: image },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({
        text: expect.stringMatching(/"completionAcknowledged": true[\s\S]*"bootObserved": true[\s\S]*"resumeAcknowledged": false/),
      }));
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/resume"))).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true });
    }
  });

  it("observes an application that returns more than 12 seconds after an acknowledged resume", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Papilio ESP Bootloader"))
      .mockResolvedValueOnce(new Response("Resuming 'ota_0'. Rebooting..."))
      .mockImplementationOnce(async () => {
        now += 13000;
        return new Response("Papilio ESP Bootloader");
      })
      .mockResolvedValueOnce(new Response("FPGA Companion - Network Recovery"));
    vi.stubGlobal("fetch", fetch);
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "resume_application",
        arguments: { transport: "http", ip: "192.0.2.1" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({
        text: expect.stringMatching(/"resumeAcknowledged": true[\s\S]*"bootObserved": true/),
      }));
      expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllGlobals();
      clock.mockRestore();
    }
  });

  it("does not treat an explicit resume HTTP error as a successful boot", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Papilio ESP Bootloader"))
      .mockResolvedValueOnce(new Response("failed", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "resume_application",
        arguments: { transport: "http", ip: "192.0.2.1" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("HTTP 500") }));
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllGlobals();
    }
  });

  it("preserves an HTTP error even if its response body is lost", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError("body lost")); } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Papilio ESP Bootloader"))
      .mockResolvedValueOnce(new Response(body, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "resume_application",
        arguments: { transport: "http", ip: "192.0.2.1" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("HTTP 500") }));
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllGlobals();
    }
  });

  it("reports failure when an unacknowledged resume is not followed by application identity", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Papilio ESP Bootloader"))
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockImplementation(async () => {
        now += 31000;
        return new Response("Papilio ESP Bootloader");
      });
    vi.stubGlobal("fetch", fetch);
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "resume_application",
        arguments: { transport: "http", ip: "192.0.2.1" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({
        text: expect.stringMatching(/"resumeAcknowledged": false[\s\S]*"resumeWarning":[\s\S]*"bootObserved": false/),
      }));
      expect(result.content).toContainEqual(expect.objectContaining({
        text: expect.stringContaining("Timed out waiting for the application over HTTP after 30 seconds."),
      }));
      expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllGlobals();
      clock.mockRestore();
    }
  });

  it("rejects unsupported full-image verification before any HTTP request", async () => {
    const { client, server } = await connectMcpServer();
    try {
      const result = await client.callTool({
        name: "flash_device_ota",
        arguments: {
          ip: "192.0.2.1",
          device_type: "esp32",
          file_path: "missing-image.bin",
          verify: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual(expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Full-image readback verification is unsupported"),
      }));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
