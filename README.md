# HCIM V3 Checklist

A lightweight, tickable checklist for [B0aty's HCIM Guide V3](https://oldschool.runescape.wiki/w/Guide:B0aty_HCIM_Guide_V3) on the Old School RuneScape Wiki.

- Every step of the guide is a checkbox, grouped by **episode → bank**, like the wiki page.
- Progress is saved in your browser (localStorage) and survives reloads and restarts.
- **Live wiki sync:** each time you open the site, it checks whether the wiki page was edited and pulls in the new version. Ticks follow their steps even when banks get renumbered. If a step you already ticked gets reworded, it keeps its tick and shows an **edited** badge.
- Bank screenshots from the guide are included. Tap one to enlarge it. Videos are left out.
- *Continue* jumps to the next step after your furthest tick. You can also search every step, undo, export and import backups, use the light and dark themes, and use keyboard shortcuts.
- It works offline once loaded, and you can add it to your phone's home screen.
- **Several guides:** the menu at the top switches between B0aty's original and the *HC Worlds edition*. Each guide keeps its own ticks, and a *What's changed* page lists every edit.
- No build step, no framework, no dependencies. About 85 KB of code plus a 240 KB snapshot of the guide.

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `hcim-checklist`. It must be **public** to use Pages on a free account.
2. Upload **everything in this folder**, keeping the folder structure. The quickest way is *Add file → Upload files* on the repo page: drag the whole folder contents in, then commit. Make sure the hidden `.nojekyll` file comes along too. If the web uploader skips it, create an empty file with that name from *Add file → Create new file*.
3. Go to *Settings → Pages*. Under **Build and deployment**, choose *Deploy from a branch*, pick `main` and `/ (root)`, then click Save.
4. After a minute the site is live at `https://<your-username>.github.io/hcim-checklist/`.

The site being public only means the page itself is public. Your ticks never leave your browser.

## Your progress

- Ticks are stored per browser and per device. Clearing site data for the page wipes them, so use **Settings → Export backup** now and then.
- To move to another device or browser, export on the old one and **Import backup** on the new one.
- The site asks the browser for persistent storage, so the browser is less likely to clear it on its own.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | The page |
| `css/style.css` | All styles (light and dark themes, mobile layout) |
| `js/parser.js` | Turns the wiki's wikitext into episodes, banks and steps |
| `js/render.js` | Formats step text: wiki links, quest and diary tags, dialogue options, NOTE and WARNING labels |
| `js/store.js` | Saving ticks, undo, export and import, matching ticks to steps after wiki edits |
| `js/sync.js` | Talks to the OSRS Wiki API |
| `js/app.js` | The UI |
| `data/guide.json` | Bundled copy of the guide, used until the live copy loads (and offline) |
| `guides/hardcore-worlds.json` | The *HC Worlds edition*: a list of edits (warnings, tips, removed or added steps) applied on top of B0aty's guide. Pick it from the menu at the top of the site |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Offline support and the "install" icon |
| `tools/update-snapshot.ps1` | Optional: refresh `data/guide.json` from the wiki |

If you change the code later, bump `CACHE` in `sw.js` (e.g. `hcim-v3-shell-2`) so returning visitors get the new files.

## Running it locally

It has to be served over HTTP, because opening `index.html` directly from disk won't work. Any static server will do, for example:

```
npx serve .
```

## Credits

The guide is written by B0aty (route by Tpapa) and lives on the [OSRS Wiki](https://oldschool.runescape.wiki/w/Guide:B0aty_HCIM_Guide_V3) under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). This checklist is an unofficial personal tool and is not affiliated with B0aty, the OSRS Wiki or Jagex.
