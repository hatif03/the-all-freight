# The All Freight — what it is, and why

> Plan a shipment before it moves. Watch it — and act — once it does.

This document is the narrative one: who is hurt by the problem, why the current
process fails, what this product does about it, and exactly where Anakin sits in
that. For requirements-language scope and formal use cases see
[`service/docs/REQUIREMENTS.md`](../service/docs/REQUIREMENTS.md); for how to run
it, the [README](../README.md).

---

## The problem

A container that sits at a port longer than its free time starts costing money
by the day. Demurrage (the box occupying terminal land) and detention (the
carrier's equipment held outside it) are billed per container per day, and the
rates are not small — the current Maersk US import tariff runs to three-figure
daily charges per box once free time lapses, rising through tiers the longer it
sits.

Three things make this worse than it sounds.

**It compounds silently.** A vessel dwelling at anchor isn't yet a bill. It
becomes one days later, by which point the decision that would have avoided it —
reroute, expedite, pre-clear, accept the wait — is no longer available. The
window in which action is cheap is exactly the window in which nobody has the
information.

**The information is public but scattered.** The carrier's tariff is a published
PDF. The port's advisories are on the port's own site. The rules governing how
and when a D&D charge may even be invoiced are federal law — 46 CFR Part 541
gives the billed party a defined window to dispute, and the carrier a defined
window to invoice. Freight rate indices are published weekly. None of it is
hard to find. All of it takes a person an hour to assemble, and the meter is
running while they do.

**So the response is a scramble.** Someone digs out the tariff document. Someone
else guesses at the reroute cost, because getting a real number means an email
and a wait. Someone asks whether the charge is even valid and nobody is quite
sure. A decision gets made on the loudest opinion in the thread, and no record
survives of why.

**Who this hurts:** importers and shippers holding the D&D liability, the
freight forwarders and 3PLs who field the call, and the ops manager who has to
choose in the next hour and justify it next quarter.

---

## What this product does

Three moves: research the lane before committing, keep watching it, and when
something breaks, argue it out with the evidence in hand and a human deciding.

### 1. Plan

Describe a shipment in plain language. A pipeline of agents researches it
against the live web and returns:

- a **risk score** decomposed into commodity, freight, port, weather,
  geopolitical, supplier and regulatory factors, each with its sources;
- a **cost and delay forecast** over 30/60/90 days;
- a **recommended entry port**, scored on real congestion reporting;
- **tariff and duty** exposure with the actual filing documents;
- a **dated action plan** you can export to a calendar.

Every figure carries the source it came from, and anything that couldn't be
sourced says so rather than being filled in.

### 2. Track

Tracking a shipment is what turns a one-off report into something continuous.
From that point the pages that determine what a disruption would cost *on that
lane* are put under scheduled monitoring:

- the destination port's advisories and notices,
- the carrier's published demurrage/detention tariff,
- the FMC billing rule that governs whether a charge is even valid.

When one of them changes, the change is recorded against the shipment as a web
signal — with the source page, so it can be checked.

Monitors are keyed by URL rather than by shipment, so twenty shipments through
Los Angeles share one monitor on the port's advisories, and a monitor is
dropped once the last shipment watching it is gone.

### 3. Act

A Sentinel agent watches a live AIS feed across three port complexes (Los
Angeles / Long Beach, New York / New Jersey, Singapore). When a vessel dwells
where it shouldn't, it opens a room and recruits six other agents across three
frameworks. They:

1. propose recovery options — reroute, hold, expedite, alternate supply;
2. cost each one against the carrier's **actual published tariff rows**, not an
   estimate;
3. vote to a quorum;
4. and then an adversarial **Dissent** agent, deliberately running on a
   different model from the agents it critiques, argues against the front-runner.

Then it stops and waits. A human reads the recommendation *and the objection*
and approves or rejects with a stated reason. Nothing acts autonomously. The
whole exchange — proposals, costs, citations, votes, dissent, decision and
reasoning — becomes an audit dossier.

---

## How the two halves are one product

The join is the **tracked shipment**. Planning produces one. Monitoring watches
its lane. An incident at its entry port attaches to it. That's why the watchlist
is the home page: it's the list of things the rest of the product is about.

```
describe → analyse → TRACK ──┬── page monitors → web signals ──┐
                             │                                  ├→ shipment activity
                             └── AIS at its port → incident ────┘
                                                     ↓
                                     agents negotiate → you decide → dossier
```

The attribution is deliberately conservative. A shipment links to an incident
only when its resolved entry port *is* the same monitored port, and the link
stores the sentence explaining why. It is labelled a **port-level match**,
because that is all it is — it does not claim the cargo is aboard the affected
vessel, and the available data could not support that claim.

Port resolution happens **once**, when a shipment is tracked, against a curated
alias list, and the matched alias is persisted. By the time an incident arrives
there is no string comparison left to do: matching is exact code equality. No
fuzzy scoring, no geographic proximity, and no LLM — asking a model "does *Los
Angeles, USA* mean LA/LB?" is precisely the kind of plausible-sounding guess this
product exists to avoid.

Most real lanes resolve to nothing, because only three ports are monitored. Those
shipments are shown as **not AIS-monitored**, in the watchlist and on the
shipment page, rather than being quietly attached to a nearby port.

---

## Where Anakin sits

Anakin is the live web layer. Four capabilities, each doing a specific job:

| Capability | Where it's used | What it makes possible |
|---|---|---|
| **Search** (`/v1/search`) | ~25–30 calls per analysis across the planning agents | Grounds every risk factor in current reporting instead of model recall, and produces the citations shown in the UI |
| **AI structured extraction** (`/v1/url-scraper/scrape` with `generateJson` + a JSON Schema) | Carrier tariff documents, freight indices, tariff filings, bill-of-lading lookup | **The load-bearing one.** Pointed at a carrier's published tariff PDF it returns the actual per-day rates, free-time days and tiers — which is what the ops-room agents then negotiate over. This is the difference between a costed option and a guess |
| **Deep research** (`/v1/agentic-search`) | A synthesis pass alongside the cited numbers | A multi-stage research report. Shown explicitly as *uncited synthesis* and never used as the basis for a figure the product asserts, since it returns no citation list |
| **Scheduled monitoring** (`/v1/monitors`) | Per tracked-shipment lane | Turns the product from a report into something continuous. `aiMode` with a per-target goal filters out navigation and footer churn, so an alert means something actually changed |

Two details worth noting. Extraction reaches pages that block ordinary requests
— the Port of Los Angeles site returns 403 to a plain fetch and yields real
dated notices through Anakin's proxy routing. And monitor deliveries are
HMAC-signed with a per-monitor secret, which matters because the receiving
endpoint is public.

Anakin's **Wire** catalog was evaluated and is deliberately unused: it covers
consumer and business websites and has no bill-of-lading, customs or trade-data
action, so there is nothing in it this domain can use. See
[`.agent/records/anakin-tariff-and-bol.md`](../.agent/records/anakin-tariff-and-bol.md).

---

## The rule the whole thing is built on

**Nothing is invented to fill a gap.**

- A cost with no tariff row behind it is reported as unavailable, not estimated.
- An importer match that can't be evidenced is labelled `inferred` with the
  basis that produced it, or omitted.
- A search that couldn't reach a source is marked, and its result never renders
  as a citation.
- A lane outside the monitored ports is shown as unmonitored.
- The ops room is empty when nothing is wrong, and says so — it is not a demo
  that plays on load.

This is why the interface talks about provenance so much. In a domain where the
output is used to argue with a carrier about an invoice, a number you cannot
source is worse than no number at all.

---

## What it deliberately doesn't do

- **It doesn't act on its own.** Every recovery decision stops at a human gate.
- **It doesn't file, book, or dispute anything.** It reads the world and
  reasons; it doesn't reach into a carrier's system.
- **It has no accounts.** The watchlist is a single shared workspace, which is
  a deliberate trade for a demonstrable build, not an oversight.
- **It doesn't claim cargo-level attribution.** Port-level is what the data
  supports, so port-level is what it says.
