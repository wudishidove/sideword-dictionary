#!/usr/bin/env node
/**
 * Ask the public dictionary about every Word waiting in the queue, and write
 * down what it said.
 *
 * This exists so the agent never has to make an HTTP request or decide what a
 * 404 means. Both of those have exactly one right answer, and a script gets it
 * right every night. What is left for the model is the part that needs judgement:
 * which Headword an irregular form belongs to, what a Word means when no
 * dictionary has it, and how to say any of it in Chinese.
 */

import { readFile, writeFile } from "node:fs/promises";

const API = "https://api.dictionaryapi.dev/api/v2/entries/en";
/** A hard run limit, not merely an instruction the unattended agent may forget. */
const RUN_CAP = 250;
/**
 * More Words are asked about than are handed over, because asking and answering
 * cost wildly different things: a probe is one request to a free public API,
 * while an answer is a model reading and writing. Probing wide is what makes the
 * ordering below possible at all — until the dictionary has answered, there is
 * no way to tell a Word nobody can define from a Word it already covers, and
 * that is exactly the distinction the run cap needs in order to spend well.
 */
const PROBE_CAP = 2 * RUN_CAP;

/**
 * Least answered first.
 *
 * `no-such-word` has nothing anywhere and is the case this dictionary exists
 * for. `reported` has an answer that somebody is looking at and says is wrong.
 * `found` is already covered by a public dictionary, so a reader is not stuck —
 * it is worth doing, just last, and over a few months of 250 a day the ordinary
 * words get collected anyway. `could-not-ask` is not an answer and stays queued.
 */
const PRIORITY = {
  "no-such-word": 0,
  reported: 1,
  found: 2,
  "could-not-ask": 3,
};

/** The dictionary's own body for a Word it does not have. Anything else is an outage. */
function isNoSuchWord(body) {
  return body !== null && typeof body === "object" && body.title === "No Definitions Found";
}

/** `null` means the dictionary answered "no such Word". Failures throw. */
async function lookup(word) {
  const response = await fetch(`${API}/${encodeURIComponent(word)}`);

  if (response.status === 404) {
    const body = await response.json().catch(() => null);
    if (isNoSuchWord(body)) return null;
    throw new Error(`${word}: 404 that is not the API's answer`);
  }
  if (!response.ok) throw new Error(`${word}: HTTP ${response.status}`);

  const entries = await response.json();
  return entries.map((entry) => ({
    word: entry.word,
    ipa:
      entry.phonetic ||
      entry.phonetics?.find((p) => p.text)?.text ||
      null,
    meanings: (entry.meanings ?? []).map((meaning) => ({
      partOfSpeech: meaning.partOfSpeech ?? "",
      definitions: (meaning.definitions ?? [])
        .filter((d) => d.definition)
        .map((d) => ({ definition: d.definition, example: d.example ?? null })),
    })),
  }));
}

const queue = JSON.parse(await readFile("queue.json", "utf8"));
const dictionary = JSON.parse(await readFile("dictionary.json", "utf8"));

/** What we publish for a queued word today, so that a report can be judged. */
function publishedFor(key) {
  const headwords = dictionary.aliases[key] ?? (key in dictionary.records ? [key] : []);
  return headwords
    .filter((headword) => headword in dictionary.records)
    .map((headword) => dictionary.records[headword]);
}

const probed = [];
for (const word of queue.words.slice(0, PROBE_CAP)) {
  const key = word.toLowerCase();
  // `bin/drain.mjs` drops every word this dictionary can already answer, so a
  // queued word that IS answerable arrived through `/sideword/review`: a reader
  // is saying the record we publish for it is wrong. Deciding that needs both
  // sides, so this one gets asked about rather than skipped.
  const reported = Boolean(dictionary.aliases[key] || dictionary.records[key]);

  try {
    const found = await lookup(word);
    probed.push({
      word,
      status: reported ? "reported" : found === null ? "no-such-word" : "found",
      entries: found ?? [],
      ...(reported ? { published: publishedFor(key) } : {}),
    });
  } catch (cause) {
    // Left in the queue: not asking is not an answer — the extension's ADR-0005
    // makes the same distinction, for the same reason.
    probed.push({ word, status: "could-not-ask", error: String(cause) });
  }
}

// Stable, so that within one priority the queue's own order survives — which is
// arrival order, which is the order the words were met in.
probed.sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]);
const work = probed.slice(0, RUN_CAP);

await writeFile("work-order.json", JSON.stringify({ work }, null, 2) + "\n");

const count = (status) => probed.filter((w) => w.status === status).length;
const held = probed.length - work.length;
console.log(
  `${queue.words.length} queued — asked about ${probed.length}: ` +
    `${count("no-such-word")} undefined anywhere, ` +
    `${count("reported")} reported as wrong, ` +
    `${count("found")} already in the public dictionary, ` +
    `${count("could-not-ask")} unreachable. ` +
    `Handing over ${work.length}` +
    (held > 0 ? `, holding ${held} for tomorrow.` : "."),
);
