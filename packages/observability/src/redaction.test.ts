import { describe, expect, it } from "vitest";
import { REDACTED, looksLikeUrl, redactFilePath, redactUrl } from "./redaction";

/**
 * A CloudFront-shaped signed URL. Every assertion below searches for the two
 * substrings that must never survive — the signature and the title — rather
 * than only comparing against an expected output, because an equality check
 * passes just as happily when the function has been rewritten to return a
 * constant.
 */
const SIGNED =
  "https://cdn.example.com/movies/northstar/1080p/seg-000012.m4s" +
  "?Policy=eyJTdGF0ZW1lbnQi&Signature=SECRET-SIGNATURE&Key-Pair-Id=APKAEXAMPLE";

describe("redactUrl", () => {
  it("keeps the host and destroys everything that identifies the object", () => {
    expect(redactUrl(SIGNED)).toBe(`https://cdn.example.com/${REDACTED}`);
  });

  it("lets no signature, path or query survive", () => {
    const output = redactUrl(SIGNED);
    expect(output).not.toContain("SECRET-SIGNATURE");
    expect(output).not.toContain("northstar");
    expect(output).not.toContain("seg-000012");
    expect(output).not.toContain("?");
  });

  it("drops userinfo, which is a credential rather than an address", () => {
    expect(redactUrl("https://someone:hunter2@cdn.example.com/a/b")).toBe(
      `https://cdn.example.com/${REDACTED}`
    );
  });

  it("keeps the port, which is an operational fact and not user content", () => {
    expect(redactUrl("http://localhost:8080/a/b?x=1")).toBe(`http://localhost:8080/${REDACTED}`);
  });

  it("collapses every scheme that is not http or https", () => {
    // `data:` embeds the content, `blob:` and `file:` name the local machine,
    // and all three parse successfully — so an allowlist is the only thing
    // standing between them and a log line.
    for (const value of [
      "data:video/mp4;base64,AAAAIGZ0eXA",
      "blob:https://app.example.com/9f1c-northstar",
      "file:///home/someone/Movies/northstar.mkv",
      "javascript:alert(1)"
    ]) {
      expect(redactUrl(value), value).toBe(REDACTED);
    }
  });

  it("collapses a relative url entirely, which is what CMCD nor always is", () => {
    expect(redactUrl("../seg-000013.m4s")).toBe(REDACTED);
    expect(redactUrl("/movies/northstar/1080p.m3u8")).toBe(REDACTED);
    expect(redactUrl("//cdn.example.com/movies/northstar")).toBe(REDACTED);
  });

  it("returns a value rather than throwing on anything at all", () => {
    // The caller is a request-time telemetry boundary; a throw here is a way
    // for a malformed body to spend an error budget.
    expect(redactUrl("")).toBe(REDACTED);
    expect(redactUrl("not a url")).toBe(REDACTED);
    expect(redactUrl("https://")).toBe(REDACTED);
  });
});

describe("redactFilePath", () => {
  it("keeps the container extension and nothing else", () => {
    expect(redactFilePath("/home/someone/Movies/Northstar (2019)/movie.mkv")).toBe(
      `${REDACTED}.mkv`
    );
  });

  it("does not mistake a Windows drive letter for a URL scheme", () => {
    // `D:` matches a naive scheme pattern, and treating it as one sends the
    // path down the URL branch where the extension is lost.
    expect(redactFilePath("D:\\Movies\\Northstar\\movie.mp4")).toBe(`${REDACTED}.mp4`);
  });

  it("routes anything with a real scheme through URL redaction", () => {
    expect(redactFilePath(SIGNED)).toBe(`https://cdn.example.com/${REDACTED}`);
  });

  it("gives up entirely when there is no extension to keep", () => {
    expect(redactFilePath("/home/someone/Movies/northstar")).toBe(REDACTED);
  });
});

describe("looksLikeUrl", () => {
  it("catches the shapes a URL hides in when the type does not say", () => {
    expect(looksLikeUrl(SIGNED)).toBe(true);
    expect(looksLikeUrl("blob:https://app.example.com/9f")).toBe(true);
    expect(looksLikeUrl("//cdn.example.com/a")).toBe(false);
    expect(looksLikeUrl("cdn.example.com")).toBe(false);
    expect(looksLikeUrl("northstar-2019")).toBe(false);
  });
});
