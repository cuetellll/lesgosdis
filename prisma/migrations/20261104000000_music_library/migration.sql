-- CreateTable
CREATE TABLE "MusicTrack" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL DEFAULT '',
    "album" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "format" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "artworkKey" TEXT,
    "contentHash" TEXT NOT NULL DEFAULT '',
    "originalName" TEXT NOT NULL,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "lastPlayedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MusicTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MusicPlaylist" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MusicPlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MusicPlaylistTrack" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "MusicPlaylistTrack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MusicTrack_storageKey_key" ON "MusicTrack"("storageKey");

-- CreateIndex
CREATE INDEX "MusicTrack_serverId_createdAt_idx" ON "MusicTrack"("serverId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MusicTrack_serverId_lastPlayedAt_idx" ON "MusicTrack"("serverId", "lastPlayedAt" DESC);

-- CreateIndex
CREATE INDEX "MusicTrack_uploaderId_idx" ON "MusicTrack"("uploaderId");

-- CreateIndex
CREATE INDEX "MusicPlaylist_serverId_updatedAt_idx" ON "MusicPlaylist"("serverId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MusicPlaylist_serverId_name_key" ON "MusicPlaylist"("serverId", "name");

-- CreateIndex
CREATE INDEX "MusicPlaylistTrack_playlistId_position_idx" ON "MusicPlaylistTrack"("playlistId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MusicPlaylistTrack_playlistId_trackId_key" ON "MusicPlaylistTrack"("playlistId", "trackId");

-- AddForeignKey
ALTER TABLE "MusicTrack" ADD CONSTRAINT "MusicTrack_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicTrack" ADD CONSTRAINT "MusicTrack_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicPlaylist" ADD CONSTRAINT "MusicPlaylist_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicPlaylist" ADD CONSTRAINT "MusicPlaylist_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicPlaylistTrack" ADD CONSTRAINT "MusicPlaylistTrack_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "MusicPlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicPlaylistTrack" ADD CONSTRAINT "MusicPlaylistTrack_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "MusicTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;
