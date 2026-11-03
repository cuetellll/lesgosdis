/**
 * Mahyar Music — client module.
 *
 * Owns the client-side music state (per voice channel), the /mp command catalog,
 * command parsing, and the ack-based command transport. Rendering stays in app.js;
 * this module stays rendering-free on purpose so it can be unit-tested.
 */
(function () {
  'use strict';

  const MUSIC_COMMANDS = [
    { name: '/mp play', args: '<track name>', description: 'Search the shared Music Library and play it for everyone.', hint: 'Type a track name — results come from your server library.', kind: 'command' },
    { name: '/mp queue', args: '', description: 'Show the upcoming music queue.', hint: '', kind: 'command' },
    { name: '/mp pause', args: '', description: 'Pause playback for everyone.', hint: '', kind: 'command' },
    { name: '/mp resume', args: '', description: 'Resume playback for everyone.', hint: '', kind: 'command' },
    { name: '/mp skip', args: '', description: 'Skip the current track.', hint: '', kind: 'command' },
    { name: '/mp stop', args: '', description: 'Stop playback and clear the queue.', hint: '', kind: 'command' },
    { name: '/mp nowplaying', args: '', description: 'Show the currently playing track.', hint: '', kind: 'command' }
  ];

  const MUSIC_BOT_PREFIX = 'mahyar-music:';

  class MahyarMusic {
    constructor(api) {
      this.api = api;
      /** channel_id -> last PublicMusicState */
      this.states = new Map();
      /** listeners: (state) => void */
      this.listeners = new Set();
    }

    handleState(state) {
      if (!state || typeof state.channel_id !== 'string') return;
      this.states.set(state.channel_id, state);
      this.listeners.forEach((cb) => { try { cb(state); } catch (_) { /* listener error */ } });
    }

    onState(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

    stateFor(channelId) { return this.states.get(channelId) || null; }

    /** True when the LiveKit participant identity belongs to Mahyar Music. */
    static isBotIdentity(identity) { return typeof identity === 'string' && identity.startsWith(MUSIC_BOT_PREFIX); }

    commandCatalog() { return MUSIC_COMMANDS.slice(); }

    /**
     * Parse a typed input. Returns:
     *  - { command: null }                    — not a music command
     *  - { command, args, complete, error }   — music command
     */
    parse(input) {
      const text = String(input || '').trim();
      if (!text.startsWith('/')) return { command: null };
      const segments = text.slice(1).split(/\s+/);
      const head = (segments[0] || '').toLowerCase();
      if (head !== 'mp') return { command: null };
      const sub = (segments[1] || '').toLowerCase();
      const known = ['play', 'queue', 'pause', 'resume', 'skip', 'stop', 'nowplaying'];
      if (!sub) return { command: 'help', args: '', complete: false };
      if (!known.includes(sub)) return { command: 'unknown', args: segments.slice(2).join(' '), complete: true, error: `Unknown command "/mp ${sub}". Try /mp play <song or link>.` };
      const args = text.slice(1).replace(/^\s*mp\s+\S+/i, '').trim();
      return { command: sub, args, complete: true };
    }

    /** True when the input is a /mp play command with a search term typed after it. */
    playSearchTerm(input) {
      const text = String(input || '');
      const match = /^\s*\/mp\s+play\s+(.{1,120})$/i.exec(text);
      return match ? match[1].trim() : null;
    }

    /**
     * Executes a parsed music command in the given voice channel context.
     * Returns the raw ack from the server ({ok, message|error, state?, tracks?, action?}).
     */
    async execute(channelId, parsed) {
      if (!parsed || !parsed.command) return { ok: false, error: 'Not a music command.' };
      switch (parsed.command) {
        case 'play':
          if (!parsed.args) return { ok: false, error: 'Usage: /mp play <song name or link>' };
          return await this.api.musicCommand(channelId, 'play', { query: parsed.args });
        case 'pick':
          return await this.api.musicCommand(channelId, 'pick', { track_id: parsed.args });
        case 'pause': return await this.api.musicCommand(channelId, 'pause');
        case 'resume': return await this.api.musicCommand(channelId, 'resume');
        case 'skip': return await this.api.musicCommand(channelId, 'skip');
        case 'stop': return await this.api.musicCommand(channelId, 'stop');
        case 'queue': return await this.api.musicCommand(channelId, 'queue');
        case 'nowplaying': return await this.api.musicCommand(channelId, 'nowplaying');
        case 'help':
          return { ok: false, error: 'Mahyar Music commands: /mp play, /mp queue, /mp pause, /mp resume, /mp skip, /mp stop, /mp nowplaying.' };
        case 'unknown':
          return { ok: false, error: parsed.error || 'Unknown music command.' };
        default:
          return { ok: false, error: 'Unknown music command.' };
      }
    }

    /** Runs a standalone search (used by the composer preview and the picker). */
    async search(channelId, query) {
      return await this.api.musicCommand(channelId, 'search', { query });
    }

    formatDuration(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
  }

  window.MahyarMusic = MahyarMusic;
})();
