import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
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
