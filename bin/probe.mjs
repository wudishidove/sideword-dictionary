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

const work = [];
for (const word of queue.words.slice(0, RUN_CAP)) {
  const key = word.toLowerCase();
  if (dictionary.aliases[key] || dictionary.records[key]) {
    work.push({ word, status: "already-published" });
    continue;
  }

  try {
    const found = await lookup(word);
    work.push(
      found === null
        ? { word, status: "no-such-word", entries: [] }
        : { word, status: "found", entries: found },
    );
  } catch (cause) {
    // Left in the queue: not asking is not an answer — the extension's ADR-0005
    // makes the same distinction, for the same reason.
    work.push({ word, status: "could-not-ask", error: String(cause) });
  }
}

await writeFile("work-order.json", JSON.stringify({ work }, null, 2) + "\n");

const count = (status) => work.filter((w) => w.status === status).length;
console.log(
  `${queue.words.length} queued — probing ${work.length}: ` +
    `${count("found")} in the dictionary, ` +
    `${count("no-such-word")} not, ${count("already-published")} already done, ` +
    `${count("could-not-ask")} unreachable`,
);
