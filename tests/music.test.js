/**
 * Mahyar Music — offline unit tests: command parsing, library signature
 * sniffing, filename metadata, engine/library integration (with a fake
 * library resolver and bot worker) and system wiring.
 * The full media path (bot worker + LiveKit + ffmpeg + real storage) is
 * verified by the E2E script (scripts/music_e2e.js).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadMusicClient() {
  const context = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/music.js'), 'utf8'), context, { filename: 'js/music.js' });
  return new context.window.MahyarMusic({ musicCommand: async () => ({ ok: true }) });
}

test('music client parses /mp commands and rejects strangers', () => {
  const music = loadMusicClient();
  assert.equal(music.parse('hello world').command, null);
  assert.equal(music.parse('/other play x').command, null);
  assert.equal(music.parse('/mp').command, 'help');
  assert.equal(music.parse('/mp nonsense').command, 'unknown');
  const play = music.parse('/mp play believer imagine dragons');
  assert.equal(play.command, 'play');
  assert.equal(play.args, 'believer imagine dragons');
  assert.equal(music.parse('/mp   play   song  ').args, 'song');
  assert.equal(music.parse('/mp pause').command, 'pause');
  assert.equal(music.parse('/mp nowplaying').command, 'nowplaying');
});

test('music client extracts the /mp play search term for library autocomplete', () => {
  const music = loadMusicClient();
  assert.equal(music.playSearchTerm('/mp play Believer'), 'Believer');
  assert.equal(music.playSearchTerm('  /MP  PLAY   my favorite song '), 'my favorite song');
  assert.equal(music.playSearchTerm('/mp play'), null);          // no term yet → command menu
  assert.equal(music.playSearchTerm('/mp pause'), null);
  assert.equal(music.playSearchTerm('hello'), null);
});

test('music client is a bot identity detector, not a guesser', () => {
  const music = loadMusicClient();
  assert.equal(music.constructor.isBotIdentity('mahyar-music:room123'), true);
  assert.equal(music.constructor.isBotIdentity('mahyar-music:'), true);
  assert.equal(music.constructor.isBotIdentity('user_someone'), false);
  assert.equal(music.constructor.isBotIdentity(''), false);
  assert.equal(music.constructor.isBotIdentity(undefined), false);
});

// ---------------------------------------------------------------------------
// Library content validation (server/music/library.ts)
// ---------------------------------------------------------------------------
const library = require('../dist/server/music/library.js');

test('audio signature sniffing decides by content, never by extension', () => {
  const sniff = library.sniffAudioFormat;
  assert.equal(sniff(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00.....')), 'mp3');
  assert.equal(sniff(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'mp3');           // MPEG frame sync
  assert.equal(sniff(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'aac');           // ADTS syncword
  assert.equal(sniff(Buffer.from('OggS\x00\x02xxxxxxxx')), 'ogg');
  assert.equal(sniff(Buffer.from('OggS\x00\x02OpusHeadxxxxxxxx')), 'opus');
  assert.equal(sniff(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ')), 'wav');
  assert.equal(sniff(Buffer.from('fLaC\x00\x00\x00\x22xxxxxxxx')), 'flac');
  assert.equal(sniff(Buffer.from('\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00')), 'm4a');
  assert.equal(sniff(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04')), null);    // executable
  assert.equal(sniff(Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\x0d')), null); // image
  assert.equal(sniff(Buffer.from('hello world, not audio')), null);
  assert.equal(sniff(Buffer.alloc(4)), null);
});

test('filename metadata: "Artist - Title" splits, junk becomes readable words', () => {
  assert.deepEqual(library.metadataFromFilename('Imagine Dragons - Believer.mp3'), { artist: 'Imagine Dragons', title: 'Believer' });
  assert.deepEqual(library.metadataFromFilename('my_favorite_song.ogg'), { artist: '', title: 'my favorite song' });
  assert.deepEqual(library.metadataFromFilename('01 Intro.wav').title, '01 Intro');
  assert.ok(library.metadataFromFilename('').title.length > 0);
});

test('library limits expose the supported formats and storage posture', () => {
  const limits = library.libraryLimits();
  for (const format of ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac']) {
    assert.ok(limits.formats.includes(format), `${format} is supported`);
  }
  assert.equal(typeof limits.max_file_mb, 'number');
  assert.equal(typeof limits.server_quota_mb, 'number');
  assert.equal(typeof limits.max_duration_sec, 'number');
});

// ---------------------------------------------------------------------------
// Engine ↔ library integration (fake resolver + fake bot worker)
// ---------------------------------------------------------------------------
const { MusicEngine } = require('../dist/server/music/engine.js');

function makeFakeBot() {
  return {
    connected: true,
    identity: 'mahyar-music:chan1',
    playing: false,
    play: async () => { },
    stop: async () => { },
    stopPlayback() { },
    isStale: () => false,
    humanParticipantCount: 1
  };
}

function makeEngine(libraryTracks, options = {}) {
  const emitted = [];
  const io = { to: () => ({ emit: (event, state) => emitted.push({ event, state }) }) };
  const library = {
    async searchTracks(_serverId, query, limit) {
      return libraryTracks.filter((t) => t.title.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
    },
    async getPlayableTrack(_serverId, trackId) {
      return libraryTracks.find((t) => t.trackId === trackId) || null;
    },
    async streamUrl(track) { return `https://storage.test/${track.storageKey}?sig=1`; },
    async playlistTracks(_serverId, playlistId) {
      return playlistId === 'pl_1' ? libraryTracks.slice(0, 2) : [];
    },
    recordPlay(trackId) { (options.recorded || (options.recorded = [])).push(trackId); }
  };
  const engine = new MusicEngine({
    io,
    liveKitUrl: 'http://localhost:6789',
    apiKey: 'devkey',
    apiSecret: 'devsecret-'.repeat(4),
    isMusicEnabled: async () => true,
    library
  });
  engine['ensureBot'] = async (room) => { room.bot = makeFakeBot(); return room.bot; }; // never spawn a real worker in unit tests
  return { engine, emitted, options };
}

function libTrack(id, title, extra = {}) {
  return {
    id: `lib:${id}`, origin: 'library', trackId: id, title, artist: 'Tester',
    duration: 120, streamable: true, storageKey: `music/s1/${id}.mp3`, ...extra
  };
}

test('engine.play resolves from the shared library and starts real playback state', async () => {
  const { engine, emitted, options } = makeEngine([libTrack('t1', 'Believer'), libTrack('t2', 'Thunder')]);
  const result = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'Believer' });
  assert.equal(result.ok, true);
  assert.match(result.message, /Believer/);
  assert.equal(result.state.now_playing.title, 'Believer');
  assert.equal(result.state.now_playing.origin, 'library');
  assert.equal(result.state.bot_connected, true);
  assert.equal(result.state.bot_identity, 'mahyar-music:chan1');
  assert.deepEqual(options.recorded, ['t1'], 'play count recorded once for the started track');
  assert.ok(emitted.length >= 1);
});

test('engine.play reports honest errors: external links and empty library', async () => {
  const { engine } = makeEngine([]);
  const url = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'https://youtube.com/watch?v=x' });
  assert.equal(url.ok, false);
  assert.match(url.message, /library/i);

  // A different user (the 1 s duplicate guard is per user) searches for nothing.
  const missing = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u2', query: 'nothing matches this' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /No track matching|Upload/i);
});

test('several library matches open the interactive picker; pick() enqueues', async () => {
  const { engine } = makeEngine([libTrack('t1', 'Believer'), libTrack('t2', 'Believer (live)')]);
  const result = await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'Believer' });
  assert.equal(result.message, 'PICK_RESULT');
  const picked = await engine.pick({ channelId: 'chan1', serverId: 's1', userId: 'u1', trackId: 't2' });
  assert.equal(picked.ok, true);
  assert.equal(picked.state.now_playing.title, 'Believer (live)');
  // Unknown pick after the session was consumed falls back to the library lookup.
  const direct = await engine.pick({ channelId: 'chan1', serverId: 's1', userId: 'u1', trackId: 't1' });
  assert.equal(direct.ok, true);
});

test('playback controls: pause, resume, skip and stop keep the shared state consistent', async () => {
  const { engine } = makeEngine([libTrack('t1', 'Believer'), libTrack('t2', 'Thunder')]);
  await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'Believer' });
  await engine.play({ channelId: 'chan1', serverId: 's1', userId: 'u2', query: 'Thunder' });

  const paused = engine.pause({ channelId: 'chan1', serverId: 's1', userId: 'u1' });
  assert.equal(paused.ok, true);
  assert.equal(paused.state.now_playing.paused, true);
  assert.equal(engine.pause({ channelId: 'chan1', serverId: 's1', userId: 'u1' }).ok, false, 'double pause is a no-op');

  const resumed = await engine.resume({ channelId: 'chan1', serverId: 's1', userId: 'u1' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.now_playing.paused, false);

  const skipped = await engine.skip({ channelId: 'chan1', serverId: 's1', userId: 'u1' });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.state.now_playing.title, 'Thunder', 'skip advances the shared queue');

  const stopped = engine.stop({ channelId: 'chan1', serverId: 's1', userId: 'u1' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.now_playing, null);
  assert.equal(stopped.state.queue.length, 0);
});

test('playPlaylist queues the whole shared playlist in order', async () => {
  const { engine } = makeEngine([libTrack('t1', 'Song A'), libTrack('t2', 'Song B'), libTrack('t3', 'Song C')]);
  const result = await engine.playPlaylist({ channelId: 'chan1', serverId: 's1', userId: 'u1', playlistId: 'pl_1' });
  assert.equal(result.ok, true);
  assert.match(result.message, /Added 2 tracks/);
  assert.equal(result.state.now_playing.title, 'Song A');
  assert.equal(result.state.queue.length, 1);
  assert.equal(result.state.queue[0].title, 'Song B');
  const empty = await engine.playPlaylist({ channelId: 'chan1', serverId: 's1', userId: 'u1', playlistId: 'pl_missing' });
  assert.equal(empty.ok, false);
});

test('search returns library tracks for the command preview', async () => {
  const { engine } = makeEngine([libTrack('t1', 'Believer')]);
  const result = await engine.search({ channelId: 'chan1', serverId: 's1', userId: 'u1', query: 'belie' });
  assert.equal(result.ok, true);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].origin, 'library');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
test('music system is wired: library routes, worker entry, socket command, landing pages', () => {
  const backend = fs.readFileSync(path.join(__dirname, '../server/index.ts'), 'utf8');
  const register = fs.readFileSync(path.join(__dirname, '../server/music/register.ts'), 'utf8');
  const librarySource = fs.readFileSync(path.join(__dirname, '../server/music/library.ts'), 'utf8');
  const storage = fs.readFileSync(path.join(__dirname, '../server/music/storage.ts'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '../server/music/worker-main.ts'), 'utf8');
  assert.ok(fs.existsSync(path.join(__dirname, '../server/music/worker-main.ts')), 'worker entry exists');
  assert.match(worker, /captureFrame/, 'worker streams real PCM frames');
  assert.match(worker, /process\.send/, 'worker reports to the parent over IPC');
  assert.match(backend, /registerMusicSystem/, 'music system registered in the server');
  assert.match(backend, /app\.get\('\/fa'/, 'Persian landing route');
  assert.match(backend, /app\.get\('\/en'/, 'English landing route');
  assert.match(backend, /app\.get\('\/app'/, 'authenticated app route');
  assert.match(register, /music:command/, 'socket command handler registered');
  assert.match(register, /music:play_playlist/, 'playlist playback socket command registered');
  assert.match(register, /authorizeMusic/, 'backend authorization for every command');
  assert.match(register, /CONNECT_VOICE/, 'voice membership required');
  assert.match(register, /registerMusicLibrary/, 'library routes registered');
  // Upload flow: presigned, verified, honest.
  assert.match(librarySource, /upload\/init/, 'upload init endpoint exists');
  assert.match(librarySource, /upload\/complete/, 'upload completion + verification endpoint exists');
  assert.match(librarySource, /sniffAudioFormat/, 'content signature validation');
  assert.match(librarySource, /probeAudio/, 'server-side ffprobe metadata extraction');
  assert.match(librarySource, /DUPLICATE_TRACK/, 'duplicate detection');
  assert.match(librarySource, /deleteObject\(pending\.key\)/, 'invalid uploads are removed from storage');
  assert.match(storage, /presignUpload/, 'presigned PUT (browser → bucket directly)');
  assert.match(storage, /presignDownload/, 'short-lived signed download for the worker');
  assert.match(storage, /expiresIn: 900/, 'upload URLs are short-lived');
  for (const lang of ['fa', 'en']) {
    const page = fs.readFileSync(path.join(__dirname, `../public/landing/${lang}.html`), 'utf8');
    assert.match(page, /Mahyar Music|ماهیار میوزیک/, `${lang} landing mentions the music bot`);
    assert.match(page, /href="\/app"/, `${lang} landing links to the app`);
    if (lang === 'fa') {
      assert.match(page, /dir="rtl"/, 'Persian page is RTL');
      assert.match(page, /lang="fa"/, 'Persian page declares its language');
    } else {
      assert.match(page, /dir="ltr"/, 'English page is LTR');
    }
  }
  // Composer must never leak an /mp command into chat: app.js routes it to the engine.
  const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  assert.match(app, /music\.parse\(text\)/, 'sendMessage intercepts /mp commands');
  assert.match(app, /slash-menu/, 'slash command autocomplete exists');
  assert.match(app, /updateSlashTrackResults/, '/mp play autocompletes from the library');
  assert.match(app, /renderMusicLibraryModal/, 'music library modal exists');
  assert.match(app, /ml-dropzone/, 'drag & drop upload zone exists');
  assert.match(app, /musicLibraryUploadFiles/, 'upload pipeline wired');
  assert.match(app, /music-bot-chip/, 'bot participant chip exists');
  assert.match(app, /Music volume \(only you\)/, 'per-user music volume context menu exists');
  // Fullscreen consistency: the CSS target must match the JS element.
  const css = fs.readFileSync(path.join(__dirname, '../css/style.css'), 'utf8');
  assert.match(css, /\.voice-theater-stage:fullscreen/, 'fullscreen CSS targets the real stage element');
  assert.doesNotMatch(css, /\.video-theater-stage:fullscreen/, 'stale fullscreen selector removed');
});
