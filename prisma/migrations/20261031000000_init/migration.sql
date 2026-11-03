-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ONLINE', 'IDLE', 'DND', 'OFFLINE');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('TEXT', 'VOICE', 'ANNOUNCEMENT', 'FORUM', 'STAGE');

-- CreateEnum
CREATE TYPE "FriendStatus" AS ENUM ('PENDING', 'ACCEPTED', 'BLOCKED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "discriminator" TEXT NOT NULL DEFAULT '0001',
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "avatarColor" TEXT NOT NULL DEFAULT '#5865F2',
    "bannerColor" TEXT NOT NULL DEFAULT '#1e1f22',
    "status" "UserStatus" NOT NULL DEFAULT 'ONLINE',
    "customStatus" TEXT,
    "bio" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "iconText" TEXT NOT NULL DEFAULT 'PC',
    "iconColor" TEXT NOT NULL DEFAULT '#5865F2',
    "ownerId" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'us-east-railway',
    "verificationLevel" TEXT NOT NULL DEFAULT 'MEDIUM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#99AAB5',
    "position" INTEGER NOT NULL DEFAULT 1,
    "hoist" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "node" TEXT NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerMember" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nickname" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'TEXT CHANNELS',
    "type" "ChannelType" NOT NULL DEFAULT 'TEXT',
    "topic" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "slowmode" INTEGER NOT NULL DEFAULT 0,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "replyToId" TEXT,
    "attachmentsJson" TEXT NOT NULL DEFAULT '[]',
    "reactionsJson" TEXT NOT NULL DEFAULT '{}',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "threadName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileReference" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friend" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "friendId" TEXT NOT NULL,
    "status" "FriendStatus" NOT NULL DEFAULT 'ACCEPTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Friend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendRequest" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "participantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "senderId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "replyToId" TEXT,
    "attachmentsJson" TEXT NOT NULL DEFAULT '[]',
    "reactionsJson" TEXT NOT NULL DEFAULT '{}',
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "groupName" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceSession" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "deafened" BOOLEAN NOT NULL DEFAULT false,
    "videoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "screenSharing" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ban" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ban_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "targetName" TEXT,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_RoleToServerMember" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshToken_key" ON "Session"("refreshToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Server_inviteCode_key" ON "Server"("inviteCode");

-- CreateIndex
CREATE INDEX "Server_ownerId_idx" ON "Server"("ownerId");

-- CreateIndex
CREATE INDEX "Server_inviteCode_idx" ON "Server"("inviteCode");

-- CreateIndex
CREATE INDEX "Role_serverId_position_idx" ON "Role"("serverId", "position" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Permission_roleId_node_key" ON "Permission"("roleId", "node");

-- CreateIndex
CREATE INDEX "ServerMember_userId_idx" ON "ServerMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerMember_serverId_userId_key" ON "ServerMember"("serverId", "userId");

-- CreateIndex
CREATE INDEX "Channel_serverId_position_idx" ON "Channel"("serverId", "position");

-- CreateIndex
CREATE INDEX "Message_channelId_createdAt_idx" ON "Message"("channelId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Message_userId_idx" ON "Message"("userId");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Reaction_messageId_userId_emoji_key" ON "Reaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "Friend_userId_status_idx" ON "Friend"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Friend_userId_friendId_key" ON "Friend"("userId", "friendId");

-- CreateIndex
CREATE UNIQUE INDEX "FriendRequest_senderId_receiverId_key" ON "FriendRequest"("senderId", "receiverId");

-- CreateIndex
CREATE INDEX "DirectMessage_conversationId_createdAt_idx" ON "DirectMessage"("conversationId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceSession_channelId_userId_key" ON "VoiceSession"("channelId", "userId");

-- CreateIndex
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_code_key" ON "Invitation"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Ban_serverId_userId_key" ON "Ban"("serverId", "userId");

-- CreateIndex
CREATE INDEX "AuditLog_serverId_createdAt_idx" ON "AuditLog"("serverId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "_RoleToServerMember_AB_unique" ON "_RoleToServerMember"("A", "B");

-- CreateIndex
CREATE INDEX "_RoleToServerMember_B_index" ON "_RoleToServerMember"("B");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMember" ADD CONSTRAINT "ServerMember_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMember" ADD CONSTRAINT "ServerMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceSession" ADD CONSTRAINT "VoiceSession_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceSession" ADD CONSTRAINT "VoiceSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ban" ADD CONSTRAINT "Ban_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RoleToServerMember" ADD CONSTRAINT "_RoleToServerMember_A_fkey" FOREIGN KEY ("A") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RoleToServerMember" ADD CONSTRAINT "_RoleToServerMember_B_fkey" FOREIGN KEY ("B") REFERENCES "ServerMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

