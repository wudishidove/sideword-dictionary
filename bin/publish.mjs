#!/usr/bin/env node
/**
 * Merge `answers.json` into `dictionary.json`, refusing anything malformed.
 *
 * Everything this file checks is something a tired model gets wrong at three in
 * the morning with nobody watching: an alias pointing at a record it forgot to
 * write, an English definition left in the Chinese field, a record with no
 * senses. The dictionary is published, permanent and read by every user, so the
 * gate belongs here rather than in a code review that will not happen.
 */

import { readFile, writeFile } from "node:fs/promises";

/**
 * A record is keyed by a dictionary form, and a dictionary form is sometimes two
 * words — `brainrot` is properly written `brain rot`. An alias is keyed by a
 * surface form somebody selected on a page, and the extension only ever calls a
 * single token a Word, so a space on that side is a key nothing can look up.
 */
const RECORD_KEY = /^[a-z][a-z'-]*(?: [a-z][a-z'-]*)*$/;
const SURFACE = /^[a-z][a-z'-]*$/;
/** CJK, so an English string left in a Chinese field is caught rather than shipped. */
const CJK = /[一-鿿]/;

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

function checkRecord(key, record) {
  const at = `records["${key}"]`;
  check(record.headword === key, `${at}: keyed as "${key}" but calls itself "${record.headword}"`);
  check(RECORD_KEY.test(key), `${at}: not a lowercase Headword`);
  check(record.ipa === null || typeof record.ipa === "string", `${at}: ipa must be a string or null`);
  check(CJK.test(record.gloss ?? ""), `${at}: gloss is not Chinese`);
  check(
    record.source === "dictionary" || record.source === "llm",
    `${at}: source must be "dictionary" or "llm"`,
  );

  check(Array.isArray(record.senses) && record.senses.length > 0, `${at}: no senses`);
  for (const [i, sense] of (record.senses ?? []).entries()) {
    check(Boolean(sense.partOfSpeech), `${at}.senses[${i}]: no part of speech`);
    check(Boolean(sense.english), `${at}.senses[${i}]: no English`);
    check(CJK.test(sense.chinese ?? ""), `${at}.senses[${i}]: Chinese is missing or not Chinese`);
  }

  if (record.example !== null && record.example !== undefined) {
    check(Boolean(record.example.english), `${at}.example: no English`);
    check(CJK.test(record.example.chinese ?? ""), `${at}.example: Chinese is missing or not Chinese`);
  }
}

const dictionary = JSON.parse(await readFile("dictionary.json", "utf8"));
const answers = JSON.parse(await readFile("answers.json", "utf8"));
const queue = JSON.parse(await readFile("queue.json", "utf8"));

const records = { ...dictionary.records };
const aliases = { ...dictionary.aliases };

for (const [key, record] of Object.entries(answers.records ?? {})) {
  checkRecord(key, record);
  records[key] = { ...record, example: record.example ?? null };
}

for (const [surface, headwords] of Object.entries(answers.aliases ?? {})) {
  check(SURFACE.test(surface), `aliases["${surface}"]: not a lowercase surface form`);
  check(
    Array.isArray(headwords) && headwords.length > 0,
    `aliases["${surface}"]: must name at least one Headword`,
  );
  for (const headword of headwords ?? []) {
    // The check that matters most: an alias nobody can follow is a Word that
    // stays Unlisted while the dictionary claims to have it.
    check(headword in records, `aliases["${surface}"]: no record for "${headword}"`);
  }
  aliases[surface] = headwords;
}

/** A Word is done when something can be found from it, not when it was mentioned. */
const reachable = (word) => {
  const key = word.toLowerCase();
  return Boolean(aliases[key]?.length) || key in records;
};

for (const key of Object.keys(dictionary.records)) {
  check(key in records, `records["${key}"]: was published before and is now missing`);
}

if (problems.length > 0) {
  console.error(`Refusing to publish — ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

const published = { version: 1, updatedAt: Date.now(), aliases, records };
const remaining = queue.words.filter((word) => !reachable(word));

await writeFile("dictionary.json", JSON.stringify(published, null, 2) + "\n");
await writeFile("queue.json", JSON.stringify({ words: remaining }, null, 2) + "\n");

const added = Object.keys(records).length - Object.keys(dictionary.records).length;
console.log(
  `Published ${Object.keys(records).length} records (+${added}), ` +
    `${Object.keys(aliases).length} aliases. ${remaining.length} left in the queue.`,
);
