#!/usr/bin/env node
/**
 * The endpoint that fills the queue.
 *
 * It accepts one thing and one thing only: bare word strings. No Entry, no
 * sentence a word was met in, no page it came from, no learning history — those
 * stay on the user's machine, and the way to guarantee that is for the endpoint
 * to have no idea they exist. A word arriving here is already stripped of
 * everything that made it personal; all that is left is "somebody, somewhere,
 * looked this up and no dictionary had it".
 *
 * It never writes a file git tracks. Words land in an append-only `inbox.jsonl`
 * which `bin/drain.mjs` folds into `queue.json` once a day. That keeps a public,
 * unauthenticated writer and the daily commit from ever touching the same file.
 */

import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = join(ROOT, "inbox.jsonl");
const LEDGER = join(ROOT, "ratelimit.json");

const HOST = "127.0.0.1";
const PORT = 5510;

/** One person's share of one run: the agent handles 250 words a day in total. */
const DAILY_WORDS = 250;
/** Generous for an honest batch — 200 words of 40 characters is under 9 KB. */
const MAX_BODY = 32 * 1024;
const MAX_WORDS = 200;
const MAX_LENGTH = 40;

/**
 * A Word exactly as the extension defines one: a single token of letters, with
 * an internal hyphen or apostrophe allowed. Anything with a space, a digit, a
 * slash or a non-Latin letter in it is not a word somebody selected — it is
 * somebody trying their luck.
 */
const WORD = /^[a-z]+(?:['-][a-z]+)*$/;

const stamp = (...parts) =>
  console.log(new Date().toISOString(), ...parts.map(String));

const today = () => new Date().toISOString().slice(0, 10);

let ledger = { day: "", counts: {} };

/**
 * Who is asking, as a number rather than a person.
 *
 * Caddy appends the peer it actually saw to `X-Forwarded-For`, so the last entry
 * is the one no client could have written; we listen on loopback, so there is
 * never a hop in between that we do not run. The address is then hashed with the
 * date, which means the file below can answer "has this caller had their 250
 * today" and cannot answer "did this caller come back tomorrow".
 */
function caller(request) {
  const forwarded = request.headers["x-forwarded-for"];
  const chain = typeof forwarded === "string" ? forwarded.split(",") : [];
  const address =
    chain.at(-1)?.trim() || request.socket.remoteAddress || "unknown";
  return createHash("sha256")
    .update(`${today()}\n${address}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Charged on what was submitted, not on what survived validation — otherwise a
 * flood of nonsense costs its sender nothing and the limit limits nothing.
 */
async function spend(key, wanted) {
  const day = today();
  if (ledger.day !== day) ledger = { day, counts: {} };

  const used = ledger.counts[key] ?? 0;
  const granted = Math.max(0, Math.min(wanted, DAILY_WORDS - used));
  if (granted > 0) {
    ledger.counts[key] = used + granted;
    await writeFile(LEDGER, JSON.stringify(ledger));
  }
  return granted;
}

function acceptable(value) {
  if (typeof value !== "string") return null;
  // U+2019 is what a browser hands back for an apostrophe on most pages.
  const word = value.trim().toLowerCase().replaceAll("’", "'");
  if (word.length === 0 || word.length > MAX_LENGTH) return null;
  return WORD.test(word) ? word : null;
}

function body(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
      if (text.length > MAX_BODY) {
        reject(new Error("body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      resolve(text);
    });
    request.on("error", reject);
  });
}

async function collect(request) {
  let sent;
  try {
    const raw = JSON.parse(await body(request));
    sent = Array.isArray(raw?.words) ? raw.words : null;
  } catch {
    return [400, { error: "body must be JSON" }];
  }
  if (sent === null) return [400, { error: "expected { words: string[] }" }];

  const submitted = sent.slice(0, MAX_WORDS);
  const clean = [...new Set(submitted.map(acceptable).filter((w) => w !== null))];
  const granted = await spend(caller(request), submitted.length);
  const taken = clean.slice(0, granted);

  if (taken.length > 0) {
    await appendFile(
      INBOX,
      taken.map((word) => JSON.stringify({ word }) + "\n").join(""),
    );
  }

  stamp(`took ${taken.length} of ${sent.length}`);
  // The words themselves, not a count. A caller that runs out of allowance
  // half way through a batch has to know *which* half was taken, or it will
  // write off the rest as sent and never offer them again. `refused` is
  // derivable from this and is here for whoever is holding curl.
  return [200, { accepted: taken, refused: sent.length - taken.length }];
}

async function route(request) {
  const path = (request.url ?? "").split("?")[0];
  if (request.method === "GET" && path === "/sideword/health") {
    return [200, { ok: true }];
  }
  if (request.method === "POST" && path === "/sideword/words") {
    return collect(request);
  }
  return [404, { error: "no such endpoint" }];
}

// Deliberately no `Access-Control-Allow-Origin`. The extension calls this from
// its service worker with a host permission, where CORS does not apply; adding
// the header would additionally let any web page in the world post from a
// visitor's browser, which is the one caller we have no reason to accept.
const server = createServer((request, response) => {
  void route(request).then(
    ([status, payload]) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(payload));
    },
    (cause) => {
      stamp("failed:", cause?.message ?? cause);
      if (response.writableEnded) return;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad request" }));
    },
  );
});

try {
  ledger = JSON.parse(await readFile(LEDGER, "utf8"));
} catch {
  // First run, or a ledger we cannot read. Starting empty hands out one extra
  // allowance at worst, and the alternative is refusing to start at all.
}

server.listen(PORT, HOST, () => {
  stamp(`listening on http://${HOST}:${String(PORT)}/sideword`);
});
