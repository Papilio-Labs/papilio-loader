import { describe, it, expect, vi } from "vitest";
import { uploadRomOta, type OtaPoster } from "../src/ota.js";

function fakePoster(response = "saved -> /sd/a2600.crt") {
  const post = vi.fn(async (_url: string, _body: BodyInit, _onProgress: unknown) => response);
  const poster: OtaPoster = { post };
  return { poster, post };
}

describe("uploadRomOta", () => {
  it("defaults to the /roms directory when no location is given", async () => {
    const { poster, post } = fakePoster();
    await uploadRomOta(poster, "10.0.4.35", "game.crt", new Uint8Array(1), () => {});
    expect(post.mock.calls[0][0]).toBe("http://10.0.4.35:3232/rom-load?name=game.crt");
  });

  it("appends location=root when requested", async () => {
    const { poster, post } = fakePoster();
    await uploadRomOta(poster, "10.0.4.35", "a2600.crt", new Uint8Array(1), () => {}, 3232, { location: "root" });
    expect(post.mock.calls[0][0]).toBe("http://10.0.4.35:3232/rom-load?name=a2600.crt&location=root");
  });

  it("encodes the file name", async () => {
    const { poster, post } = fakePoster();
    await uploadRomOta(poster, "10.0.4.35", "my rom&x.crt", new Uint8Array(1), () => {}, 3232, { location: "root" });
    expect(post.mock.calls[0][0]).toBe("http://10.0.4.35:3232/rom-load?name=my%20rom%26x.crt&location=root");
  });

  it("returns the Companion response text", async () => {
    const { poster } = fakePoster("saved -> /sd/a2600.crt");
    await expect(uploadRomOta(poster, "10.0.4.35", "a2600.crt", new Uint8Array(1), () => {})).resolves.toBe("saved -> /sd/a2600.crt");
  });
});
