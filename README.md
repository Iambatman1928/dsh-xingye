# Xingye (星野) · a chat agent for DSH

English | [中文](README.zh.md)

[![test](https://github.com/Iambatman1928/dsh-xingye/actions/workflows/ci.yml/badge.svg)](https://github.com/Iambatman1928/dsh-xingye/actions/workflows/ci.yml)

Xingye turns **one DeepSeek Harness session into a chat agent**. Install it, open a new session with the
`星野` agent preset selected, and you are talking to Xingye herself. Inside her session you can create other
characters, write their personas, give one character several separate archive threads, and keep several
personas for yourself to switch between. **Everything stays on this machine** — nothing is sent to a server
beyond your own model calls.

<p align="center">
  <b>Characters</b> · <b>Create</b> · <b>My personas</b> · <b>Conversation</b> · <b>Archives</b>
</p>

## Install

```sh
dsh plugin --profile web add dsh-xingye
```

Then **restart DSH** and:

1. open **Settings → Plugins** and confirm `dsh-xingye` is listed;
2. open a **new session** and pick the **星野** agent preset — this step is not optional, the preset is what
   gives that session its identity and its tool set;
3. just start talking. Xingye greets you with her built-in persona.

A **character pill** (avatar + name + current archive) sits in the session header — click it to open the
full-page character manager.

> **Why does one install command still need a preset step?**
> DSH agent presets are discovered from the filesystem only; there is no plugin registration API for them.
> So on first load this package copies its bundled preset to `<DSH_HOME>/.agent-presets/xingye/`
> (`$DSH_HOME` defaults to `~/.dsh`). That copy happens **only when the target is missing**, never overwrites
> a preset you have edited, and logs exactly what it did. To opt out, set `installPreset: false` on this
> plugin's row and copy `node_modules/dsh-xingye/preset/` to `~/.dsh/.agent-presets/xingye/` yourself.

Install from source instead:

```sh
dsh plugin --profile web add 'github:Iambatman1928/dsh-xingye'
```

## The interface

Five pages, built from four design mockups — colours, radii, spacing and shadows are copied from them
(warm white `#fffbf7`, brand purple `#8b5cf6`, 16px card radius, 56px avatar, 64px nav).

| Page | How to reach it | What it does |
|---|---|---|
| **Characters** | click the character pill in the session header | one card per character: avatar / name / tags / last line; click a card to switch and keep chatting; the "N archives" control opens the archive page; "＋" starts a new character |
| **Create** | Characters → "＋" | avatar upload, name, blurb, personality, opening line, tags; on save Xingye really creates the character and speaks the opening line |
| **My personas** | bottom nav "personas" | current persona card plus the pickable list; create one; clear it |
| **Conversation** | close the full page | avatar plus white left bubbles (Xingye) and purple right bubbles (you); the "＋" beside the input is the story menu (retry / rewind / restart / recap / undo) |
| **Archives** | "N archives" on a character card | a character's several conversation threads: switch and continue, start a new one, delete the character (two confirmations) |

**Leaving a full page**: tap the active tab again, press Esc, click the scrim on tablet/desktop, or use the
"⌄" in the header.

**Responsive**: phone (<720px) fills the screen with a full-width bottom nav; tablet (≥720px) centres the card
with a floating pill nav; desktop (≥980px) widens the card and turns the character list into a two-column grid.
Safe-area insets, `prefers-reduced-motion`, and light/dark themes that follow DSH's own are all handled.

## What it does

Plain language, no commands to memorise.

**Characters and personas**

- "Create a character called Lin Yan; her persona is in `D:\personas\linyan.md`" (imports md / txt)
- "Make a character called Xiaoman, sixteen, talkative, starts sentences with 'hey'"
- "Replace Lin Yan's persona with this: …" / "Rename her to Lin Yanzhi" / "Delete Xiaoman"

**Conversation**

- Just talk. The character's persona, your persona and the current archive are injected at every step, so
  Xingye *is* that character.
- "What did we talk about before?" / "Scroll back" (reads the locally stored transcript)

**Undo the last 30 messages**

- "Undo the last 5" / "Those last few don't count"
- Undo genuinely rolls back this archive's local record; removed content goes to a trash file and
  "restore what I just removed" brings it back.
- 30 is a hard ceiling and Xingye will tell you so rather than pretend otherwise.

**Several archives per character**

- "Start another archive called 'Another Night'" / "List Lin Yan's archives" / "Switch to 'First Meeting'"
- Each archive stores its own record. Switching back to an old one continues that thread instead of
  reintroducing the character.
- **A new session = a new archive thread for the current character**: the new session inherits the character
  and your persona but starts with an empty archive, named "Archive 2", "Archive 3"… as soon as you send a
  first message. Reopening the same session reattaches to its own archive (bound by session id).

**Your own personas**

- "Make me a persona called 'Traveller'" / "Import `D:\personas\me.txt`"
- "Switch to 'Colleague Lin'" / "Drop my persona"

**Rewriting the story**

- "Say that again" / "Take back that line" / "Go back to before X" / "Start over"
- Cut content is saved as a **branch**, so "bring back the branch I just cut" undoes the rewind.

**Memory**

- **Event book**: five kinds of entry (plot / scene / detail / preference / note) carrying a rewind anchor,
  injected as a recap section that is re-read every step — so a node just recorded, or just invalidated by an
  undo, shows up on the very next model call.
- **Memory images**: `xingye_memory_image` generates images and `xingye_character_image` manages a character's
  avatar / portrait / background. DSH has no image generation of its own, so generation calls an OpenAI-compatible
  endpoint you configure; **with no key it does not error** — it degrades to storing the drawing prompt only.
  Images you paste into a conversation are archived into the gallery automatically.

**Keeping the footprint down**

- The transcript keeps the most recent 400 messages by default; older ones are summarised and their originals
  deleted. Anything older than 30 days is treated the same way — but **the most recent 30 messages always keep
  their originals**, because undo and rewind need them.

## Where the data lives

`<DSH_HOME>/xingye-data/` by default (`$DSH_HOME` defaults to `~/.dsh`):

```
xingye-data/
  index.json                     global default: last character / archive / user persona
  config.json                    retention policy (hand-editable)
  sessions.json                  session id → character / archive / user persona binding
  ui-state.json                  snapshot the UI reads (written by the plugin)
  characters/<name>/
    character.json
    persona.md                   persona text
    source/                      original copies of imported files
    avatar.* portrait.* background.*   character art (drop a file in and it is used)
    archives/<archive>/
      archive.json
      messages.jsonl             transcript — the source for rewind and undo
      summary.md                 summary of older turns after cleanup
      trash.jsonl                undone content (recoverable)
      eventbook.jsonl            event book
      branches/<branch>.json     cut story saved as a branch
  user-personas/<persona>/
    persona.json
    persona.md
```

Back up by copying `xingye-data`; start over by pointing `dataRoot` at an empty directory.

**Changing the data root**: this package's `cordis.patch.yml` and the agent preset's row config each carry a
`dataRoot`. **Left unset, both fall back to `<DSH_HOME>/xingye-data`.** To move it you must set both, or the UI
reads a different directory than the agent writes.

## Image generation (optional)

Configure an OpenAI-compatible endpoint on the agent preset row:

```yaml
- id: xingye
  name: './plugin/index.js'
  config:
    image:
      baseURL: 'https://your-endpoint/v1'
      apiKeyEnv: 'YOUR_API_KEY_ENV'
      model: 'your-image-model'
      size: '1024x1024'
```

With `model` empty it stores prompts without generating. The key is read from the environment and never written
to disk.

## Known limits

DSH's session log is **append-only**: there is no API to delete, truncate or roll back historical events, and no
deletion path for `session.jsonl.zstd` on disk.

So the precise meaning of "undo the last 30" is:

- **the archive's local record is genuinely rolled back** — that data belongs to Xingye, so deleting it deletes
  it (recoverably);
- **the model receives an explicit invalidation notice** — the undo tool's result stays in the conversation,
  telling Xingye those turns are void, not to quote them, and to wait for you to say it again;
- but **the original events still exist in DSH's session log** (they are simply declared void from that turn on).

Other limits:

- **The preset must be the right one.** In a session running a different preset the UI still renders, but its
  actions cannot reach the agent — Xingye's tools are not in that session.
- **The UI is a full-frame overlay** and therefore sits above every session. When it is not bound to a Xingye
  session the pages stay readable but the buttons do not send commands, and the header says why — deliberately,
  so a line like "use this persona" can never be injected into an unrelated session.
- **Editing `client.js` requires a page reload; editing the Host half (`index.js`) requires a DSH restart.**

## Layout

```
dsh-xingye/
├─ index.js             Host half: /xingye/api routes + preset materialisation
├─ client.js            Client half: the full pages, character pill and story menu
├─ cordis.patch.yml     bundle patch that registers the plugin in a profile
├─ preset/              the bundled `xingye` agent preset
│   ├─ agent.cordis.yml session composition: identity + tool list
│   ├─ preset.yml       display name and blurb
│   └─ plugin/          17 `xingye_*` tools (zero dependencies, `node:` builtins only)
└─ tools/               three offline test suites
```

The division of labour: **the preset half is the backend** (characters, archives, undo, event book — all on the
agent plane) and **the profile plugin half is the frontend** (the UI plus a local route that hands UI actions to
the session). The UI reimplements no business logic, so there is exactly one source of truth — which is why the
code under `preset/plugin/` **may only import `node:` builtins**: a preset directory is not on the deployed
package's `node_modules` resolution chain.

## Development

```sh
node tools/verify.mjs                  # preset plugin, full flow (fake ctx, no DSH needed)
node tools/ui-client-render-test.mjs   # client half rendered offline (real React + a mini runtime that runs effects)
node tools/ui-host-route-test.mjs      # host half routes (fake req/res)
```

The UI tests read `client.js` from this repository root and look for React under
`~/.dsh/profiles/*/node_modules` and similar locations. Point them elsewhere by passing arguments:
`node tools/ui-client-render-test.mjs <pluginDir> <node_modulesWithReact>`.

## License

MIT. Not affiliated with DeepSeek.
