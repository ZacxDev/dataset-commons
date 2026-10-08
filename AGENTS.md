<!-- BEGIN civitai agent-setup — managed block, edits here are overwritten -->
## Building a Civitai App

This project is a **Civitai App**: a web app that runs in a sandboxed iframe
inside civitai.com. The host page and your app talk over `postMessage`.

### Docs — fetch these BEFORE writing code

Nothing in this repository is the API reference. The hooks, the message bridge,
the manifest fields and the scopes are documented on the docs site, and the
`.md` suffix serves the plain-text source an agent can read directly.

- **`https://developer.civitai.com/apps/reference/hooks.md`** — the COMPLETE
  hook reference. Fetch it first: every capability this platform has is a hook,
  and a capability you cannot find here probably exists under a name you have
  not guessed. It is ~40 KB, so page it rather than giving up on it.
- Reference (manifest, scopes, hooks, message bridge, CLI):
  https://developer.civitai.com/apps/reference/
- Guide: https://developer.civitai.com/apps/guide/
- Example apps you can read end-to-end:
  https://developer.civitai.com/apps/examples
- Full doc index for agents: https://developer.civitai.com/llms.txt

Reading `node_modules/@civitai/blocks-react/dist/*.d.ts` to find out what the
SDK can do is the expensive way round. Fetch the reference.

### Commands

🔴 **Every row below starts with `civitai`. If your shell answers
`command not found`, the CLI is installed but its directory is not on this
shell's PATH** — the usual cause is an install into a prefix whose `bin` was
added to PATH for the installing shell only, which no later shell inherits. In
a shell where `civitai` DOES work, `command -v civitai` prints its full path;
add that directory to your shell profile so every later session can run these
commands too.

Every row below is a `civitai` CLI command and is true in any Civitai App
project. How you RUN this app locally is not — it depends on what was scaffolded
here — so it has its own section, written from what is actually in this
directory.

| Task | Command |
|---|---|
| Scaffold a new app | `civitai app create <name>` |
| …choosing the template | `civitai app create <name> --template static\|page-vite\|page-money` |
| Check the manifest | `civitai app validate` |
| Package and submit for review | `civitai app submit` |
| Diagnose an incomplete store listing | `civitai app doctor` |
| Your local app inside the REAL host (needs a local dev server already running — see below) | `civitai app dev-tunnel` |

**Pick the template on purpose — `create` defaults to the biggest one.** With no
`--template`, `civitai app create` scaffolds `page-money`, which is by a wide
margin the largest of the three: around forty files, with a README and an
`src/App.tsx` of tens of KB each. That is the right starting point when you are
building a Buzz-spending generation app, because it is a working one. For
anything else it is a large amount of sample code to read and then delete.

- `static` — one `index.html` plus a little JS. No build step, nothing to
  install. The smallest thing that can be a Civitai App.
- `page-vite` — Vite + React, a build step, no SDK wiring. The one to pick when
  you want a UI framework but not the money path.
- `page-money` — Vite + React + TypeScript wired to the App SDK: estimate →
  consent → submit → poll → Buzz spend, with a mock-host dev harness. **The
  default.** Reading it end-to-end is expensive; treat it as a reference you
  copy from, and delete what your app does not use.

### Local development

`civitai agent-setup` read `package.json` in this directory. These are the
scripts it actually defines — no command outside this table is claimed to exist
here:

| Task | Command |
|---|---|
| Local dev against a MOCK host — synthetic replies, no real Buzz, no compute, no network | `npm run dev:harness` |
| Plain local preview — there is no host behind it, so nothing sends BLOCK_INIT | `npm run dev` |
| Local dev against the REAL Civitai backend with a dev token — spends REAL Buzz | `npm run dev:live` |
| Serve this app so `civitai app dev-tunnel` can reach it (run it in another terminal) | `npm run dev:tunnel` |

`npm run` lists every script, including any this CLI does not recognise. The
descriptions are the meaning `civitai app create` gives those names; if you wrote
your own script under one of them, yours is what runs.

- **Commit the lockfile.** The platform builds with `npm ci` and will not build
  without one. If you switch package manager, set `buildCommand` and `outputDir`
  in the manifest and commit that lockfile instead.
- **Do not hand-edit the `@civitai/*` versions.** `civitai app create` carries
  the pins that are known to work together; a hand-picked version is how the
  money path breaks silently.

### Gotchas — these defy reasonable assumptions

- **Buzz is the user's, not yours.** A generation submitted by your app debits
  the *viewer's* Buzz via their token. Always show a cost preview before
  submitting — estimate first, then submit.
- **A newly declared scope is consent-gated.** Adding a scope to the manifest
  does not grant it: it is dropped from the token until the user consents, so
  you get a 403 while the manifest and the runtime both look correct.
- **A hung hook is usually a missing HOST handler, not your bug.** The host
  silently drops messages it cannot handle, so an unanswered request looks
  exactly like a broken component. Check the host side before rewriting yours.
- **`useSharedStorage()` is postMessage-only.** There is no REST route for it —
  it cannot be scripted, seeded or written from a server.
- **`civitai app validate` is a local mirror. The server is authoritative.** A
  clean local validate is necessary, never sufficient.

<!-- END civitai agent-setup -->
