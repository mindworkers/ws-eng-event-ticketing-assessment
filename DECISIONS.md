# Engineering Decisions

I will do blackbox and whitebox testing to find out if there are any potential bugs in the codebase that need to be fixed.
Will implement two new features (Ticket Transfer, Event Waitlist) and then fix "Must Fix" bugs.
After the testing, I found one bug that needs to be fixed: `decrementCapacity`.

---

## Problem Understanding

I am extending the existing event ticketing platform with two new attendee-facing capabilities:

1. **Ticket Transfer** — a confirmed ticket owner can transfer a ticket to another _registered_ user by email.
2. **Event Waitlist** — when an event is sold out, attendees can join a waitlist and are **automatically promoted** to a confirmed ticket when capacity is freed by cancellation.

Key challenges in this codebase:

- Integrate with existing booking/cancellation/refund, QR generation, and capacity accounting.
- Keep capacity consistent across create/cancel/transfer/promotion.

Unclear / missing details (handled via assumptions): waitlist is **event-level** (not tier-specific); transfer restrictions like “past events” are not specified.

## Approach

### Feature 1: Ticket Transfer

**Decision:** Add a transfer API + UI that transfers a _confirmed_ ticket to an existing user by email.

**API shape:** `POST /api/transfers` (separate endpoint for clarity).

**Strategy:** create a **new booking** for the recipient with fresh `ticketCode`/`qrCodeData`, and mark the original booking as **TRANSFERRED** (no refund). This preserves an audit trail and prevents reuse of a QR screenshot.

**Acceptance-test requirement:** since the ticket must disappear from the original attendee’s bookings, **TRANSFERRED** bookings must be filtered out (backend `GET /api/bookings` or frontend list filtering).

### Feature 2: Event Waitlist

**Decision:** No new entity/table: reuse `Booking.status = WAITLISTED` (already referenced in the codebase).

**Endpoints:** join/leave/position in `backend/src/routes/waitlist.ts`.

**Behavior:**

- Join only when sold out; create a WAITLISTED booking.
- Position is FIFO by `createdAt`.
- Leave removes the user from position calculation.

**Auto-promotion:** on cancellation, pick the oldest WAITLISTED entry and promote it to `CONFIRMED` with fresh credentials.

**Critical rule:** WAITLISTED must **not** affect `soldCount`; capacity changes only on CONFIRMED create/promotion.

### Bug Fix: Decrement Capacity

**Problem:** `decrementCapacity()` only decremented event-level `soldCount` when a `seatTierId` existed, so general admission cancellations did not free capacity.

**Fix:** Update `decrementCapacity()` to always decrement the event’s `soldCount`, and only decrement tier `soldCount` when `seatTierId` is present.

**File:** `backend/src/lib/capacity.ts`.

## Risks & Assumptions

**Risks**

- Transfer visibility: if TRANSFERRED bookings aren’t hidden from the original attendee, Test #2 fails.
- Capacity drift: WAITLISTED must not increment counts; cancel+promote should be transactional to avoid double-promotion.
- QR exposure: QR/check-in endpoints must enforce `status === CONFIRMED`.
- Duplicate joins: prevent multiple WAITLISTED records for the same user/event.

**Assumptions / questions**

- Waitlist is event-level (not tier-specific).
- Recipient must be registered.
- PM questions: should transferred bookings be visible anywhere; should waitlist be per-tier; any time/check-in restrictions on transfers.

## Implementation Sequence

1. **Ticket Transfer (backend + frontend)**
   - Highest user impact and smaller surface area than waitlist.
2. **Event Waitlist (backend + frontend)**
   - Requires more integration with cancellation and capacity.
3. **Fix `decrementCapacity` bug**
   - Must-fix correctness issue impacting sold-out logic and waitlist promotion.
