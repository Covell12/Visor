# Visor — sidebar copy replacement form

Every piece of writing in the side panel longer than ten characters, roughly in
the order you meet it. Change what you want and leave the rest blank —
**anything left blank stays exactly as it is.** Send the whole file back.

**`{…}` is a value filled in while running** — a number, a name, a date. Keep one
`{…}` for each that appears in the current text. You can move them around; do not
add or remove any.

Screen-reader labels and tooltips are marked; those are never visible on screen.

---


## Header & document scope

### 001 · on-screen text
CURRENT: Open a document
REPLACE: Open a Document

### 002 · on-screen text
CURRENT: Visor reads the writing history of a Google Doc or Slides file you have open.
REPLACE: Visor reads the history of Google Docs or Slides you have open.

### 003 · on-screen text
CURRENT: No document
REPLACE: No document

### 004 · screen-reader label
CURRENT: Switch between light and dark theme
REPLACE:

### 005 · screen-reader label
CURRENT: Re-read revision history
REPLACE:

### 006 · screen-reader label
CURRENT: Document tab
REPLACE:

### 007 · tooltip
CURRENT: Switch theme
REPLACE:



## Empty & error states

### 008 · on-screen text
CURRENT: Revision history is for editors
REPLACE: Revision history is only accessible to accounts with editing permissions

### 009 · on-screen text
CURRENT: You have view access to this document, so Visor will not show its writing history — no contributors, no timings, no replay.
REPLACE: Visor cannot show writing history becase you do not have editing permissions for this document.

### 010 · on-screen text
CURRENT: This matches how Google Docs itself works: version history is an editing capability. Ask the owner for edit access if you need it.
REPLACE: Ask the owner for edit access if you wish to view the writing history.

### 011 · on-screen text
CURRENT: No history yet
REPLACE:

### 012 · on-screen text
CURRENT: This document has no recorded edits to analyze.
REPLACE:

### 013 · on-screen text
CURRENT: Could not read history
REPLACE:

### 014 · on-screen text
CURRENT: Something went wrong.
REPLACE:

### 015 · on-screen text
CURRENT: Reading revision stream…
REPLACE:

### 016 · on-screen text
CURRENT: Folding every edit in order. Nothing is sampled.
REPLACE:

### 017 · on-screen text
CURRENT: Reload the document tab so Visor can attach to it, then try again.
REPLACE: Reload the document tab so Visor can analyze it, then try again.

### 018 · on-screen text
CURRENT: Lost contact with the document tab.
REPLACE:



## Tab bar

### 019 · on-screen text
CURRENT: Live replay
REPLACE:

### 020 · on-screen text
CURRENT: Document growth
REPLACE:

### 021 · on-screen text
CURRENT: When it was written Expand
REPLACE:

### 022 · on-screen text
CURRENT: Contributors
REPLACE:

### 023 · on-screen text
CURRENT: Attribution is per-character: every surviving character is traced to the edit that inserted it.
REPLACE: Attribution is recorded by character.

### 024 · on-screen text
CURRENT: Surviving text by author
REPLACE:

### 025 · on-screen text
CURRENT: Writing sessions
REPLACE:

### 026 · on-screen text
CURRENT: A session breaks after five minutes of inactivity or when the author changes.
REPLACE: A session ends after five minutes of inactivity.

### 027 · on-screen text
CURRENT: Each entry is a single insert operation. Text this size did not arrive one keystroke at a time.
REPLACE: Each entry is a single insertion operation.

### 028 · on-screen text
CURRENT: Text that was written and then removed. It exists in no export of this document — only in the edit stream.
REPLACE: Deleted text.

### 029 · on-screen text
CURRENT: This is a count, not a score.
REPLACE: (get rid of the current text entirely)

### 030 · on-screen text
CURRENT: How the text arrived
REPLACE:

### 031 · on-screen text
CURRENT: Every character ever inserted, counted by how it got into the document. Typed means it appeared one keystroke at a time. Copied or moved within is text that was already somewhere in this document — ordinary editing, and not counted against anyone. Only pasted in from outside came from elsewhere.
REPLACE: How every character in the document was added. Internal pastes are instances of copying and pasting text from one part of the document to the other. External pastes came from outside the document. (note to claude---use internal/external paste wording everywhere instead of move within or other terms for the same thing)

### 032 · on-screen text
CURRENT: What was measured
REPLACE:

### 033 · on-screen text
CURRENT: Watch it get written, character by character
REPLACE: Watch a character-by-character replay of the document development process.

### 034 · on-screen text
CURRENT: There is no rating model here and no weighting. The figure is the share of characters that arrived as blocks from outside this document, counted directly from its edit history. Everything below is measured alongside it and changes nothing. Treat it as evidence to discuss, never as a verdict on a person.
REPLACE: This is the amount of characters that were pasted directly from outside the document.

### 035 · screen-reader label
CURRENT: Sort pastes
REPLACE:

### 036 · screen-reader label
CURRENT: Sort deletions
REPLACE:



## Overview tab

### 037 · on-screen text
CURRENT: Not enough edits to chart.
REPLACE:

