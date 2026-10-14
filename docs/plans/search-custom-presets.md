# Search forms: custom dropdown presets, button-group presets, Material date inputs

branch: search-custom-presets
slug: search-custom-presets

## Intent

Search-form discovery fills a search or filter form with the last N months
(`--search-months`, default 3) and follows the results. Today it recognises a
date-range preset only as a native `<select>` option or a radio, and a date
field only as `<input type=date|datetime-local>` or a text input whose hints
read like a date. The target app (Angular Material) offers "Quick Date/Time"
as a `mat-select` — a `role="combobox"` whose options render in an overlay at
the end of `<body>` — and `matDatepicker` text inputs typed as `MM/DD/YYYY`.
Neither is recognised, so the search is submitted empty and the result pages
behind it are never audited. After this change the crawler opens custom
dropdowns, chooses a preset from wherever their options render, chooses
button-group and `role="radio"` presets, fills Material-style date inputs in
their placeholder's format, and says in the report what it chose for every
form.

## Acceptance criteria

1. On a search form whose only date control is a custom dropdown
   (`[role="combobox"]`, `[role="listbox"]` or `button[aria-haspopup="listbox"]`)
   with options rendered in an overlay at the end of `<body>`, the crawler
   opens it (click; Alt+ArrowDown when a click shows no options), reads the
   `[role="option"]` texts, chooses the narrowest preset of at least
   `--search-months` by clicking the option (Enter as a fallback), closes any
   dropdown it left open (Escape), submits, and audits the result pages
   (`foundBy: "form"`). `report.json`'s `pages[].search.forms[].preset` names
   the option ("Last 6 months" among Last 7 days / Last 30 days / Last 6
   months / Last year).
2. A custom dropdown with no date presets in the same form (a "Status"
   dropdown: All / Open / Closed) is opened, left unchanged, and closed again;
   a bare "All" is a preset only in a list that has a dated preset too.
3. When no preset reaches `--search-months`, the widest one is chosen ("Last
   30 days" rather than nothing), and the coverage notes say the widest
   preset was N days.
4. Presets rendered as `button[aria-pressed]`, `[role="radiogroup"] button`
   or `[role="radio"]` are chosen by the same rule. `presetMonths` reads
   "Last/Past/Previous N days|weeks|months|years", bare "N months" / "90
   days", "last month|quarter|year", "YTD" / "year to date" / "this year"
   (months since 1 January), and "all" / "all time".
5. Text inputs with a date placeholder, aria-label or label (MM/DD/YYYY,
   DD/MM/YYYY, YYYY-MM-DD), or with a datepicker toggle beside them
   (`mat-datepicker-toggle`, a button labelled "calendar"), are filled as the
   from/to pair in that format (MM/DD/YYYY when only a toggle says it is a
   date), with input, change and blur events, so a framework model that
   listens to `input` sees the value.
6. One preset is enough: a native `<select>`/radio/button preset found first
   means custom dropdowns are not opened; any preset means the date fields
   are left alone (as today).
7. The coverage notes say, for each searched form, what it used: `Search form
   on /x.html: chose 'Last 6 months'`, `... chose 'Last 30 days', the widest
   preset (30 days), shorter than --search-months 3`, or `... filled
   07/13/2026 to 10/13/2026`. `--search-months 12` on the dropdown fixture
   chooses "Last year".
8. Four fixture pages (custom combobox; widest preset 30 days, opened only
   by Alt+ArrowDown; button-group and role="radio" presets; Material-style
   date inputs) are linked from `test/fixtures/about.html`, asserted in
   `test/search.mjs`; the golden human output is regenerated if the fixture
   site's output changes.

## How this fails silently

1. **(a) Custom comboboxes skipped.** Mutation: `fillCombos` returns without
   opening anything. Red: the combobox fixture's result pages
   (`/result-21.html`) are not audited.
2. **(b) First option instead of the narrowest ≥ months.** Mutation: pick
   `opts[0]`. Red: the combobox fixture's preset is "Last 7 days", not "Last
   6 months".
3. **(c) Nothing chosen when no preset reaches months.** Mutation: drop the
   widest fallback. Red: the 30-day fixture's preset is null and the "widest
   preset (30 days)" note is missing.
4. **(d) Material inputs filled in ISO.** Mutation: `formatFor` returns ISO
   for text inputs. Red: the datepicker fixture (whose server accepts only
   MM/DD/YYYY) lists no results; its result pages are not audited.
5. **(e) Dropdown left open.** Mutation: skip the Escape close. Red: the
   combobox fixture's submit records that a listbox was still open (its
   marker `#overlay-closed` is absent), the server answers nothing, and the
   result pages are not audited.

## Non-goals

- Readonly date inputs that accept a date only through the calendar popup.
- Choosing a preset across kinds by width (a short native preset does not
  send the crawler on to custom dropdowns).
- Calendar-popup navigation, multi-select dropdowns, typeahead comboboxes
  that need typed text to show options.
- Any dashboard (`ui/`) change.
