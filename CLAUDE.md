# CLAUDE.md

tornrevive is Oxain's standalone, free Torn City reviver radar: one Tampermonkey userscript,
`tornrevive.user.js`. Separate from torncat and tornmerc; do not merge them.

- **Alerts only, never automates the game.** No clicking Revive, no moving or auto-confirming
  buttons, no page changes. `tests/core.test.js` rejects click/dispatch/submit/querySelector.
- **API only.** Never read or touch torn.com pages (the two existing revive scripts do; this one
  must not). `@connect` stays `api.torn.com`.
- **Chance is an estimate.** `Rev.chance` uses the wiki's numbers and only the revives *I* gave a
  target; say so in the UI, never present it as Torn's number.
- **Billing comes from `/user/revives`,** Torn's own record, never from the script's guesses.
- **The API key is the only secret.** Script storage only. Limited access.
- **Remote data never touches `innerHTML`.** Use `textContent`.
- **One file, no build.** Pure logic on `Rev`, exported for Node; DOM below the `typeof document`
  guard. A test per helper. `npm test`.
- **Release = bump `@version` + `Rev.VERSION`, `npm run meta`, commit, push.**
