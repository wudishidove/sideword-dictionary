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
node bin/probe.mjs      # ask the public dictionary about everything queued
                        # write answers.json
node bin/publish.mjs    # validate, merge, and clear the queue
```

`bin/publish.mjs` is the gate: it refuses an alias pointing at a missing record,
a Chinese field with no Chinese in it, and any change that would drop a record
already published.

## Contributing a word

Not yet. The endpoint that accepts words is the next piece of work; for now the
queue is filled by hand.
