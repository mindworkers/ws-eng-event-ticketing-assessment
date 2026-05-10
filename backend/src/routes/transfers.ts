import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { transferBookingSchema } from "../lib/validations.js";
import { transferBooking } from "../lib/transfer.js";

const router = Router();

// POST /api/transfers - Transfer a confirmed booking to another registered user
router.post("/", authenticate, async (req, res) => {
  try {
    const result = transferBookingSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: result.error.errors[0].message,
      });
    }

    const { bookingId, recipientEmail } = result.data;

    const newBooking = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          status: true,
          userId: true,
          eventId: true,
        },
      });

      if (!booking) {
        throw new Error("NOT_FOUND:Booking not found");
      }

      if (booking.userId !== req.user!.userId) {
        throw new Error("FORBIDDEN:You can only transfer your own bookings");
      }

      if (booking.status !== "CONFIRMED") {
        throw new Error("INVALID_STATUS:Only confirmed bookings can be transferred");
      }

      const recipient = await tx.user.findUnique({
        where: { email: recipientEmail },
        select: { id: true, email: true },
      });

      if (!recipient) {
        throw new Error("NOT_FOUND:No user found with that email address");
      }

      if (recipient.id === booking.userId) {
        throw new Error("VALIDATION:Cannot transfer a ticket to yourself");
      }

      // Prevent duplicates (recipient already has ticket or is waitlisted)
      const existingRecipientBooking = await tx.booking.findFirst({
        where: {
          userId: recipient.id,
          eventId: booking.eventId,
          status: { in: ["CONFIRMED", "CHECKED_IN", "WAITLISTED"] },
        },
        select: { id: true },
      });

      if (existingRecipientBooking) {
        throw new Error("DUPLICATE:Recipient already has a booking for this event");
      }

      return transferBooking(tx, booking.id, recipient.id);
    });

    res.json({
      success: true,
      data: newBooking,
      message: "Ticket transferred successfully",
    });
  } catch (error: unknown) {
    const err = error as Error;
    console.error("Error transferring ticket:", err);

    if (err.message?.startsWith("NOT_FOUND:")) {
      return res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("FORBIDDEN:")) {
      return res.status(403).json({
        success: false,
        error: "FORBIDDEN",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("INVALID_STATUS:")) {
      return res.status(400).json({
        success: false,
        error: "INVALID_STATUS",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("VALIDATION:")) {
      return res.status(400).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: err.message.split(":")[1],
      });
    }

    if (err.message?.startsWith("DUPLICATE:")) {
      return res.status(409).json({
        success: false,
        error: "DUPLICATE",
        message: err.message.split(":")[1],
      });
    }

    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to transfer ticket",
    });
  }
});

export default router;
