# sideword-dictionary

The Shared Dictionary for [Sideword](https://github.com/wudishidove/translate_learning_extention),
a browser extension that turns everyday translation into vocabulary learning.

`dictionary.json` is the whole thing. The extension downloads it once a day and
reads it locally, so looking a word up here sends nothing to anyone.

## Why it exists

Sideword collects the English words you look up while reading and fills in their
dictionary detail afterwards. Some words have no dictionary detail to fill in:
slang, proper nouns, technical terms, things too new, and irregular forms like
`strove` that no rule reaches from `strive`. Those words used to sit in the
vocabulary with nothing on the back of the card, forever.

This is where they get an answer. A scheduled agent takes the words that came
back empty, works out what they mean, and publishes them here — once, for
everyone, instead of once per person.

## What is in a record

Records are keyed by headword. A separate table maps the form you actually
selected to the headwords it might be, and it maps to more than one when the
word is ambiguous — `axes` is both `axe` and `axis`, and choosing between them
needs the sentence you were reading, which never leaves your machine.

```jsonc
{
  "version": 1,
  "updatedAt": 1753660000000,
  "aliases": { "strove": ["strive"], "yeet": ["yeet"] },
  "records": {
    "yeet": {
      "headword": "yeet",
      "ipa": "/jiːt/",
      "gloss": "用力扔",
      "source": "llm",
      "senses": [{ "partOfSpeech": "verb", "english": "…", "chinese": "…" }],
      "example": { "english": "…", "chinese": "…" }
    }
  }
}
```

`source` is the field to read carefully.

- **`dictionary`** — the English definitions were published by a dictionary and
  copied here. Only the Chinese is machine-made.
- **`llm`** — no dictionary had this word, so a language model wrote the
  definitions from its own knowledge. Sideword shows these with a note saying so,
  every time.

That distinction is the reason this repository is public and its history is
worth keeping: every definition a model wrote has a commit showing when it was
written and what it said.

## Running it

See [AGENT.md](./AGENT.md), which is what the daily run follows.

```
node bin/drain.mjs      # fold what the collector took into queue.json
node bin/probe.mjs      # ask the public dictionary about up to 250 queued words
                        # write answers.json, including notWords
node bin/publish.mjs    # validate, merge, and clear the queue
```

`bin/publish.mjs` is the gate: it refuses an alias pointing at a missing record,
a Chinese field with no Chinese in it, and any change that would drop a record
already published.

## The daily schedule

`bin/daily.sh` pulls, checks whether anything is queued, probes the public
dictionary, and starts Codex only if there is judgement work to do — an agent
woken with nothing to do is an agent looking for something to do. The unattended
run is pinned to `gpt-5.6-sol` with medium reasoning in a workspace-write sandbox.
Codex writes only the ignored `answers.json`; the shell validates it, stages only
`dictionary.json` and `queue.json`, then commits and pushes.

Install it on the machine that keeps the dictionary:

```sh
cp deploy/com.sideword.dictionary.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.sideword.dictionary.plist
launchctl list | grep sideword          # confirm it is registered
```

It runs at 04:17 and logs to `daily.log`, which is gitignored. To take it off
again: `launchctl unload ~/Library/LaunchAgents/com.sideword.dictionary.plist`.

## Contributing a word

Sideword can send the words it could not define here, once you turn that on in
its options. It is off until you do, and what it sends is the word and nothing
else — not the page, not the sentence, not your learning history. See ADR-0008 in
the extension's repository.

The endpoint is `POST /sideword/words` with `{"words": ["strove", "rizz"]}`. It
answers with the words it took, which is not always all of them: 250 words per
address per day, counted against what was sent rather than what was valid, so
nonsense costs its sender the same as a word. A word must be a single token of
letters, hyphen and apostrophe, at most 40 characters — the shape a browser
selection produces. Anything else is dropped without comment.

`POST /sideword/review` takes the same body and says something different with it:
*the record you publish for this word is wrong.* Words already in the dictionary
are dropped by the queue above — that is what it is for — and this is the one way
back in. Same validation and the same 250, so reporting a hundred words costs a
hundred of your own allowance; that is what keeps the nightly run from being
steered by whoever shouts loudest. A report says where to look and never what to
write: the agent re-derives the word and corrects the record only if it finds it
wrong. See `AGENT.md`.

The two are drained in priority order, least answered first: words no dictionary
anywhere has, then disputed records, then words a public dictionary already
covers. More words are probed each night than the agent can handle, because
asking is one HTTP request and answering is a model reading and writing.

```sh
cp deploy/com.sideword.collector.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.sideword.collector.plist
curl -s https://gogoswifi2.asuscomm.com/sideword/health     # {"ok":true}
```

It listens on `127.0.0.1:5510` and is reached through the Caddy already running
on that machine, which routes `/sideword/*` here and everything else where it
went before.

**It never writes a file git tracks.** Words are appended to `inbox.jsonl`, and
`bin/drain.mjs` folds that into `queue.json` at the top of the daily run — so an
unauthenticated writer and the daily commit never touch the same file, and the
queue changes exactly once a day inside a commit that can be read.
