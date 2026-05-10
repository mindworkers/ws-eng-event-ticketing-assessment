import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { generateQRData, generateTicketCode } from "../lib/qr.js";

const router = Router();

/**
 * Waitlist is implemented by reusing Booking rows with status=WAITLISTED.
 * It is event-level (not tier-specific).
 */

function isEventSoldOut(event: {
  capacity: number;
  soldCount: number;
  seatTiers: Array<{ capacity: number; soldCount: number }>;
}) {
  const hasTiers = event.seatTiers.length > 0;
  return hasTiers ? event.seatTiers.every((t) => t.soldCount >= t.capacity) : event.soldCount >= event.capacity;
}

async function getWaitlistPosition(tx: any, bookingId: string) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, eventId: true, status: true, createdAt: true, userId: true },
  });
  if (!booking || booking.status !== "WAITLISTED") return null;

  const earlierCount = await tx.booking.count({
    where: {
      eventId: booking.eventId,
      status: "WAITLISTED",
      createdAt: { lt: booking.createdAt },
    },
  });

  return { position: earlierCount + 1, eventId: booking.eventId };
}

// POST /api/waitlist/join
router.post("/join", authenticate, async (req, res) => {
  try {
    const eventId = req.body?.eventId;
    if (!eventId || typeof eventId !== "string") {
      return res.status(400).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: "eventId is required",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: eventId },
        include: { seatTiers: true },
      });
      if (!event) throw new Error("NOT_FOUND:Event not found");
      if (event.status !== "PUBLISHED") throw new Error("INVALID_EVENT:Event is not available for booking");

      if (!isEventSoldOut(event)) {
        throw new Error("NOT_SOLD_OUT:Event is not sold out");
      }

      // Prevent duplicates: you can't join if you already have a confirmed/checked-in ticket
      // or if you're already waitlisted.
      const existing = await tx.booking.findFirst({
        where: {
          userId: req.user!.userId,
          eventId,
          status: { in: ["CONFIRMED", "CHECKED_IN", "WAITLISTED"] },
        },
        select: { id: true },
      });
      if (existing) throw new Error("DUPLICATE:You already have a booking or waitlist entry for this event");

      // Create a waitlist booking. pricePaid is 0 and does not affect capacity.
      const ticketCode = generateTicketCode();
      const qrCodeData = generateQRData(ticketCode);
      const waitlistBooking = await tx.booking.create({
        data: {
          // These credentials are regenerated on promotion to prevent QR reuse.
          // Check-in already enforces status === CONFIRMED.
          ticketCode,
          qrCodeData,
          status: "WAITLISTED",
          pricePaid: 0,
          discountAmount: 0,
          userId: req.user!.userId,
          eventId,
        },
        select: { id: true, createdAt: true },
      });

      const pos = await getWaitlistPosition(tx, waitlistBooking.id);
      return { bookingId: waitlistBooking.id, position: pos?.position ?? 1 };
    });

    res.status(201).json({
      success: true,
      data: result,
      message: `Added to waitlist. Your position is ${result.position}.`,
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error joining waitlist:", err);

    if (err.message?.startsWith("NOT_FOUND:")) {
      return res.status(404).json({ success: false, error: "NOT_FOUND", message: err.message.split(":")[1] });
    }
    if (err.message?.startsWith("INVALID_EVENT:")) {
      return res.status(400).json({ success: false, error: "INVALID_EVENT", message: err.message.split(":")[1] });
    }
    if (err.message?.startsWith("NOT_SOLD_OUT:")) {
      return res.status(409).json({ success: false, error: "NOT_SOLD_OUT", message: err.message.split(":")[1] });
    }
    if (err.message?.startsWith("DUPLICATE:")) {
      return res.status(409).json({ success: false, error: "DUPLICATE", message: err.message.split(":")[1] });
    }

    res.status(500).json({ success: false, error: "INTERNAL_ERROR", message: "Failed to join waitlist" });
  }
});

// POST /api/waitlist/leave
router.post("/leave", authenticate, async (req, res) => {
  try {
    const eventId = req.body?.eventId;
    if (!eventId || typeof eventId !== "string") {
      return res.status(400).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: "eventId is required",
      });
    }

    const removed = await prisma.booking.deleteMany({
      where: {
        userId: req.user!.userId,
        eventId,
        status: "WAITLISTED",
      },
    });

    if (removed.count === 0) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "You are not on the waitlist for this event",
      });
    }

    res.json({ success: true, message: "Removed from waitlist" });
  } catch (error) {
    console.error("Error leaving waitlist:", error);
    res.status(500).json({ success: false, error: "INTERNAL_ERROR", message: "Failed to leave waitlist" });
  }
});

// GET /api/waitlist/position?eventId=...
router.get("/position", authenticate, async (req, res) => {
  try {
    const eventId = req.query.eventId;
    if (!eventId || typeof eventId !== "string") {
      return res.status(400).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: "eventId is required",
      });
    }

    const booking = await prisma.booking.findFirst({
      where: { userId: req.user!.userId, eventId, status: "WAITLISTED" },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "Not on waitlist",
      });
    }

    const earlierCount = await prisma.booking.count({
      where: { eventId, status: "WAITLISTED", createdAt: { lt: booking.createdAt } },
    });

    res.json({
      success: true,
      data: {
        bookingId: booking.id,
        position: earlierCount + 1,
      },
    });
  } catch (error) {
    console.error("Error fetching waitlist position:", error);
    res.status(500).json({ success: false, error: "INTERNAL_ERROR", message: "Failed to fetch waitlist position" });
  }
});

export default router;
