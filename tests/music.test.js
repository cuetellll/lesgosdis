/**
 * Mahyar Music — offline unit tests: command parsing, provider guards, wiring.
 * The full media path (bot worker + LiveKit + ffmpeg) is verified by the E2E
 * script (scripts/music_e2e.js) against a real LiveKit server.
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
  // URL passthrough keeps the whole link as the argument.
  const url = music.parse('/mp play https://example.com/track.mp3');
  assert.equal(url.args, 'https://example.com/track.mp3');
});

test('music client is a bot identity detector, not a guesser', () => {
  const music = loadMusicClient();
  assert.equal(music.constructor.isBotIdentity('mahyar-music:room123'), true);
  assert.equal(music.constructor.isBotIdentity('mahyar-music:'), true);
  assert.equal(music.constructor.isBotIdentity('user_someone'), false);
  assert.equal(music.constructor.isBotIdentity(''), false);
  assert.equal(music.constructor.isBotIdentity(undefined), false);
});

test('direct provider enforces the allow-list and SSRF guard', async () => {
  process.env.MUSIC_DIRECT_HOSTS = 'cdn.example.com';
  delete process.env.MUSIC_ALLOW_PRIVATE_HOSTS;
  // Fresh import so the provider picks up the env set above.
  delete require.cache[require.resolve('../dist/server/music/providers.js')];
  const { providers, providerForUrl } = require('../dist/server/music/providers.js');
  const direct = providers.find((p) => p.name === 'direct');
  assert.equal(direct.isConfigured(), true);

  const allowed = new URL('https://cdn.example.com/audio/song.mp3');
  assert.equal(providerForUrl(allowed).name, 'direct');
  const resolved = await direct.resolveUrl(allowed, 'user_1');
  assert.equal(resolved.tracks.length, 1);
  assert.equal(resolved.tracks[0].streamable, true);
  assert.ok(resolved.tracks[0].streamUrl.startsWith('https://cdn.example.com'));

  await assert.rejects(() => direct.resolveUrl(new URL('https://evil.example.com/song.mp3'), 'user_1'), /not allow-listed/);
  await assert.rejects(() => direct.resolveUrl(new URL('http://169.254.169.254/latest/meta-data'), 'user_1'), /not reachable|not allow-listed/);
  await assert.rejects(() => direct.resolveUrl(new URL('http://192.168.1.10/music.mp3'), 'user_1'), /not reachable|not allow-listed/);

  // Unknown hosts never match the direct provider by URL sniffing alone.
  const foreign = new URL('https://open.spotify.com/track/abc');
  assert.equal(providerForUrl(foreign).name, 'spotify');
  delete process.env.MUSIC_DIRECT_HOSTS;
});

test('spotify provider never returns a playable stream', async () => {
  delete require.cache[require.resolve('../dist/server/music/providers.js')];
  const { providers } = require('../dist/server/music/providers.js');
  const spotify = providers.find((p) => p.name === 'spotify');
  assert.equal(spotify.isConfigured(), false, 'spotify is metadata-only and needs credentials; audio is never published');
  const result = await spotify.search('anything');
  assert.deepEqual(result.tracks, []);
});

test('soundcloud provider stays metadata-only without the operator attestation', async () => {
  process.env.SOUNDCLOUD_CLIENT_ID = 'test-client-id';
  process.env.SOUNDCLOUD_SHARED_PLAYBACK_AUTHORIZED = '';
  delete require.cache[require.resolve('../dist/server/music/providers.js')];
  const { providers } = require('../dist/server/music/providers.js');
  const sc = providers.find((p) => p.name === 'soundcloud');
  assert.equal(sc.isConfigured(), true);
  assert.equal(sc.status().configured, true);
  assert.match(sc.status().note, /attestation/i);
  delete process.env.SOUNDCLOUD_CLIENT_ID;
  delete process.env.SOUNDCLOUD_SHARED_PLAYBACK_AUTHORIZED;
});

test('music system is wired: worker entry, socket command, routes, landing pages', () => {
  const backend = fs.readFileSync(path.join(__dirname, '../server/index.ts'), 'utf8');
  const register = fs.readFileSync(path.join(__dirname, '../server/music/register.ts'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '../server/music/worker-main.ts'), 'utf8');
  assert.ok(fs.existsSync(path.join(__dirname, '../server/music/worker-main.ts')), 'worker entry exists');
  assert.match(worker, /captureFrame/, 'worker streams real PCM frames');
  assert.match(worker, /process\.send/, 'worker reports to the parent over IPC');
  assert.match(backend, /registerMusicSystem/, 'music system registered in the server');
  assert.match(backend, /app\.get\('\/fa'/, 'Persian landing route');
  assert.match(backend, /app\.get\('\/en'/, 'English landing route');
  assert.match(backend, /app\.get\('\/app'/, 'authenticated app route');
  assert.match(register, /music:command/, 'socket command handler registered');
  assert.match(register, /authorizeMusic/, 'backend authorization for every command');
  assert.match(register, /CONNECT_VOICE/, 'voice membership required');
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
  assert.match(app, /music-bot-chip/, 'bot participant chip exists');
  assert.match(app, /Music volume \(only you\)/, 'per-user music volume context menu exists');
});
