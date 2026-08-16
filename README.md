# Heading Links

Four small things for links between notes, all in Live Preview.

## Breadcrumbs while editing

`[[Recipes#Bread#Sourdough]]` reads as `Recipes > Bread > Sourdough`.

Obsidian already does this in Reading view, but in Live Preview the link stays raw. Put the cursor on it and the raw text comes back, the same as any other link. Click to open, ctrl or middle click to open in a tab.

Nested anchors work: every `#` becomes a step.

![](docs/breadcrumbs.gif)

## Which notes link to a heading

At the end of a heading line, the names of the notes that link to it.

Click a name to open it, ctrl+hover to preview. A note linking to its own heading is not listed, since that tells you nothing.

![](docs/backlinks.gif)

## Which notes link to the note

The same at the end of the note title, for the note as a whole. What shows here is what no heading claims: `[[Recipes]]` and `[[Recipes#^abc123]]`. A link into a heading is named under that heading instead, so no note is listed twice on the screen.

The title is what renames the file, so the names are pulled out while you are editing it and come back when you leave.

## The headings someone linked to

Next to the title, `+3 headings` counts the headings of this note that other notes point at. Click it and the list opens: each heading with the notes that wrote the link. Click a heading to jump to it, click a note to open it.

The badge at each heading already says this in place, but only once you have scrolled there. The count is the part you can see from the top of a long note.

## Install

Not in the community store. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/heading-links/`, or point [BRAT](https://github.com/TfTHacker/obsidian42-brat) at this repo.

## Settings

Each of the four can be turned off on its own. Breadcrumbs can also be applied to `![[Note#Heading]]` embeds, which is off by default.

## Tests

`node test/test.js` checks the parsing: nested anchors, heading matching, and which note ends up credited under which heading. No Obsidian needed, the API is stubbed.
