#!/usr/bin/env node
/**
 * Fold what the collector took into the queue the agent reads.
 *
 * The collector and the daily commit both want to write down "these words are
 * waiting", and they must never do it to the same file: one is a public
 * unauthenticated writer appending all day, the other is a git working tree that
 * gets pulled, rewritten and pushed. So the collector only ever appends to
 * `inbox.jsonl`, and this runs once, at the top of the daily run, to move the
 * contents across. `queue.json` changes exactly once a day, inside the commit.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = join(ROOT, "inbox.jsonl");
/** Read from here, not from the inbox: see `claim` below. */
const CLAIMED = join(ROOT, "inbox.draining");

/**
 * Four days of the agent's work. Past this the queue has stopped being a backlog
 * and started being a place words go to be forgotten, so the overflow is dropped
 * out loud rather than accumulated in silence.
 */
const QUEUE_CAP = 1000;

/**
 * Take the inbox away from the collector before reading it.
 *
 * A rename is atomic and the collector opens the path afresh on every append, so
 * the next word it takes creates a new, empty inbox while everything written up
 * to this instant is in the file we now hold. Truncating in place would throw
 * away whatever arrived between the read and the truncate.
 */
async function claim() {
  try {
    await rename(INBOX, CLAIMED);
  } catch {
    // No inbox: nothing has been collected since the last run.
  }
  try {
    return await readFile(CLAIMED, "utf8");
  } catch {
    return "";
  }
}

const readJson = async (name) => JSON.parse(await readFile(join(ROOT, name), "utf8"));

const dictionary = await readJson("dictionary.json");
const queue = await readJson("queue.json");

/** Already answered: something can be found from this word, so nobody need ask. */
const answered = (word) =>
  Boolean(dictionary.aliases[word]?.length) || word in dictionary.records;

const waiting = new Set(queue.words.map((word) => word.toLowerCase()));
const arrived = [];
let unreadable = 0;

for (const line of (await claim()).split("\n")) {
  if (line.trim() === "") continue;

  let word, review;
  try {
    ({ word, review } = JSON.parse(line));
  } catch {
    unreadable += 1;
    continue;
  }

  if (typeof word !== "string" || waiting.has(word)) continue;
  // Only an ordinary submission is dropped for being answered already. A word
  // reported through `/sideword/review` is answerable by definition — that is
  // what it means to say our answer is wrong — so it is the one thing allowed
  // back into the queue, and `bin/probe.mjs` recognises it by exactly that.
  if (answered(word) && review !== true) continue;
  waiting.add(word);
  arrived.push(word);
}

const words = [...queue.words, ...arrived];
const kept = words.slice(0, QUEUE_CAP);
const dropped = words.length - kept.length;

await writeFile(join(ROOT, "queue.json"), JSON.stringify({ words: kept }, null, 2) + "\n");
await writeFile(CLAIMED, "");

const notes = [`${arrived.length} new`, `${kept.length} queued`];
if (dropped > 0) notes.push(`${dropped} dropped over the cap of ${QUEUE_CAP}`);
if (unreadable > 0) notes.push(`${unreadable} unreadable lines ignored`);
console.log(notes.join(", ") + ".");
