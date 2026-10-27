# yoink

yoink saves elements from web pages as code inspiration. Point at a button, a card, a section or a
whole area, click, and yoink saves the element with its HTML, the styles that apply to it, its fonts
and images, and an image of how it looked. Each catch becomes a folder with a `README.md`.

macOS and Google Chrome only.

## Install

You need Google Chrome and Apple's Command Line Tools (they bring `python3`). No admin rights needed.

1. Unpack the zip anywhere, for example in Downloads.
2. Open Terminal, drag `install.sh` from the unpacked folder into the window and press Return.
   If something is missing, the script says what and installs nothing. The usual fix is
   `xcode-select --install` (Command Line Tools), then run `install.sh` again.
3. The script copies yoink to `~/Library/Application Support/yoink` and prints the next step.
   After that you can delete the unpacked folder and the zip.

## Load the extension in Chrome

Once, after installing:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `~/Library/Application Support/yoink/extension`.
   In the dialog, press Cmd+Shift+G and paste the path that `install.sh` printed.
4. Pin yoink to the toolbar if you like (puzzle icon, then the pin).

Chrome may show a note about developer-mode extensions when it starts. That is normal for
extensions that are not from the Chrome Web Store.

## Choose the save folder

On your first catch, yoink asks where to save. You can change the folder at any time: right-click
the yoink icon, then **Options**. Type a path or click **Choose…**. Earlier catches stay where they are.

Any folder works. It can be an Obsidian vault or a folder inside one; the READMEs use normal Markdown
links and images.

## Use it

- Press **Option+Shift+Y** (or click the yoink icon), point at an element and click.
- **Drag** to catch an area. Only what lies inside the frame is saved.
- **↑** / **↓** move the highlight one level up or down. **Esc** quits.
- **E** turns extras on for the next catches: widths 390 and 768 px, scrolling through tall
  elements, and for embedded code (for example component previews) an offline copy with everything it
  loads (`source-local.html`). Extras take longer and make the catch bigger.

When the catch is saved, the path of its `README.md` is copied to the clipboard.

### What is in a catch

| File | What it is |
|---|---|
| `README.md` | Title, source, date, selector, size, render check, gaps, colours, file list |
| `image.webp` | How the element looked (reference) |
| `element.html` | The element as a page of its own, with the computed styles on every node |
| `rules.css` | The page's CSS rules that match (hover, media queries, keyframes, fonts) |
| `fonts/`, `images/`, `videos/` | Files the element uses; `element.html` points to them |
| `source.html` | Original code of an embedded frame (srcdoc), unchanged |
| `source-local.html`, `source-files/` | With extras: the same code running offline |
| `sources/` | With extras: the page's stylesheets and scripts, for reading |
| `shader/` | GLSL of a WebGL effect |
| `image-390.webp`, `image-768.webp` | With extras: the element in narrower windows |
| `comparison.jpg` | When the render check differs by more than 10%: expected, actual, difference |

**Render check**: yoink renders `element.html` in Chrome without a window and compares it with the
captured image. The README states how many pixels differ. **Gaps** lists everything that could not
be saved or that differs, so you know what to look at before rebuilding.

## Uninstall

1. In Terminal, run `uninstall.sh` from the unpacked folder (or from
   `~/Library/Application Support/yoink`, before it is removed).
2. In `chrome://extensions`, click **Remove** on yoink.

Your saved catches are not touched.

## Limits

- macOS and Google Chrome only.
- Chrome does not let extensions work on `chrome://` pages, the Chrome Web Store or PDFs.
- Pages behind a login: the catch works, but widths that yoink has to render itself are rendered
  without your login.
- Video streams and canvas animations are saved as still images; WebGL effects bring their shader code.
- Content of frames from other sites (cross-origin iframes) is saved as an image with its address.
- The offset search in the render check needs `numpy`. Without it, the README says so; everything
  else works with the standard library.
- Catches contain content from other websites. Check the rights before you reuse anything.

## Troubleshooting

- **“yoink helper is not installed”** – run `install.sh` again.
- **“refused access” or “extension ID does not match”** – the extension was loaded from a different
  folder. Load it from `~/Library/Application Support/yoink/extension`.
- **“Folder is not writable” / “Folder not found”** – choose another folder in the options.
- **The folder dialog does not appear** – it may be behind the Chrome window. Or type the path in
  the options instead.
