# SK005 — Frontera Systems Official Pitch Deck

- Status: **Draft v1 — Repository-Backed**
- Program: Sales Kit Program, SK005
- Repository: `architects-of-change-protocol/aoc-enterprise` (Frontera Systems)
- Branch: `claude/aoc-enterprise-pitch-deck-jvetve`
- Mode: Commercial design. No production code. No website implementation.
- Audience: CTO, VP Engineering, VP Product, Head of Platform, Enterprise Founder, Technical Co-Founder
- Objective: earn a **Technical Assessment**, not explain every technical detail

## Role of this document

This is the official commercial narrative for Frontera Systems. It is the
source of truth for every downstream commercial asset — Enterprise
Landing, Governed Access Landing, Assurance Landing, One Pager, Executive
Brief, Technical Assessment Proposal, website messaging, and future sales
material. Every capability, maturity claim, and status label in this
document is backed by a specific file in this repository. Where the
product is early, this document says so. No customers, certifications, or
pricing are claimed anywhere below, because none exist in this repository.

---

## Phase 0 — Documentation conflicts identified before writing

Per the working brief for this deck, two conflicts between the brief's
assumed product hierarchy and repository evidence were found and resolved
in favor of the repository. Both are called out here so no downstream
asset silently inherits the incorrect version.

**1. "Agent Governance" is not a future capability — it ships today.**
The brief's product hierarchy lists "Agent Governance" under *Future
Enterprise Solutions*. Repository evidence (`packages/agent-governance/**`,
27 source files, 2 test files, consumed at ~39 call sites, listed
"Implemented, tested" in `docs/legal/IP_OVERVIEW.md`) shows Agent
Passport Core and Runtime Guard are implemented, tested, shipped v1
surface — not roadmap. This deck presents Agent Governance under
**Available** on Slide 11, not future.

**2. "Evidence & Audit" is not a future capability — it ships today.**
The brief lists "Evidence & Audit" under *Future Enterprise Capabilities*.
Repository evidence (`docs/architecture/ADR-EVIDENCE-BUNDLE.md`,
`src/enterprise/evidence/**`, frozen API endpoints `POST /api/evidence/build`,
`GET /api/evidence/{bundleId}`, `POST /api/evidence/verify`) shows the
Evidence Bundle system is implemented, tested, and API-backed. This deck
presents it under **Available**.

What genuinely *is* future/roadmap, and replaces those two items on Slide
11: additional Provider Adapters beyond Pinata (S3, Azure Blob, Google
Drive, SharePoint — contract-compatible by design, unimplemented), the
production wiring that would make Governed Access itself callable by a
customer (a persisted API surface, live-credential provider execution,
automatic usage-event emission), and live/continuous signal automation for
Assurance (today, staleness signals are appended observations, not live
polling).

One naming collision worth a permanent footnote: **"Evidence Bundle"**
(API-backed, `evidence.bundle.v1`) and **"Evidence Correlation"**
(`EnterpriseEvidenceCorrelation`, the final stage of the Governed Access
lifecycle, package-level only) are two distinct systems that happen to
share the word "Evidence." This deck keeps them separate everywhere and
never implies one is a runtime consumer of the other.

---

## Phase 1 — Product hierarchy (grounding reference, used on Slide 5)

```text
SOBERANÍA PROTOCOL
  Provider-neutral, product-neutral specification layer.
  Owns: identity, capability-token, consent-grant, and audit-envelope
  contracts, and scoped-access grammar. Separate repository, separate
  governance. Frontera Systems depends on it; it never depends on
  Frontera Systems.
        │
        ▼
Frontera Systems  (v1.0.0 core — proprietary, Onchainfest LLC)
  The commercial orchestration, runtime, and operational layer.
  Kernel (decision engine) · Enterprise Host (27 frozen API endpoints)
  Governance Store · Agent Passport / Runtime Guard · Evidence Bundle
  Assurance Runtime (Soberanía SAF)
        │
        ├── ENTERPRISE SOLUTION: GOVERNED ACCESS
        │     The 7-contract access lifecycle + Provider Adapter model.
        │     Architecture frozen and accepted. Reference implementation
        │     against Pinata exists and is conformance-tested.
        │     Not yet wired into a customer-callable API — this is the
        │     Design Partner opportunity (Slide 10, Slide 11).
        │
        └── ENTERPRISE SERVICE: ASSURANCE
              The evidence-driven control evaluation and scoring engine
              (Soberanía SAF v1.0.0). Implemented, tested, API-backed, optional
              module. Not a certification authority.

ALREADY SHIPPED, NOT ROADMAP
  Agent Governance (Agent Passport / Runtime Guard) · Evidence & Audit
  (Evidence Bundle API)

GENUINE ROADMAP
  Additional Provider Adapters (S3, Azure Blob, Google Drive, SharePoint)
  Governed Access production wiring (persisted API, live execution)
  Continuous Assurance signal automation
```

---

## Design style

