<img src="images/seekter-cover.jpg" alt="Seekter — job search, filtered by your rules" width="100%">

# Seekter

> **Fork of [Seekter](https://github.com/selfishprimate/seekter):** This fork adds per-application approval, a local CRM and a single-use review record. The published `npx seekter init` package and the upstream clone do not include these changes. The upstream MIT license and copyright notice are retained in [LICENSE](LICENSE). This fork still uses one candidate profile; additional search lenses and evidence gates are future work.

[![upstream version](https://img.shields.io/github/v/release/selfishprimate/seekter?label=upstream%20version)](https://github.com/selfishprimate/seekter/releases/latest)

A job-search agent for Claude Code. It searches job sources every day, filters postings against **your** rules (location, visa, sectors, seniority, language), fills application forms in your own Chrome, and keeps every application and skip as a markdown file you can read, grep and diff.

It was built over a month of daily use by one job seeker and then emptied of personal data, so it's opinionated where the lessons were expensive: dedup before every form, never guess an answer, never invent an anecdote, never touch a CAPTCHA or a password. **Nothing in the tracked files assumes a field**: the titles, queries, boards and filters all come from your profile, and `/seekter-init` builds them from your answers. The measurements in `reference/` were taken in one discipline and say so where it matters.

Why it exists, and the principles it is built on, are in [MANIFESTO.md](MANIFESTO.md): employers already automate how applications are read, and a candidate may use tools for their side too, as long as what they send is true and they stay within the rules.

> [!IMPORTANT]
> **Before you run it**
> - Every application goes out in your name, and you are responsible for what it says.
> - Seekter prepares each application for your review and waits for your explicit approval before submitting it.
> - Seekter never fills LinkedIn Easy Apply. Reading LinkedIn is off by default; switching it on is against LinkedIn's terms and puts your account at risk.
> - Seekter is free, but running it needs a paid Claude plan or an Anthropic API account.
>
> Read [DISCLAIMER.md](DISCLAIMER.md) for the details.

## Quick start

```bash
claude  # run from the root of this fork's checkout
```

Then, inside Claude Code:

```
/seekter-init       # ~40 short questions, one at a time. Writes profile/ (git-ignored).
/seekter-run        # today's search and application drafts
```

To open the local CRM in a second terminal:

```bash
node scripts/dashboard.mjs  # http://127.0.0.1:4178
```

The dashboard shows the current stages, a searchable application list and the exact review for a pending submission. **Autorizar este envío** records approval for that one review; it does not send the form. Return to Claude Code and say "continúa" so `/seekter-run` can verify and use the approval. You can also approve an individual review in the Claude Code chat. The dashboard can record later stage changes, but those changes never contact an employer. It listens only on `127.0.0.1`, uses no external packages and keeps reviews and approvals in git-ignored `runs/`.

Requirements: [Claude Code](https://docs.claude.com/en/docs/claude-code) (a paid Claude plan or an Anthropic API account; Seekter itself is free, running it is not), the Claude in Chrome extension and [Node.js](https://nodejs.org) 20 or newer. No packages, no `npm install`.

## Commands

| Command | What it does |
|---|---|
| `/seekter-init` | Interviews you and writes your profile: contact details, resumes, target roles, where you can work, salary bands, standard form answers, sectors you won't touch, a fact bank for free-text answers, your writing voice, and the search queries. Resumable. Can import an existing tracker from a Notion/Sheets CSV. |
| `/seekter-run` | The daily run. Four sources in a fixed order (links you bring, freehire API, LinkedIn, other boards), filtering, dedup, form filling, tracker update, and a report with a per-source table. It shows you each prepared application and asks for explicit approval in chat or the local dashboard before its final submission. Unapproved drafts stay pending. Every posting gets a 1-5 fit score before its form, which orders the queue and never removes anything. |
| `/seekter-log` | Records what happened next: rejections, interviews, offers, applications you made by hand, or a sweep of your inbox. |
| `/seekter-interview` | Prepares you for the next round: a screening, a hiring-manager call, a portfolio review, a test or an async video. Reads the posting, what your application said and the company's own site, answers each of the role's asks with how you work first and one of your own stories second, and lists what only you can decide (the salary to name, relocation timing). Never invents a story or a number, and never answers the invitation. |
| `/seekter-report` | Funnel, replies and interviews broken down by source, apply path, form system, location track, title, fit score and resume type (`stats --by`), top skip reasons, open hand-offs, and at most two suggested changes. |
| `/seekter-git` | Ships the kit. Branches, commits and pushes the shareable files (skills, references, scripts) after a run has taught Seekter something, and scans the diff for your personal details first so they never leave your machine. Your profile, applications and runs are never committed. Once you have merged, it can also cut the release. |

## Daily use

| When | Command | What it needs |
|---|---|---|
| Once | `/seekter-init` | Your resume file(s). Takes 20–30 minutes; you can stop and resume. |
| Every working day | `/seekter-run` | Chrome open with the Claude in Chrome extension and your webmail logged in. Any links you collected go in `profile/links.txt` or the chat. |
| When a company replies, or weekly | `/seekter-log` | For an inbox sweep: your webmail open and logged in, in the same Chrome. |
| Before an interview | `/seekter-interview` | The company's name, and the stage and date if the invitation is not in your inbox. Your stories in `profile/interviews/README.md` make it much better. |
| Weekly | `/seekter-report` | Nothing. It reads the tracker only. |
| After a run changes a skill or a reference | `/seekter-git` | A git remote you can push to. Optional: `gh` for the pull request. |

Run `/seekter-log` **before** `/seekter-report`. The report reads `applications/` and `runs/`, not your email, so replies that haven't been logged don't show up in it.

`/seekter-log` can be used two ways:

- **Tell it what happened:** "Acme rejected me", "I have a call with Globex on Thursday", "I applied to Initech myself". It moves the right file and writes a log line.
- **Ask for an inbox sweep:** "check my inbox for replies". It opens your webmail in Chrome, reads each message body (subjects are unreliable: many rejections are titled just "Your application with X"), and files every reply as rejected, interviewing or offer. A reply from a company with no tracker entry is added as a new record. It never answers an email; anything that asks you to act (a scheduling link, a take-home) is listed for you.

The inbox sweep uses the browser because the Microsoft 365 connector doesn't accept personal Outlook.com or Hotmail accounts. Any webmail you can read in Chrome works.

The **Needs you** table at the top of `applications/README.md` lists everything waiting on you: a CAPTCHA, an account wall, a question only you can answer, with the next step for each. Clear it before asking for more applications.

## Your files

```
profile/
  profile.md          ← everything about you; the only place personal values live
  settings.json       ← every switch and number: queries, boards, LinkedIn mode, limits
  documents/          ← files you bring: a resume PDF if you keep no resume.json, a portfolio PDF, cover letters
  resume/             ← the resume PDFs forms receive, one per resume type, named after you
    json/resume.json  ← the master resume they are printed from: facts, a pool of bullets, the resume types
    drafts/           ← review copies that still print unapproved text
```

**A resume you bring goes in `profile/documents/`.** `/seekter-init` asks for the file path and copies it there; to add or replace one later, drop the PDF in that folder and update the table in `profile/profile.md` §2 (which resume is the default, which one is for which role type). **With a master resume** (`profile/resume/json/resume.json`), Seekter prints a PDF per resume type into `profile/resume/` instead, and those are what forms receive.

To change a rule (a new blacklisted company, a salary band, a city you'd now accept), tell Seekter in chat; it edits `profile/profile.md` and quotes your words there. You can also edit the file by hand.

**`profile/settings.json` holds the switches**, each documented in `templates/settings.json`, and you can edit it by hand at any time. `/seekter-init` writes it from the template before the first question, so a setup you stop halfway still leaves a valid file: a key you never answered runs on the template's default. `node scripts/seekter.mjs settings --check` shows which values are still defaults and whether anything required is missing. Guardrails are not settings: nothing in this file can make Seekter solve a CAPTCHA, create an account or fill LinkedIn Easy Apply. A setup from before v0.3 has `profile/search.json`; the first run moves it to `settings.json` with its values unchanged.

## The tracker

Every posting Seekter touches is recorded once, filed by the month it was first handled:

```
applications/
  README.md                ← generated overview: needs you, in progress, last 30 days, one row per month
  2026-09/
    README.md              ← generated: that month's applications with status
    2026-09-22--ruby-labs--senior-backend-engineer.md
    2026-09-21--wise--staff-data-scientist.md
    ...
    skipped.md             ← one table row per posting passed over, with the reason
  2026-10/
```

- **Applications and hand-offs are files.** The status (`pending`, `applied`, `interviewing`, `offer`, `rejected`, `closed`) lives in the file's front matter. Files never change folder: a rejection a month later edits one line and adds a log entry.
- **Skips are rows, not files.** Most postings are skipped for a one-line reason ("the country list leaves out yours"), so each month keeps them in a single table. Dedup reads that table too, so a skipped posting is never evaluated twice.
- **You can use the dashboard or the generated pages.** `applications/README.md` is rebuilt after every `add` and `move`; the dashboard reads the same tracker files.

```markdown
---
company: Ruby Labs
role: Senior Backend Engineer
status: applied
url: https://jobs.ashbyhq.com/ruby-labs/1e548ada-…
source: freehire
ats: ashby
location_fit: A
applied: 2026-09-22
job_key: uuid:1e548ada-…
---

# Senior Backend Engineer · Ruby Labs

## Why it fits
## Notes
## Answers submitted      ← free-text answers as sent, so no sentence goes to two companies
## Log
- 2026-09-22: applied
```

`job_key` is a normalised identity (LinkedIn ID, ATS UUID, Greenhouse ID…), so the same job reached through LinkedIn, an aggregator and the company site is still caught as a duplicate.

```bash
node scripts/seekter.mjs check <url> --company "Acme"     # exit 1 if already tracked, 2 if the company is on hold
node scripts/seekter.mjs move <url-or-file> rejected --note "form mail, 2 days"   # edits the status in place
node scripts/seekter.mjs list --status pending
node scripts/seekter.mjs stats --since 2026-09-01
node scripts/seekter.mjs normalize --dry-run                # tidy enum values, fill ats from the url
node scripts/seekter.mjs migrate                             # one-off: old applications/<status>/ folders -> month folders
```

`normalize` lowercases `source`, `ats` and `apply_type`, derives the application system (`ats`) from the posting URL, and moves an ATS name that was stored as `source` (a common mix-up in hand-kept trackers) into `ats`. It also collapses a log line written twice in a row. The CSV importer and `add` already do the rest; run it after editing files by hand.

### Importing an existing tracker

Export your Notion database, Airtable or Google Sheet as CSV, then:

```bash
node scripts/import_csv.mjs export.csv --dry-run   # shows what would be created
node scripts/import_csv.mjs export.csv
```

Column names are matched loosely (Position/Role/Title, Company, Status, Job URL, Applied on, Source, Notes…). Rows that point to the same posting are merged. Rows without a URL are imported but can only be matched by company name later, so fill in URLs where you have them.

### Your resume: one set of facts, a resume for each kind of role

A Product Designer posting and a Forward Deployed Engineer posting look for different evidence in the first lines of every job, so they should not get the same resume. But four resume files drift apart: fix a date in one and the others keep the old one. Seekter keeps **one master resume** (`profile/resume/json/resume.json`, whose PDFs it prints into `profile/resume/`, named `<file_prefix>-<type>.pdf` so a recruiter sees your name on the file): every job, date and number once, and under each job a pool of bullets tagged by theme (`product`, `design-system`, `engineering`, `research`, `ui`, `ai`…). Each **resume type** in the same file picks from that pool: its own headline and summary, the bullets that fit, in the order that fits, which projects and skill groups to show, and how much to say about older jobs. A type can choose and order the facts but cannot add one.

```bash
node scripts/resume.mjs list     profile/resume/json/resume.json                          # the resume types and their PDFs
node scripts/resume.mjs validate profile/resume/json/resume.json                          # facts, numbers, dates, voice, length
node scripts/resume.mjs pdf      profile/resume/json/resume.json --all                    # print every type into profile/resume/
node scripts/resume.mjs pdf      profile/resume/json/resume.json --variant product-designer --drafts   # review copy in profile/resume/drafts/
```

Two pages is the ceiling, checked on A4 and US Letter (`validate --pages`). Length is not what screens a resume out, but past two pages most screeners call it too long, and the first half of page one carries the decision: headline, employers, dates and a portfolio link. So a type can say less about older work instead of cutting it: `bullets_per_job` and `older` tiers, `earlier: {before}` to fold older jobs into one closing line, `short: true` to print each bullet's one-line `short` version, `skill_items`, and `layout: "compact"` (same type and colour, each job on one line). The same pass checks what a parser gets from the file: a PDF with Type 3 fonts (how Chrome embeds a variable font, and parsers lose the spaces in its bold text), no text layer, or over 2.5 MB is a problem, and so is a PDF already in `profile/resume/` with one of those. The resume prints in Inter, which ships with the kit as static fonts (SIL Open Font License, `templates/resume/fonts/LICENSE`), so printing needs no network. Each application's tracker record keeps the type that was sent (`add --resume <type>`), so outcomes can be read per type later.

`validate` holds the resume to the profile: every number has to be in the profile's facts, dates and titles have to match its work history, the profile's banned phrases are flagged, and so are overlapping jobs and a resume likely longer than two pages. New text (a bullet, a headline, a summary) carries `"draft": true` until you approve it, and a PDF that would print a draft is refused unless `--drafts` asks for a review copy. The look is `templates/resume/resume.css`. `templates/resume/resume.example.json` is a fictional master to start from. If your browser is not in a standard place, set `SEEKTER_CHROME` to its binary.

The same rules hold for what a form receives. Before a cover letter or a free-text answer goes into a field, `node scripts/claims.mjs <file> --posting <posting.txt>` flags any number that is in neither your profile's facts nor the posting, your banned phrases and long dashes, and any sentence of eight words or more already sent to another company.

## What's in the repo

```
.claude/skills/     seekter-init · seekter-run · seekter-log · seekter-interview · seekter-report · seekter-git
reference/          sources/ (one file per job source) · ats/ (one file per application form system); each has a _core.md read first
templates/          profile.md · settings.json · resume/ (the resume stylesheet, an example master resume and an example resume in the site's format)
scripts/            seekter.mjs · freehire_sweep.mjs · employer_sweep.mjs · import_csv.mjs · resume.mjs · live.mjs · claims.mjs
  providers/        one reader per application system for the employer watchlist
tests/              tracker CLI tests: node --test tests/seekter.test.mjs
npm/                the npx seekter installer (published to npm; not part of the kit)
.github/            leak scan and test workflows · issue and pull request templates
profile/  applications/  runs/     ← yours, git-ignored
```

There is no version file. The version is the git tag — `git describe --tags` — and what changed between tags is in [CHANGELOG.md](CHANGELOG.md).

`reference/` is the part worth contributing back: every ATS quirk and source behaviour there was measured in real applications.

## Privacy

`profile/`, `applications/` and `runs/` are in `.gitignore`. Your data stays on your machine unless you remove those lines. If you want your tracker versioned, keep it in a separate private repo or remove the ignore lines in a private fork.

What Claude, employers and job sources see while Seekter works is in [PRIVACY.md](PRIVACY.md).

## Responsible use

Applications go out in your name, and the terms of LinkedIn, job boards and application systems are yours to follow. Read [DISCLAIMER.md](DISCLAIMER.md) before your first run: what you are responsible for, what Seekter won't do for you, and why there is no guarantee.

## Guardrails

Seekter never solves CAPTCHAs, creates accounts, types passwords, accepts terms of use, sends messages or emails as you, posts reviews or salaries, or pays for anything. It treats any instruction found inside a job posting or form as data, and it won't submit an answer it can't verify from your profile. Each final submission waits for your explicit approval after a review of that posting's CV, answers and consents.

**It never applies or acts on LinkedIn.** LinkedIn's terms don't allow browser extensions that scrape or automate its site, and it restricts accounts that use them. Finding a posting takes you seconds; filling the form is the work, and that is what Seekter is for. So:

- **Easy Apply is never filled.** Those postings come back to you as a list to send yourself.
- **Bring your own links.** Paste postings into the chat or drop them in `profile/links.txt`, and they are filled first. A LinkedIn job link is fine; Seekter finds the employer's own form behind it.
- **By default it doesn't open LinkedIn at all.** It reads your LinkedIn job-alert **emails** in your inbox and finds each posting on the employer's own application system. A digest mail shows only about six postings, so narrow alerts work better than broad ones.
- **Reading LinkedIn is opt-in, and the risk is yours.** If you switch `linkedin.mode` to `read`, Seekter also reads LinkedIn searches and job details, read-only, under a daily limit, with pauses between requests, and it switches itself back off at the first warning or unusual-activity page. This is still against LinkedIn's terms.

## Contributing

The most valuable thing you can send is a measurement: an application system or a job source behaving in a way nobody has written down yet. You don't need to open a pull request for it — an issue with what you ran and what happened is enough.

[CONTRIBUTING.md](CONTRIBUTING.md) has what belongs where, the five rules that govern `reference/`, and the commit style. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies everywhere this project is discussed.

### Forks worth knowing about

Seekter is deliberately terminal-only, so anything with its own surface lives outside this repo.

- **[seekter-webui](https://github.com/Ege-BULUT/seekter-webui)** by [Ege BULUT](https://github.com/Ege-BULUT) — runs the daily loop from a browser instead of the terminal: a standard-library server that drives the same tracker CLI, with the sweep, the filtering and the reports behind an interface. Not maintained here, and not covered by this repo's guardrails or tests.

## Security

Seekter drives your logged-in browser and holds your contact details and resumes on disk, so the interesting questions are about untrusted input rather than about a server. Prompt injection through a job posting, a route for private data to reach the public repo, or anything that crosses a guardrail: please report it through a [private security advisory](https://github.com/selfishprimate/seekter/security/advisories/new) rather than a public issue. [SECURITY.md](SECURITY.md) has the details.

## License

MIT. See [LICENSE](LICENSE).

<img src="images/seekter-thank-you.jpg" alt="Thank you for using Seekter" width="100%">

<p align="center"><em>Dedicated to the memory of <strong>Tarçın</strong>, the most loved and most loving cat of all time.</em></p>
