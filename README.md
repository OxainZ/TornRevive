# Torn Revive Radar

A free Tampermonkey userscript for revivers in Torn City. It watches your clients, contract
factions and friends through the Torn API and alerts you when one is in hospital, revivable by you
and worth the energy. It is alerts only: you open the profile and click Revive yourself.

## Install

1. Install Tampermonkey (Firefox or Chrome).
2. Open the install link and click **Install**:
   https://raw.githubusercontent.com/OxainZ/tornrevive/main/tornrevive.user.js
3. Reload torn.com and click **Revive** at the bottom left.
4. Under **Settings**, paste a **Limited** API key.
5. Under **Clients**, add players or factions, then press **Start radar**.

**TornPDA:** Settings > User scripts > add > Remote URL, paste the same link.

## What it does

- **Clients and contracts:** a player or a whole faction. Alerts when someone is in hospital and
  revivable by you, under the terms you set: only when they are online / idle / offline, a minimum
  success chance, and skip while they have early discharge (they may want to use it).
- **Your chance, estimated:** 90% + your skill/10, minus 4 to 8% for each revive they got in the
  last 24 h, fading over the day (the wiki's numbers). It counts the revives *you* gave them; others'
  revives are invisible to the API, so the real number can be lower. Your skill is read from your
  own revive history, or set it by hand.
- **Billing:** the last 7 days of your revives from the API, the record Torn keeps, as one line per
  revive (time, target, faction, chance, result, early discharge) plus totals per client and
  faction with the energy spent, so you can bill for attempts or successes without arguing.
- **Revivable means for you:** Torn reports `revivable` for the account behind the key, so a "no"
  can be friends-and-faction only, not revives off.

Alerts are a desktop notification, a sound and the tab title.

## API use

- Only `api.torn.com`, never torn.com pages. It does not read or change the hospital page.
- At most 60 requests a minute. One tab polls.
- Anyone in hospital is checked every 30 s, everyone else every 2 minutes; your revive history
  every minute.

## What it will not do

It never clicks Revive, moves buttons, confirms, or changes pages. Every revive is your click.

## API key terms

| | |
|---|---|
| Data storage | Settings stay in this browser's script storage |
| Data sharing | None. Requests go only to api.torn.com |
| Purpose | Read client status, your revive history and skill for your own alerts and billing |
| Key storage and sharing | Stored locally, never shared |
| Key access level | Limited |

## Licence

MIT.

## Develop

`npm test` runs the pure logic tests with Node's built-in runner. `npm run meta` regenerates the
update file. No build step.

Fan-made, not affiliated with Torn.
