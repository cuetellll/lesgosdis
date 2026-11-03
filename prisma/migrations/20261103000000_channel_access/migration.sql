-- CreateTable
CREATE TABLE "ChannelAccess" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelAccess_userId_idx" ON "ChannelAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccess_channelId_userId_key" ON "ChannelAccess"("channelId", "userId");

-- AddForeignKey
ALTER TABLE "ChannelAccess" ADD CONSTRAINT "ChannelAccess_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

