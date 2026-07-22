# SendMySeller

A guided intake form for sellers, wholesalers, bird dogs, realtors, consultants,
and referral sources to submit deal leads — feeding an admin-only CRM to
review, note, and export them. Hosted on GitHub Pages; data lives in a Google
Sheet you own via a small Apps Script backend (see [`SETUP.md`](SETUP.md)).

**Live tool:** https://sendmyseller.com/

---

## What It Does

**Public side** — a short step-by-step wizard:

1. Disclaimer that any payment terms are confirmed with admin before closing.
2. Role (seller, bird dog/connector, wholesaler, realtor, consultant,
   associate, referral source) + email + phone (required) + social link
   (optional).
3. Seller/Realtor/Broker contact info (name + at least phone or email) —
   skipped automatically when the submitter's own role is Seller, since it'd
   just duplicate what was already collected.
4. Full U.S. property address + number of units (required for everything).
5. Asset type — Commercial (with subtype), Business (free text), or
   Residential 1-unit (beds/baths required, sqft optional) — with a standing
   disclaimer that the asset must currently be generating monthly income.
6. **Income, mandatory, shape depends on asset type:**
   - Residential: if occupied, Annual NOI directly; if vacant, a rentcast.io
     monthly rent estimate + annual property taxes + annual insurance, with
     NOI computed live from those three.
   - Commercial: Annual NOI directly.
   - Business: Annual Revenue + Annual Earnings, with the earnings field
     dynamically relabeled SDE or EBITDA based on size (EBITDA once revenue
     exceeds $5M or earnings exceed $1M, SDE otherwise).
   A standing disclaimer tells the submitter to keep searching for other
   opportunities if this information isn't available for a given deal.
7. Total existing debt (or "I don't know").
8. Whether the seller would allow a new senior/1st-position mortgage.
9. Whether the seller would accept a down payment + monthly payments +
   remainder-over-time structure.
10. Price sought and how they arrived at it.
11. Down payment needed to reach their next stage (optional / skippable), and
    whether the seller would accept less if that full amount isn't possible.
12. On-market or off-market, plus an optional link to where the listing was
    found.
13. Review and submit.

**Admin side** — behind an "Admin Access" password gate (with code-word based
password recovery by email):

- CRM table of every submission, click through to a detail view.
- Raw submitted data is never editable or deletable — only a `Status` field
  can be changed, and admin notes are appended underneath (also never
  deleted), keeping the original input intact permanently.
- **Export to Google Sheets** — snapshots every current lead + its notes into
  a new, timestamped sheet tab.
- **Delete All CRM Data** — only unlocked immediately after a successful
  export (enforced server-side, not just in the UI), and requires three
  separate confirmations, the last of which requires typing `DELETE`.

**Non-admin "Check Status On My Existing Leads"** — a submitter can look up
every lead they've filed by re-entering the same email address, no password.
That's a deliberate tradeoff: knowing the email is the only access check, so
the intake wizard shows a persistent reminder (once an email's been entered)
that leads and notes will be reachable under that exact address, and
recommends using one only they control. They can add their own notes but
never edit or delete the original submission, and they only ever see their
own notes — any internal notes you add as admin stay admin-only (notes are
tagged by author server-side to enforce that split).

Nothing here is a build step or a framework — plain HTML/CSS/JS, same spirit
as [`offer-wizard`](https://github.com/pharaohm33/offer-wizard), except this
one needs real persistent storage across visitors and sessions, which is why
it talks to a Google Sheet instead of encoding everything into a URL.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure for both the public wizard and the admin CRM |
| `app.js` | All wizard logic, admin CRM logic, and API calls |
| `config.js` | The one thing you edit after deployment — your Apps Script Web App URL |
| `backend/Code.gs` | The entire backend — paste into a Google Sheet's Apps Script editor |
| `SETUP.md` | Step-by-step deployment instructions |

*Internal use — Suede Buffalo LLC*
