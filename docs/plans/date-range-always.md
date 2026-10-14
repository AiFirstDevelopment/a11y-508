# Date range always set: every search runs with the last N months

slug: date-range-always

## Intent

Only the search-form pass fills a search screen's date range today. The other
passes that press a search control (click discovery's buttons and script
links, the disclosure pass that activates controls with Enter and Space after
the Tab pass has walked the fields, route variants and re-crawls that load the
page again) submit with whatever the app defaults to, on the target app (an
Angular Material screen with a "Quick Date/Time" dropdown that defaults to
"Last 24 hours") a search that returns nothing. The rule after this change:
if a page has a date range, it is at the last `--search-months` months
(default 3) for every search, whatever else the crawler is doing. On every
page load the crawler sets each search or filter scope's date range with the
search pass's own selection logic, without submitting; before any pass
activates a submit-like control in such a scope it re-reads the range and
sets it again if the app reset it; and the report says so once per form.

## Acceptance criteria

1. On every page load (the first load of an audited page and every reload any
   pass makes), before the static checks and before any pass activates a
   control, each search or filter scope that has a date range or a date-range
   preset (a native or custom dropdown, a button or radio preset, date or
   datepicker inputs, as `A.fillSearch` reads them) and a control named like a
   search (or a search box) is set to the last `--search-months` months: the
   same choice as the search pass (narrowest preset of at least N months,
   else the widest for custom dropdowns and button groups, else the date
   fields from N months ago to today), once per scope, with nothing
   submitted. A scope with a button named like an action (Clear, Reset) is
   still set, since nothing is submitted. A scope with no date range is left
   alone, and so is any field that is not part of the range.
2. Before click discovery clicks, or the disclosure pass presses Enter or
   Space on, a submit-like control inside such a scope (`type=submit`, or a
   button, `role=button` or script link whose name reads search, filter,
   apply, go, find, run or show results; or Enter on a field of the scope),
   the crawler re-reads the scope's range (the preset shown, the option or
   button chosen, the dates typed) and, if the app changed it, sets it again
   first. No search on the fixtures runs with the app's default range.
3. The coverage notes say once per form, not per load or activation:
   `Search form on /search-quick.html: date range set to the last 3 months
   (Last 6 months preset) before every search` (or `(dates 07/14/2026 to
   10/14/2026)`, or, when the widest preset is short, `(Last 30 days, the
   widest preset)`). The search pass's own per-search notes are unchanged.
4. Fixtures, linked from `about.html`, whose server records every search with
   the value it was submitted with:
   - `search-quick.html`: a "Quick Date/Time" custom dropdown defaulting to
     "Last 24 hours" (options up to "Last 6 months"), a Clear button (so the
     search pass skips the scope as an action), a "Search" button reached only
     by click discovery (an `onclick` button that loads a results page for the
     chosen preset) and a "Show results" button reached only by the
     disclosure pass (`aria-expanded`, results shown in place). Results list
     rows only for a preset of 3 months or more; the results page and the
     result pages behind it are audited, and the in-place results are
     re-checked (`after activating "Show results"`).
   - `search-reset.html`: a from/to MM/DD/YYYY pair whose script resets both
     to today on focus (the Tab pass focuses them) and a "Search" button the
     disclosure pass activates; its results appear only for a range of about
     three months, and are re-checked in place.
   Every search the fixtures record carries the 3-month value.
5. `--no-forms` turns all of it off: no fill on load, no re-apply, no note;
   the README's search paragraph says so in one sentence.

## How this fails silently

1. **(a) On-load fill skipped.** Mutation: `applyRanges` returns before
   filling. Red: `/search-quick.html`'s click-discovery search records "Last
   24 hours" and its results page lists nothing, so `/result-61.html` is not
   audited.
2. **(b) No re-apply before activation.** Mutation: `guardRange` never
   re-fills. Red: `/search-reset.html`'s disclosure search records today to
   today, and its results are not re-checked (`after activating "Search"`).
3. **(c) Filled only in the search pass.** Mutation: both `applyRanges` and
   `guardRange` return at once. Red: `/search-quick.html`'s "Show results"
   (disclosure pass) records "Last 24 hours" and its results are not
   re-checked.
4. **(d) Note per activation.** Mutation: the range record pushes an entry on
   every fill instead of once per scope selector. Red: the test asserting
   exactly one note for the quick-date form.
5. **(e) `--no-forms` still fills.** Mutation: `applyRanges` ignores
   `opts.forms`. Red: under `--no-forms` the click-discovery search records a
   preset other than "Last 24 hours".

## Non-goals

- Same-origin frames: scopes inside frames are not filled on load (the
  disclosure pass's frame documents are not guarded).
- The search pass's own fill, choice and notes are unchanged.
- The Tab pass only moves focus; it activates nothing, so it needs no guard.
- No UI change, no `ui/dist` rebuild.
