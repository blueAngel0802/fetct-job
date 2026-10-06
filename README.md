# Job URL Collector Chrome Extension

Chrome extension for collecting original apply URLs from Jobright recommendations.

## Jobright Flow

1. Open `https://jobright.ai/jobs/recommend`.
2. Click the extension icon.
3. Optional: upload an older `.md` export with **Skip URLs from MD** so already-seen URLs are ignored.
4. Press **Start**.
5. Each Start creates a new daily version: `V1`, `V2`, and so on for that date.
6. The content script first uses the current card's own apply button, supporting **Easy Apply**, **Apply with Autofill**, **Apply without Autofill**, **Apply now**, and **Apply**. If no card-level apply button is visible, it opens the card and searches the detail pane.
7. The extension captures the external job URL from the opened tab, closes that tab, then scrolls for more jobs.
8. Press **Stop** to stop the active run. Saved results stay in extension storage.
9. Select fetched jobs manually, or choose a domain group and click **Select domain**.
10. Click **Open selected** to open those URLs as background tabs.

## Saved Data

The popup shows fetched jobs as a selectable list. The Markdown export is grouped by version. Each version is grouped into source sections:

- `No-linkedin url`
- `Lever`
- `ADP`
- `Workable`
- `Paylocity`
- `ZipRecruiter`
- `Dice`
- `Rippling`
- `BambooHR`
- `Workday`
- `Greenhouse`
- `Linkedin`

Each section uses table columns: `Company`, `Role`, `URL`. The URL column stores the full raw URL text. The Download button saves a `.md` file.

LinkedIn and Greenhouse jobs are grouped into their own source sections. Ashby (`ashbyhq.com`) and iCIMS (`icims.com`) URLs are skipped. URLs imported from an older Markdown export are also skipped during future runs.

Duplicates are skipped by `company + role + url` across the saved memory list.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Reload the extension after code changes.

Use this only on pages you are allowed to access and collect from.






