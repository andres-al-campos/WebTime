# Privacy Policy for Web Time

Last updated: September 2, 2026

Web Time is a browser extension that tracks how long you spend on websites and
lets you set session limits. It is built so that your data never leaves your
computer.

## The short version

Web Time does not collect your data, because it never sends anything anywhere.
There is no server, no account, and no analytics. Everything the extension
records is stored locally in your own browser and is readable only by you.

## What is stored

All of this lives in your browser's local extension storage
(`chrome.storage.local`), on your device:

- **Time per site, per day.** Stored as a domain name and a number of seconds —
  for example, `example.com: 1830` for a given date. The extension records the
  domain only. Full page addresses, page titles, paths, and search queries are
  never stored.
- **Session history.** When sessions started and ended for sites where you
  enabled session limits.
- **Your settings.** Session length, cooldown, reminder count, inactivity
  threshold, and your keyboard shortcut.

## What is not stored

Web Time does not record page content, text you type, passwords, form data,
clicks, mouse position, or scrolling. It does not know who you are: it collects
no name, email address, account, device identifier, or IP address.

The extension detects whether you are currently active in a tab, so it can stop
counting time when you walk away. This is used as a yes/no signal in the moment
and is never recorded.

## What is shared

Nothing. Web Time makes no network requests of any kind. Your data is not sent,
sold, rented, or disclosed to anyone, including the developer, and it is not
used for advertising, profiling, or creditworthiness.

All code runs from within the installed extension package. No code is loaded
from remote servers, and the charting library is bundled inside the extension
rather than fetched from a CDN.

## Permissions and why they exist

- **Site access (`<all_urls>`)** — to read the domain of the tab you are on and
  to show the on-page timer and reminder. The extension cannot know in advance
  which sites you will want to track, which is why access cannot be narrowed to
  a fixed list. Page content is not read.
- **`tabs`** — to know which tab is in the foreground, so time goes to the right
  site, and whether it is playing audio, so video keeps counting.
- **`storage`** — to keep your history and settings on your device between
  browser restarts.
- **`alarms`** — to wake the extension when a session limit or reminder is due,
  since the browser shuts down idle extensions.
- **`idle`** — to stop counting when you are away from your computer.
- **`offscreen`, `scripting`** — internal plumbing to keep the timer accurate
  and to restore the on-page timer in tabs that were already open.

## Your control over your data

Your data is on your machine, so you decide what happens to it. Uninstalling
Web Time deletes everything it stored; there is no copy anywhere else for us to
delete, because none was ever made.

## Changes

If this policy changes, the updated version will be posted here with a new date
at the top.

## Contact

Questions or concerns: open an issue at
https://github.com/andres-al-campos/WebTime/issues