Modern B2B SaaS, comparable to Stripe, Okta, Auth0, Cloudflare, HashiCorp,
Vercel, Linear, Notion. Minimal, executive, high-trust. One idea per
slide. No stock-photo people, no gradients-for-their-own-sake, no
buzzwords ("revolutionary," "seamless," "next-generation," "AI-powered
synergy"). Dark-on-light or light-on-dark monochrome base, a single accent
color reserved for the thing the slide wants the room to remember. Diagrams
are drawn as labeled boxes and arrows, never decorative icons standing in
for architecture. Every diagram in this deck should render legibly printed
in black and white.

---

## The deck

### Slide 1 — Hero

**Slide Objective:** Establish who Frontera Systems is for and what problem
it solves, in one breath, before any architecture appears.

**Title:** Frontera Systems

**Subtitle:** Governed access to every system your product depends on —
provable, revocable, and auditable, without rebuilding your storage layer.

**Visual Layout:** Full-bleed dark background. Wordmark top-left, small.
Subtitle centered, large type, generous whitespace. No logo wall (no
customers to show — do not fake one). A single thin diagram at the
bottom: `Request → Decision → Grant → Evidence`, four words connected by
arrows, nothing else.

**Suggested Diagram:** The four-word lifecycle spine only — a preview of
Slide 4, not the full picture.

**Illustration Ideas:** None beyond the spine diagram. Resist adding an
abstract network/lock/shield graphic — it says nothing a competitor's deck
doesn't already say.

**Body Copy:** "Every enterprise product touches a provider it doesn't
control — storage, identity, a document vault. Frontera Systems governs
what happens at that boundary."

**Presenter Notes (≤90s):** "Thanks for the time. Before I show you
anything technical, I want to name the problem in one sentence: every
product you build eventually has to hand a document, a file, or a record
to some other system — S3, IPFS, Google Drive, whatever it is — and the
moment you do, you lose the ability to prove who actually had access,
when, and whether it was supposed to end. That's not a storage problem.
It's a governance problem, and it sits exactly at the seam between your
product and the providers underneath it. That seam is what Frontera Systems
governs. I'll show you how, and then I want your read on whether it maps
to a real gap in what you're running today."

**Design Notes:** Resist any temptation to put a feature list on the hero.
If a viewer only sees this one slide, they should understand the category,
not the product.

**Questions this slide should answer:** What is this? Who is it for? Why
should I keep watching?

**Transition:** "So — why does this gap exist in the first place?"

---

### Slide 2 — The Problem

**Slide Objective:** Establish that the customer's existing stack — storage,
auth, signed URLs, permissions — already covers *access*, but not
*governance of access*, and that this gap is structural, not a bug they can
patch.

**Title:** Storage solved access. It never solved governance.

**Subtitle:** Authentication, signed URLs, and permissions tell you access
was granted. None of them tell you why, for how long, or what happened
next.

**Visual Layout:** Two-column comparison. Left column: "What you have
today" — Storage, Authentication, Signed URLs, Permissions, each with a
single checkmark for "grants access." Right column: "What none of them
answer" — three questions, no checkmarks: *Who approved this, and under
what policy? Does it expire on its own? Can I prove what happened after
the link was issued?*

**Suggested Diagram:** A single signed URL rendered as a plain text string,
with three callouts pointing at it: "no owner," "no expiry logic beyond
what's baked into the string," "no record of who opened it." The point is
that the URL itself is the *entire* access record — nothing else exists
alongside it.

**Illustration Ideas:** None. The bare signed-URL string is more convincing
than any iconography.

**Body Copy:** "Storage answers *can this system serve the file.*
Authentication answers *who is asking.* A signed URL answers *for how
long, to whoever holds it.* None of them answer *should this access have
happened, and can I prove it after the fact.* That answer has to live
somewhere else — today, for most teams, it doesn't live anywhere at all."

**Presenter Notes (≤90s):** "Every team in this room already has storage,
already has auth, already issues signed URLs or scoped permissions. That's
not the gap. The gap is what happens the moment access is granted. A
signed URL is a bearer secret — whoever holds it has access, full stop.
There's no record of which policy allowed it, who approved it, whether it
was supposed to be read-only, or what happens if the deal, the case, or
the relationship changes five minutes later. When something goes wrong —
a leak, an audit, a subpoena — you can prove a link existed. You can't
prove who actually used it, or that access ended when it was supposed to.
That's the governance gap, and it's structural: no amount of better
storage or better auth closes it, because none of those systems were ever
designed to answer it."

**Design Notes:** Keep this slide blunt and short. It should feel like a
diagnosis, not a pitch — the room should be nodding, not being sold to yet.

**Questions this slide should answer:** Don't I already have this covered?
What exactly is missing?

**Transition:** "That missing piece has a name."

---

### Slide 3 — The Missing Layer

**Slide Objective:** Name the missing layer — Governed Access — in plain
business language, with zero implementation detail.

**Title:** Governed Access

**Subtitle:** The layer that decides, records, and can prove what happens
between "someone asked" and "someone had access" — independent of which
storage or identity provider sits underneath.

**Visual Layout:** Single centered statement, largest type in the deck.
Below it, a plain-English restatement in three short lines, no diagram yet
— this slide is a definition, not an architecture.

**Suggested Diagram:** None. Deliberately withheld until Slide 4.

**Illustration Ideas:** None.

**Body Copy:** "Governed Access sits between the request and the provider.
It decides whether access should happen, records the decision and its
conditions permanently, and keeps that record intact even after the
provider-side link, credential, or permission has expired or changed."

**Presenter Notes (≤90s):** "We call this layer Governed Access. It's not
a new storage system, and it's not an identity provider — you keep both of
those. It's the layer that sits at the boundary and answers the three
questions the last slide raised: who approved this and under what policy,
does it end on its own, and can you prove what happened afterward. The
important design choice is that this record lives independent of the
provider. If the signed URL expires, gets revoked, or the underlying file
moves to a different system entirely, the governance record — the
decision, the conditions, the evidence — doesn't move or disappear with
it. That independence is what makes it provable months or years later,
which is exactly when you actually need it."

**Design Notes:** This is the only slide in the deck permitted to feel
slow. Let it breathe — it's the thesis statement everything after this
builds on.

**Questions this slide should answer:** What is Governed Access, in one
sentence? Is this a new storage system I have to migrate to? (No.)

**Transition:** "Here's exactly what that record looks like, end to end."

---

### Slide 4 — Lifecycle

**Slide Objective:** Show the concrete, ordered sequence of what Governed
Access actually records, using the Meridian Diligence reference scenario
as a running example so the abstraction stays grounded.

**Title:** One request, one provable record

**Subtitle:** Access Request → Decision → Obligations → Grant → Provider
Translation → Provider Execution → Usage → Evidence

**Visual Layout:** Horizontal eight-stage pipeline, left to right, each
stage a labeled box with a one-line business description underneath. A
thin secondary strip below the pipeline runs a single worked example
alongside it (see reference scenario below), so the abstract stage and the
concrete instance are always visible together.

**Suggested Diagram:**

```text
Access Request → Decision → Obligations → Grant → Provider Translation
   → Provider Execution → Usage → Evidence
```

Reference row underneath, drawn from the repository's own commercial
demo (`docs/commercial/R006-COMMERCIAL-REFERENCE-DEMO.md`) — presented
explicitly as a reference scenario, not a live customer:

```text
Outside counsel        Policy evaluates    Read-only,          Access issued,
requests the target  → to "conditional"  → time-boxed,       → active,
report                                      watermark flagged     expires in 24h
   → translated into a Pinata access instruction → temporary link issued,
     no credential recorded → 2 views logged, never a download
       → decision + obligations + grant + usage tied into one evidence record
```

**Illustration Ideas:** If a screenshot is wanted, the repository already
has a rendered example of this exact flow:
`docs/commercial/screenshots/commercial-demo-report-hero.png` (header and
happy-path artifacts) and `commercial-demo-report-full.png` (all stages
plus the audit reconstruction). Use these instead of commissioning new
artwork — they are real output from the reference implementation, not a
mockup.

**Body Copy:** "Every stage produces one immutable record. Nothing is
overwritten — a revocation doesn't erase the grant, it attaches to it.
Months later, the full chain from request to evidence still reconstructs
exactly what happened and why."

**Presenter Notes (≤90s):** "Let me walk this with a real reference
scenario we built end-to-end: an M&A data-room platform, outside counsel
requesting a confidential target report during live diligence. Counsel
requests access — that's the Access Request. Policy evaluates it and
returns a decision — here, 'conditional,' not an outright yes. The
conditions get recorded explicitly as Obligations — read-only, time-boxed,
watermark-required — and this is where it gets interesting: the system
checks whether the underlying provider can actually enforce watermarking,
and it can't, so that gap surfaces *before* the grant is issued, not after
a leak. Only then is the Grant issued — twenty-four hours, active. That
grant gets translated into whatever the specific provider needs — in this
case a temporary access instruction — and executed, producing an actual
link, but critically, no credential is ever written into our record.
Every view gets logged as a Usage Event. And all of it — decision,
obligations, grant, usage, and later the revocation when the deal closes —
correlates into one Evidence record. That's the whole lifecycle, and it's
running code today, not a diagram we drew for this meeting."

**Design Notes:** Do not let this slide become a code dump. No type names,
no schema fields — the business description under each box is the whole
slide. If asked for the underlying contract names, answer verbally, don't
put them on screen.

**Questions this slide should answer:** What actually gets recorded, and
when? Where does the provider fit into this sequence?

**Transition:** "That 'Provider Translation' step is doing more work than
it looks like — here's why."

---

### Slide 5 — Architecture

**Slide Objective:** Show the layered architecture and make the case for
provider neutrality as a business property, not just a design choice.

**Title:** One governance layer. Any provider underneath.

**Subtitle:** Protocol → Enterprise → Provider Adapter → Provider →
Storage — swapping the bottom layer never touches the top three.

**Visual Layout:** Vertical stack, five bands, thickest band (Enterprise)
in the accent color, provider band explicitly drawn as swappable (dashed
outline, a small row of alternative provider names beneath it, greyed out
except Pinata).

**Suggested Diagram:**

```text
┌──────────────────────── SOBERANÍA PROTOCOL ────────────────────────┐
│ identity · capability tokens · consent · audit envelopes            │
└───────────────────────────────┬─────────────────────────────────────┘
┌──────────────────────── Frontera Systems ───────────────────────┐
│ Decision · Obligation · Grant · Revocation · Usage · Evidence        │
│ (immutable — cannot hold a credential, a signed URL, or an SDK type) │
└───────────────────────────────┬─────────────────────────────────────┘
┌────────────────────────── PROVIDER ADAPTER ──────────────────────────┐
│ reads only: resource, status, expiresAt  ·  writes only: usage events│
└───────────────────────────────┬─────────────────────────────────────┘
        ┌──────────┬──────────┬──────────┬──────────┬──────────┐
        │  Pinata   │    S3    │  Azure   │  Google  │SharePoint│
        │ (shipped) │ (future) │ (future) │  Drive   │ (future) │
        │           │          │          │ (future) │          │
        └──────────┴──────────┴──────────┴──────────┴──────────┘
                     PROVIDER · STORAGE (execution, credentials, network)
```

**Illustration Ideas:** Keep the swappable-provider row visually
secondary — Pinata solid, the other four visibly greyed/outlined, so the
room reads "one is live, the model supports the rest" without overclaiming
a fifth adapter that doesn't exist yet.

**Body Copy:** "Enterprise owns the decision, the grant, and the evidence.
The provider owns execution — credentials, URLs, the SDK call. The only
things that cross that boundary are a grant's resource, status, and
expiry going down, and a usage event coming back up. Nothing else ever
crosses."

**Presenter Notes (≤90s):** "This is the architectural reason the last
slide's evidence record survives a provider outage, a provider migration,
or a provider you haven't even chosen yet. Enterprise never holds a
credential, a signed URL, or a provider SDK type — that's not a policy,
it's enforced at compile time in this codebase. The only thing that
crosses the boundary going down is a grant's resource, status, and expiry;
the only thing coming back up is a usage event. That's it. Which means
swapping providers, or running two at once, is a change to one adapter,
not a redesign of your governance model. Today that boundary is proven
against Pinata, with real IPFS-backed storage, validated by an automated
conformance suite. The same contract is what an S3, Azure, or SharePoint
adapter would implement next — same shape, same guarantees, no redesign."

**Design Notes:** The "cannot hold a credential" claim is a real,
compile-time-enforced property in this codebase — say it with confidence,
but don't claim it's cryptographically enforced or externally audited,
because it isn't (yet).

**Questions this slide should answer:** Am I locked into one storage
vendor? What exactly can the provider layer see or touch?

**Transition:** "So what does Governed Access actually change for the
teams who adopt it?"

---

### Slide 6 — Governed Access

**Slide Objective:** Translate the architecture into outcomes across three
audiences in the room — business, engineering, and commercial/deal —
without repeating the lifecycle slide.

**Title:** What changes when access is governed

**Subtitle:** One model. Three audiences. The same evidence record answers
all three.

**Visual Layout:** Three-column layout, one column per audience, three
outcomes each, no more.

**Suggested Diagram:** None — this is an outcomes slide, not a mechanism
slide. Repeating the lifecycle diagram here would dilute Slide 4.

**Illustration Ideas:** None.

**Body Copy:**

- **Business outcomes** — Every access decision is provable after the
  fact, not just logged as a link. Revocation is instant and selective —
  one counterparty loses access without touching anyone else's. Coverage
  gaps (a provider that can't enforce a required condition) surface before
  a grant is issued, not after an incident.
- **Engineering outcomes** — Your team writes to one governance contract,
  not a bespoke access-control layer per storage provider. Adding a
  provider is an adapter, not a rearchitecture. Nothing provider-specific
  ever leaks into your application code.
- **Commercial outcomes** — A provable access and evidence trail is
  something a security review, a customer's legal team, or a cyber
  insurer can be shown directly — turning "we have logs" into "here is the
  record," which is a materially different conversation in an enterprise
  deal cycle.

**Presenter Notes (≤90s):** "Three ways to read the same architecture,
depending on who's in the room. For the business side: every access
decision is provable, not just logged — and revocation is surgical, one
party at a time, without rotating every other outstanding link. For
engineering: you stop writing bespoke access-control glue for every
storage provider you integrate — you write to one contract, and a new
provider is an adapter, not a rewrite. And commercially, this changes the
conversation in your own enterprise deals — instead of telling a
prospect's security team 'we have logs,' you can show them the actual
decision-and-evidence record. That's usually the difference between a
security review that stalls and one that closes."

**Design Notes:** Keep each bullet to one sentence. If a bullet needs two
sentences to make its point, it's actually two claims — split it or cut
it.

**Questions this slide should answer:** What's in it for engineering
specifically? What's in it for the business side? Does this help *my*
sales cycle?

**Transition:** "Architecture and outcomes are half the story — the other
half is how you actually get there with us."

---

### Slide 7 — Assurance

**Slide Objective:** Introduce Assurance as the evidence-driven evaluation
engine it actually is, and frame the customer engagement model around it
— clearly distinguishing the real, shipped runtime from the proposed
service motion wrapped around it.

**Title:** Assurance: prove your governance posture, continuously

**Subtitle:** A scoring and evidence engine for your access-governance
controls — and the engagement model we run around it, from first
assessment onward.

**Visual Layout:** Top half: five-stage horizontal engagement pipeline.
Bottom half, visually separated by a divider line and a small label
("what's running underneath"): a compact description of the Soberanía SAF
framework itself — domains, controls, evidence, eligibility tiers.

**Suggested Diagram:**

```text
  ENGAGEMENT MODEL (how we work with you)
  Assessment → Recommendations → Implementation → Validation → Continuous Assurance
      ↑ this is where a Technical Assessment (Slide 10) begins

  ─────────────────────────────────────────────────────────────
  WHAT'S RUNNING UNDERNEATH — Soberanía SAF v1.0.0 (implemented, API-backed)
  4 control domains · 10 controls · 6 evidence requirements
  3 eligibility tiers: baseline · advanced · continuous
```

**Illustration Ideas:** None — a labeled pipeline plus the framework
summary is enough; adding a "score dial" graphic risks implying a specific
numeric score exists for the room's own environment, which it can't until
an assessment runs.

**Body Copy:** "Assurance evaluates your access-governance controls
against a defined framework — Soberanía SAF — and produces findings and an
eligibility tier, backed by evidence rather than a checklist you filled
out yourself. It is not a certification and does not replace SOC 2, ISO,
PCI, or HIPAA — it's the evidence layer that makes those conversations
faster because the record already exists."

**Presenter Notes (≤90s):** "Assurance is the other half of Soberanía
Enterprise, and it's important to be precise about what it is. It's a
real, implemented scoring engine — the Soberanía SAF framework, four control
domains, ten controls, backed by actual evidence rather than a
self-attested checklist — and it's already wired into the Enterprise Host
as an optional module with a real API. What it is *not* is a
certification authority — we're not issuing you a SOC 2 report or an ISO
certificate, and we say that explicitly rather than let anyone assume it.
What it gives you is the evidence substrate that makes those certification
conversations faster, because you're not reconstructing 'what actually
happened' from scratch every audit cycle. Around that engine, we run an
engagement: we start with a Technical Assessment of your environment,
come back with recommendations, help implement, validate the result
together, and then move into ongoing, continuous assurance rather than a
once-a-year fire drill. That engagement model is how we work with design
partners today — it's the beginning of the relationship, not an add-on at
the end."

**Design Notes:** Keep the divider between "engagement model" and
"what's running underneath" visually explicit. The audience should never
leave this slide thinking the five-stage pipeline is itself a shipped
software feature — it's the service wrapped around one.

**Questions this slide should answer:** Is this a certification? What
actually happens in an engagement? What is really running in software
versus what's a service we provide?

**Transition:** "Put together, here's the actual business case."

---

### Slide 8 — Business Benefits

**Slide Objective:** Consolidate the case into the six benefits a
CTO/VP-Eng actually budgets against, stated as comparisons to the
counterfactual (build it yourself), not as adjectives.

**Title:** The build-it-yourself alternative, priced honestly

**Subtitle:** Six ways Governed Access changes what your team spends time
and risk on.

**Visual Layout:** 2×3 grid, one short line per cell, each anchored to a
"instead of X, Y" comparison.

**Suggested Diagram:** None.

**Illustration Ideas:** None.

**Body Copy:**

1. **Engineering focus** — instead of building and maintaining a
   bespoke access-control layer per provider, your team builds product.
2. **Lower implementation cost** — instead of designing a governance data
   model from scratch, you adopt one that's already been through
   architectural review and conformance testing.
3. **Lower ownership cost** — instead of owning the long-term maintenance
   of provider-specific access logic, that maintenance sits in an
   adapter layer designed to be swapped, not carried forever.
4. **Faster enterprise sales** — instead of answering "how do you prove
   access was revoked" with a promise, you answer with a record.
5. **Better auditability** — instead of reconstructing an incident from
   scattered logs, the evidence chain already ties decision to grant to
   usage.
6. **Reduced architectural risk** — instead of a provider migration
   touching your access-control code, it touches one adapter.

**Presenter Notes (≤90s):** "I want to price this against the real
alternative, which isn't 'nothing' — it's your team building this
themselves, because every team eventually does some version of it. Every
one of these six is a comparison to that build-it-yourself path. Your
engineers stop maintaining bespoke access logic per provider and go back
to product work. You're not designing a governance data model from a
blank page — this one has already been through architecture review and an
automated conformance suite. The maintenance burden of provider-specific
logic sits in a swappable adapter, not spread through your application.
In enterprise sales, 'we can prove revocation happened' beats 'we promise
it works' every time it comes up in a security review. Audits go from
log-archaeology to reading a chain that already ties together. And a
provider migration — which happens more often than anyone plans for —
touches one adapter instead of your core access logic. None of these are
abstract; they're the six places this either costs you engineering time
today or doesn't."

**Design Notes:** Every line must survive the test "would a skeptical VP
Eng agree this is what build-it-yourself actually costs." Cut anything
that reads as a feature restated as a benefit.

**Questions this slide should answer:** Why not just build this in-house?
What's the actual ROI argument?

**Transition:** "Who specifically feels this most acutely?"

---

### Slide 9 — Ideal Customers

**Slide Objective:** Name the segments where the governance gap is most
expensive, and tie each to the specific lifecycle stage or obligation type
that matters most to them — not a generic "every industry" slide.

**Title:** Where the governance gap is most expensive

**Subtitle:** Six segments where "prove what happened to this document"
is a recurring, high-stakes question — not an edge case.

**Visual Layout:** Six-row table: Segment | Why the gap hurts | What
Governed Access answers for them.

**Suggested Diagram:** None — a clean table reads faster than icons for
this content.

**Illustration Ideas:** None.

**Body Copy:**

| Segment | Why the gap hurts | What Governed Access answers |
|---|---|---|
| **Legal platforms** | Diligence, discovery, and case documents move between firms, clients, and courts on tight, changing access windows | Time-boxed, instantly revocable access with a defensible evidence trail |
| **Healthcare** | Records must be shared across providers and payers under strict, auditable conditions | Obligation tracking (e.g. conditions a provider can't enforce) surfaces before access, not after |
| **Enterprise SaaS** | Every integration with a customer's own storage becomes a one-off access-control problem | One contract per provider integration instead of one bespoke system each |
| **Document platforms** | The product's entire value is "who can see this file, and for how long" | Governed Access *is* the product's core primitive, not a bolt-on |
| **AI platforms** | Agents and pipelines request access to data on behalf of users, at machine speed and volume | A provable decision-and-evidence record per request, not just an API key with broad scope |
| **Financial services** | Regulatory and counterparty access to sensitive records must be provable years later | Immutable evidence correlation independent of provider-side retention |

**Presenter Notes (≤90s):** "These six aren't a random industry list —
each one is a segment where 'prove what happened to this specific
document' comes up constantly, not once a year. Legal platforms live and
die by tight, changing access windows during diligence and discovery.
Healthcare has to prove conditions were actually enforced, not just
promised. Enterprise SaaS companies hit this every time a customer wants
data governed inside their own storage. Document platforms — this
literally is the product. AI platforms are a newer version of the same
problem at machine speed: an agent requesting access on a user's behalf
needs the same provable decision trail a human would, arguably more, since
nobody's watching in real time. And financial services need this to hold
up not just today but years later, in front of a regulator. If you're
sitting in one of these categories, this isn't a nice-to-have architecture
pattern — it's usually already costing you deals or audit time."

**Design Notes:** Do not add customer logos to this slide — none exist yet
in this deck's evidence base. If real design partners are signed later,
this is the slide to update, not before.

**Questions this slide should answer:** Is this relevant to my business
specifically? Who else looks like me?

**Transition:** "If this maps to you, here's exactly how we'd start
working together."

---

### Slide 10 — Commercial Engagement

**Slide Objective:** Make the engagement path concrete and low-risk to
start — a Technical Assessment, not a long-term commitment.

**Title:** How we work together

**Subtitle:** Technical Assessment → Design Partner → Implementation →
Enterprise Platform → Continuous Assurance

**Visual Layout:** Five-stage horizontal path, each stage with a one-line
description of what happens and what the customer walks away with.

**Suggested Diagram:**

```text
Technical      Design         Implementation   Enterprise      Continuous
Assessment  →  Partner     →                →  Platform     →  Assurance
(you get a     (you get a     (you get a       (you get a       (you get an
gap analysis)  working        working           production       ongoing
               integration    integration        deployment)      evidence
               against your   validated                           record)
               real stack)    end-to-end)
```

**Illustration Ideas:** None.

**Body Copy:** "We start small and specific: a Technical Assessment
against your actual environment, not a generic capabilities deck. If it
maps, we move into a Design Partner engagement — this is where the
Governed Access architecture gets wired against your real provider and
your real access scenarios. From there, implementation, then the
Enterprise Platform in production, then Continuous Assurance as an
ongoing practice, not a once-a-year audit sprint."

**Presenter Notes (≤90s):** "Here's the honest version of how this
usually goes. We don't ask you to commit to a platform before you've seen
whether it fits — we start with a Technical Assessment scoped to your
actual environment, and you walk away with a gap analysis whether or not
we go further. If it maps, the next step is a Design Partner engagement —
and I want to be direct about why that's the right next step right now
rather than jumping straight to 'buy the platform': the Governed Access
architecture is frozen and conformance-tested against Pinata today, and a
design partner is exactly how we wire it against your specific provider
and your specific access scenarios next. From there it's a normal path —
implementation, then running in production as the Enterprise Platform,
then Continuous Assurance as an ongoing practice rather than something you
scramble for once a year before an audit."

**Design Notes:** Do not let "Design Partner" read as a euphemism for
"unfinished product you're paying to help us build." Presenter notes
should say plainly why that stage exists at the company's current maturity
— this is covered explicitly on Slide 11 next, so this slide can stay
brief.

**Questions this slide should answer:** What's the first ask? What do I
get at each stage? Is this a big commitment to start?

**Transition:** "Before you ask — here's exactly what's real today versus
what's ahead, with no hedging."

---

### Slide 11 — Current Product Status

**Slide Objective:** State plainly, in three tiers, what's available today,
what requires a design-partner engagement, and what's genuine roadmap —
the credibility slide of the deck.

**Title:** What's real today

**Subtitle:** No maturity claim on this slide goes further than the
architecture behind it.

**Visual Layout:** Three-column status board: Available | Design Partner |
Roadmap. Each item is one line, no adjectives.

**Suggested Diagram:** None — this slide's power is its restraint, not a
diagram.

**Illustration Ideas:** None.

**Body Copy:**

**Available today**
- Frontera Systems core (Kernel, Enterprise Host, 27-endpoint API surface) — v1.0.0
- Governance Store (persistence, tenant isolation)
- Agent Governance — Agent Passport Core and Runtime Guard
- Evidence & Audit — Evidence Bundle API (`/api/evidence/build`, `/verify`)
- Assurance Runtime — Soberanía SAF v1.0.0 framework, API-backed, optional module

**Design Partner stage (architecture frozen, integration in progress)**
- Governed Access lifecycle — all seven contracts (Envelope through
  Evidence Correlation), architecturally accepted and frozen
- Pinata Provider Adapter — real implementation, conformance-tested,
  not yet wired into a persisted, customer-callable API

**Roadmap**
- Additional Provider Adapters (S3, Azure Blob, Google Drive, SharePoint)
- Governed Access production wiring — persisted API surface, live-credential
  execution, automatic usage-event emission
- Continuous Assurance signal automation (live/continuous, beyond today's
  appended-observation model)

**Presenter Notes (≤90s):** "I'd rather lose a little momentum here than
have you find this out from your own engineers in week two. Three tiers,
no hedging. Available today means shipped, tested, and API-backed — the
Enterprise core, Agent Governance, Evidence & Audit, and the Assurance
Runtime all fall here. Design Partner stage means the architecture is
done and frozen — the full Governed Access lifecycle, and a real Pinata
adapter that's passed an automated conformance suite — but it isn't yet
wired into a production API you could call today; that wiring is exactly
what a design partner engagement does together, against your real
environment. And roadmap means genuinely not built yet: adapters beyond
Pinata, and fully live continuous-assurance signal automation. If your
timeline needs the Governed Access lifecycle production-callable on day
one with no partnership stage, we're early for you today, and I'd rather
say that now than after a contract."

**Design Notes:** This slide should be the least "designed" slide in the
deck — plain text, no color-coding beyond the three column headers. Trying
to make an honesty slide look exciting undermines it.

**Questions this slide should answer:** What can I actually use right now?
What am I helping build? What isn't real yet?

**Transition:** "So — where do we start?"

---

### Slide 12 — Call To Action

**Slide Objective:** Convert. One clear, low-friction next step, with two
lighter-weight alternatives for a room not ready to commit to an
Assessment yet.

**Title:** Request a Technical Assessment

**Subtitle:** A scoped review of your environment against the Governed
Access model — no commitment beyond the assessment itself.

**Visual Layout:** Centered, three stacked calls to action, clearly
ranked by weight (primary large button style, two secondary links below
it).

**Suggested Diagram:** None.

**Illustration Ideas:** None.

**Body Copy:**
- **Request a Technical Assessment** — primary
- **Request a Live Demo** — secondary
- **Request an Architecture Review** — secondary

**Presenter Notes (≤90s):** "Three ways to keep going, in order of how
much you're ready to commit today. If you're seeing a real fit, the
Technical Assessment is the actual next step — it's scoped to your
environment and doesn't commit you beyond the assessment itself. If you
want to see the lifecycle running before you commit to that, we can walk
the reference demo live — the same one behind Slide 4, real code, not
slides. And if your team wants to go deeper on the architecture itself
before anyone talks business terms, an Architecture Review with your
engineers is the right entry point. Whichever one makes sense, that's
where I'd like to leave this."

**Design Notes:** Do not add a fourth option. Three is the right number —
a fourth dilutes which one is actually primary.

**Questions this slide should answer:** What do I do right now?

**Transition:** N/A — closing slide.

---

## Phase 2 — Final review

Reviewed from five perspectives. Each row is a specific cut or tightening
made to the draft above, not a generic checklist.

| Reviewer lens | Found | Resolution |
|---|---|---|
| **CTO** | Slide 5's provider-neutrality claim needed to distinguish "compile-time enforced today" from "cryptographically guaranteed" | Presenter notes for Slide 5 now explicitly scope the claim to what's actually enforced in this codebase |
| **Founder** | Early draft implied Assurance's five-stage engagement pipeline was shipped software | Slide 7 now visually and verbally separates "engagement model" from "what's running underneath" |
| **VP Engineering** | Slide 8 originally used adjectives ("seamless," "robust") instead of comparisons | Rewritten as six explicit "instead of X, Y" comparisons against the build-it-yourself alternative |
| **Enterprise Architect** | Needed the exact contract sequence and terminology, not just business language, to trust the lifecycle claim | Slide 4 keeps business language on-slide but presenter notes name the real stage-by-stage flow from the reference demo |
| **Product Manager** | Original Slide 11 draft listed Agent Governance and Evidence & Audit as roadmap, per the initial brief, which the repository contradicts | Corrected per Phase 0 above; both moved to Available, and roadmap reflects the actual gaps (additional adapters, Governed Access production wiring, live signal automation) |

Fluff removed: "next-generation," "seamless," "enterprise-grade,"
"powerful," and any sentence that named a benefit without a mechanism
behind it. Jargon removed from customer-facing slide copy: internal type
names (`EnterpriseAccessGrant`, `EnterpriseResourceEnvelope`, etc.) are
verbal-only, spoken in presenter notes when a technical audience asks, and
never printed on a slide. Repetition removed: the lifecycle diagram
appears exactly once (Slide 4); Slides 6–8 each reference it verbally
rather than redrawing it.

---

## Phase 3 — Objections, questions, and recommended answers

### Top 10 customer objections

1. **"This is just an access-control layer we could build ourselves."**
   You could — most teams eventually build some version of this. The
   question is whether you want to own provider-specific access logic
   forever, or contain it in a swappable adapter behind one frozen
   contract. That's the actual cost comparison, not "build vs. buy."

2. **"Governed Access isn't wired into a production API yet — why would
   I start now?"**
   Because the hard part — the architecture, the contract boundaries, the
   conformance testing — is already done and frozen. A design partner
   engagement wires it against your specific provider and scenarios,
   which is faster than starting from an unfrozen architecture yourself.

3. **"Only Pinata is supported."**
   Today, yes — and we say so directly. The Provider Adapter contract is
   built so a second provider is an adapter, not a redesign; that's the
   architectural bet this deck makes, and it's provable by looking at how
   little the Pinata adapter had to add beyond the frozen contract.

4. **"We're not using IPFS/Pinata at all."**
   Understood — that's exactly why a Technical Assessment is the right
   first step: it tells us honestly whether your provider timeline lines
   up with the roadmap, or whether we're early for you today.

5. **"Assurance sounds like a certification you're not actually
   qualified to issue."**
   It isn't a certification, and we don't claim to be one. It's an
   evidence and scoring engine that makes your existing certification
   conversations (SOC 2, ISO, etc.) faster because the evidence already
   exists — not a replacement for those processes.

6. **"How do I know this isn't vaporware?"**
   Ask to see the reference demo run live — it's real, tested code
   against a real Pinata-backed scenario, not a mockup. Slide 12's
   "Request a Live Demo" is exactly this.

7. **"What happens to our data/access model if Frontera Systems disappears
   or we switch vendors?"**
   The evidence and grant records are yours, immutable, and provider-
   independent by design — they don't live inside the provider's own
   system. This is a fair diligence question for a Technical Assessment.

8. **"This looks like a lot of new infrastructure to adopt."**
   The lifecycle wraps your existing storage and identity systems — you
   keep both. Governed Access is the decision-and-evidence layer at the
   boundary, not a replacement for what you already run.

9. **"We don't have engineering bandwidth for a design partner
   engagement right now."**
   That's a real constraint, and it's exactly what the Technical
   Assessment is scoped to surface honestly before any larger commitment
   — it costs you an assessment, not an implementation sprint.

10. **"No other company is publicly using this yet."**
    Correct, and we won't claim otherwise. What is real: a frozen,
    accepted architecture, a conformance-tested provider adapter, and a
    working reference implementation. The Technical Assessment and Design
    Partner stage exist specifically for a company willing to be early
    in exchange for direct influence on the second provider adapter.

### Top 10 technical questions

1. **What exactly can a Provider Adapter read from a grant?** Only
   `resource`, `status`, and `expiresAt` — nothing else, by contract.

2. **What can a Provider Adapter write back?** Only usage events — it
   cannot modify a decision, obligation, grant, or evidence record.

3. **Can Enterprise ever hold a provider credential?** No — this is
   enforced at compile time in the codebase (negative tests assert it
   structurally cannot).

4. **What happens if a provider can't enforce a required obligation
   (e.g. watermarking)?** It surfaces via the provider's own capability
   declaration before a grant is issued — the Meridian reference scenario
   demonstrates exactly this case.

5. **Is revocation instant?** Revocation is recorded immediately and
   scoped to a single grant; provider-side propagation speed depends on
   what the specific provider adapter can enforce.

6. **What's the difference between Evidence Bundle and Evidence
   Correlation?** Two separate systems that share a name: Evidence Bundle
   is the shipped, API-backed system (`/api/evidence/build`, `/verify`);
   Evidence Correlation is the final stage of the Governed Access
   lifecycle contracts. They don't share code today.

7. **Is there persistence for the Governed Access lifecycle today?** Not
   yet as a customer-callable API — this is explicitly the Design Partner
   stage of work, stated plainly on Slide 11.

8. **How is Soberanía Protocol licensed relative to Frontera Systems?** They're
   separate projects with separate governance; Frontera Systems is
   proprietary (Onchainfest LLC). Protocol's own licensing terms are
   governed by its own separate project and aren't restated here.

9. **What's actually tested in the Pinata adapter?** All 20 of its tests
   run against a fake Pinata client — no test contacts a live Pinata
   endpoint or requires a real credential. It's conformance-tested, not
   yet production-load-tested against live Pinata.

10. **Does the Assurance Runtime have a UI?** No — it's API/runtime-only
    today; no dashboard consumes it yet.

### Top 10 business questions

1. **What does this cost?** No public pricing exists yet — this is
   scoped per engagement starting with the Technical Assessment.

2. **How long does a Technical Assessment take?** Scoped per engagement;
   the point of the assessment is to define this together, not to quote
   a generic timeline upfront.

3. **What do we own at the end of a Design Partner engagement?** A
   working integration against your real environment, plus direct
   influence on the next Provider Adapter built.

4. **Are there existing customers we can talk to?** No public customer
   names exist yet — this deck does not claim any, and a design partner
   would be among the earliest.

5. **Is this SOC 2 / ISO / HIPAA certified?** No — and Assurance is
   explicitly not a certification authority. It's built to make those
   certification processes faster, not to replace them.

6. **Who owns Onchainfest LLC / Frontera Systems commercially?** Soberanía
   Enterprise is proprietary software owned by Onchainfest LLC; production
   use requires a written Commercial Agreement.

7. **What's the relationship between Soberanía Protocol and Frontera Systems
   commercially?** Acquiring rights to Frontera Systems does not transfer
   any rights in Soberanía Protocol — they are governed separately.

8. **Is source code access included?** Not by default — delivery may be
   compiled artifacts unless source access is an explicit term of the
   Commercial Agreement.

9. **What's the risk of starting as a Design Partner instead of waiting
   for a fully wired product?** Lower cost of entry and direct influence
   on what gets built next, in exchange for the Governed Access lifecycle
   not yet being a turnkey, persisted API on day one — stated plainly on
   Slide 11.

10. **Why should we move now instead of waiting for the roadmap items to
    ship?** Because the architecture — the hard, slow-to-change part — is
    already frozen and accepted; waiting doesn't make the frozen part
    more frozen, it just delays your own integration and any influence
    over what ships next.

---

## Most important rule, restated

Every slide above is written so that removing "Soberanía" and reading it back
still describes the customer's problem, not our product. If a future
edit of this deck starts explaining Frontera Systems before it's explained
the customer's governance gap, that edit should be reverted, not
polished.