### 038 · on-screen text
CURRENT: No timestamped activity.
REPLACE:

### 039 · on-screen text
CURRENT: {…}{…} less more {…}
REPLACE:

### 040 · stat caption
CURRENT: edit operations
REPLACE:

### 041 · stat caption
CURRENT: active writing
REPLACE:

### 042 · stat caption
CURRENT: chars deleted
REPLACE:



## People tab

### 043 · on-screen text
CURRENT: No contributors recorded.
REPLACE:

### 044 · on-screen text
CURRENT: This document's history does not separate its authors, so all edits are shown together. Totals and timings are still exact.
REPLACE: (tell me in what instance this text would be displayed on the screen in our chat, but keep the wording constant)

### 045 · on-screen text
CURRENT: Google did not include {…}, so they are numbered in the order they first edited. Everything measured about them is exact.
REPLACE: Google did not include {…}, so they are numbered in the order they first edited.

### 046 · on-screen text
CURRENT: {…} {…} {…} {…} {…}% {…} INSERTED {…} DELETED {…} ACTIVE {…} WPM typed {…}% pasted {…}%
REPLACE:

### 047 · on-screen text
CURRENT: No surviving text to attribute.
REPLACE:

### 048 · on-screen text
CURRENT: No contributions to compare.
REPLACE:

### 049 · label
CURRENT: Share of contribution by author
REPLACE:



## Timeline tab

### 050 · on-screen text
CURRENT: No sessions recorded.
REPLACE:

### 051 · on-screen text
CURRENT: {…} {…} {…} +{…} / −{…} chars · {…} edits{…}
REPLACE:



## Evidence tab

### 052 · on-screen text
CURRENT: No bulk inserts. Every character was typed in.
REPLACE: No bulk pastes.

### 053 · on-screen text
CURRENT: Nothing substantial was deleted.
REPLACE:

### 054 · label
CURRENT: copied within
REPLACE: internal pastes



## Signal tab

### 055 · on-screen text
CURRENT: Fewer than {…} recorded edits — too little to describe how the text arrived.
REPLACE: Fewer than {…} recorded edits

### 056 · on-screen text
CURRENT: {…} of {…} characters ever inserted arrived as blocks that were not already in this document. The rest was typed here or moved around inside it.
REPLACE:

### 057 · on-screen text
CURRENT: Nothing measured yet.
REPLACE:

### 058 · on-screen text
CURRENT: {…} characters in {…} paste{…}
REPLACE:

### 059 · on-screen text
CURRENT: No text recorded yet.
REPLACE:

### 060 · on-screen text
CURRENT: Not enough history
REPLACE:

### 061 · label
CURRENT: Typed keystroke by keystroke
REPLACE:

### 062 · label
CURRENT: Copied or moved within this document
REPLACE:

### 063 · label
CURRENT: Pasted in from outside
REPLACE: External pastes



## Expanded activity sheet

### 064 · on-screen text
CURRENT: Activity over time
REPLACE:

### 065 · on-screen text
CURRENT: Who wrote it Characters Edits Time
REPLACE:

### 066 · on-screen text
CURRENT: Time of day
REPLACE:

### 067 · on-screen text
CURRENT: Day of week
REPLACE:

### 068 · on-screen text
CURRENT: Every writing day
REPLACE:

### 069 · on-screen text
CURRENT: Each row shows that day's edits across the 24 hours it was worked on, midnight to midnight.
REPLACE: Each row displays one day's edits.

### 070 · screen-reader label
CURRENT: Close statistics
REPLACE:

### 071 · screen-reader label
CURRENT: Time grouping
REPLACE:

### 072 · screen-reader label
CURRENT: Contribution measure
REPLACE:

### 073 · on-screen text
CURRENT: {…} active day{…}
REPLACE:

### 074 · on-screen text
CURRENT: busiest day · {…} edits
REPLACE:

### 075 · on-screen text
CURRENT: Nothing to show.
REPLACE:

### 076 · on-screen text
CURRENT: {…} {…}–{…} {…} 00 06 12 18 24 {…} edits +{…} / −{…} {…} active {…} {…}
REPLACE:

### 077 · stat caption
CURRENT: days worked on
REPLACE:

### 078 · stat caption
CURRENT: edits per active day
REPLACE:

### 079 · stat caption
CURRENT: most common hour
REPLACE:

### 080 · stat caption
CURRENT: longest single session
REPLACE:

### 081 · stat caption
CURRENT: longest gap (days)
REPLACE:



## Single-edit sheet

### 082 · on-screen text
CURRENT: Text removed
REPLACE:

### 083 · on-screen text
CURRENT: Every keystroke in this edit
REPLACE:

### 084 · on-screen text
CURRENT: One row per operation, with the gap that preceded it.
REPLACE: One row per operation

### 085 · screen-reader label
CURRENT: Replay this edit
REPLACE:

### 086 · screen-reader label
CURRENT: Replay speed
REPLACE:



## Elsewhere

### 087 · stat caption
CURRENT: characters added
REPLACE:

### 088 · stat caption
CURRENT: characters removed
REPLACE:

### 089 · stat caption
CURRENT: typing rate
REPLACE:

