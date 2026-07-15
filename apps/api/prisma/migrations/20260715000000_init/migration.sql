-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ORGANIZER', 'ADMIN');

-- CreateEnum
CREATE TYPE "SeatingType" AS ENUM ('ASSIGNED', 'GENERAL');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'ON_SALE', 'SOLD_OUT', 'ENDED');

-- CreateEnum
CREATE TYPE "SeatStatus" AS ENUM ('AVAILABLE', 'BOOKED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "venue" TEXT,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "onSaleAt" TIMESTAMP(3) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "seatingType" "SeatingType" NOT NULL,
    "totalCapacity" INTEGER,
    "remainingCapacity" INTEGER,
    "gaPriceCents" INTEGER,
    "organizerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "seatNumber" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "status" "SeatStatus" NOT NULL DEFAULT 'AVAILABLE',
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "seatId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "paymentMethod" TEXT NOT NULL,
    "paymentProviderRef" TEXT NOT NULL,
    "ipAddress" TEXT,
    "deviceFingerprint" TEXT,
    "userAgent" TEXT,
    "bookingAttemptCount" INTEGER NOT NULL DEFAULT 1,
    "timeToCompleteMs" INTEGER,
    "isFirstBooking" BOOLEAN NOT NULL,
    "accountAgeDays" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isFraud" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "Event_status_onSaleAt_idx" ON "Event"("status", "onSaleAt");

-- CreateIndex
CREATE INDEX "Seat_eventId_status_idx" ON "Seat"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_eventId_seatNumber_key" ON "Seat"("eventId", "seatNumber");

-- CreateIndex
CREATE INDEX "Booking_userId_idx" ON "Booking"("userId");

-- CreateIndex
CREATE INDEX "Booking_eventId_status_idx" ON "Booking"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_bookingId_key" ON "Transaction"("bookingId");

-- CreateIndex
CREATE INDEX "Transaction_userId_createdAt_idx" ON "Transaction"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The last line of defense: the DB physically cannot hold two CONFIRMED
-- bookings for one seat. Prisma's schema DSL cannot express partial unique
-- indexes, hence this raw SQL (see API_AND_DATA_SPEC.md §1).
CREATE UNIQUE INDEX "one_confirmed_booking_per_seat"
  ON "Booking"("seatId")
  WHERE status = 'CONFIRMED' AND "seatId" IS NOT NULL;
