import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchableUrl, htmlToText } from "./extract-text";

const PAGE = `<!doctype html><html><head>
  <title>Base ships upgrade &amp; more</title>
  <meta content="Fees fall 40% after the upgrade." property="og:description">
  <style>.x{color:red}</style><script>window.secret = "drop me";</script>
</head><body>
  <nav>Home | Markets | Login</nav>
  <article><h1>Base ships upgrade</h1><p>${"The network upgrade cut fees by 40&#37; for users. ".repeat(12)}</p></article>
  <footer>Copyright junk</footer>
</body></html>`;

test("htmlToText keeps title, description and article text only", () => {
  const text = htmlToText(PAGE);
  assert.ok(
    text.startsWith(
      "Title: Base ships upgrade & more\nDescription: Fees fall 40% after the upgrade.\n",
    ),
  );
  assert.ok(text.includes("cut fees by 40% for users."));
  for (const dropped of [
    "drop me",
    "color:red",
    "Login",
    "Copyright junk",
    "<",
  ]) {
    assert.ok(!text.includes(dropped), `should drop ${dropped}`);
  }
  assert.ok(
    text
      .split("\n")
      .every((line) => line === line.trim() && !/\s{2,}/.test(line)),
  );
});

test("htmlToText caps length", () => {
  const text = htmlToText(`<p>${"word ".repeat(2000)}</p>`);
  assert.equal(text.length, 2500);
  assert.ok(text.endsWith("…"));
});

test("fetchableUrl allows public http(s) and blocks private targets", () => {
  assert.ok(fetchableUrl("https://www.coindesk.com/markets/2026/10/17/story"));
  assert.ok(fetchableUrl("/next", "https://example.com/start"));
  for (const blocked of [
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://10.0.0.5/",
    "http://172.20.1.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://metadata.google.internal/",
    "https://user:pass@example.com/",
    "file:///etc/passwd",
    "ftp://example.com/",
    "not a url",
  ]) {
    assert.equal(fetchableUrl(blocked), null, blocked);
  }
});
