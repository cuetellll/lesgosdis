const MAHYAR_TOKEN_KEY = 'mahyar_gap_access_token';
const LEGACY_TOKEN_KEY = 'pulsecord_access_token';

class MahyarAPI {
  constructor() {
    this.bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mahyar_gap_realtime_bus') : null;
    this.listeners = new Set();
    this.socket = null;
    this.joinedChannelId = null;
    if (this.bus) this.bus.onmessage = (event) => this.listeners.forEach((cb) => { try { cb(event.data); } catch (err) { console.error('Realtime listener error:', err); } });
  }

  token() {
    return localStorage.getItem(MAHYAR_TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || '';
  }

  headers(extra = {}) {
    const headers = new Headers(extra);
    const token = this.token();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  async request(url, options = {}, internalRetry = false) {
    const response = await fetch(url, { ...options, headers: this.headers(options.headers) });
    if (response.status === 401 && !url.startsWith('/auth/login') && !url.startsWith('/auth/register') && !url.startsWith('/auth/refresh')) {
      // One transparent refresh attempt: an expired access token rotates silently instead of
      // throwing the user back to the login screen mid-session.
      if (!internalRetry && await this.refreshSession()) {
        return this.request(url, options, true);
      }
      this.clearToken();
      window.dispatchEvent(new CustomEvent('mahyar_gap:auth-expired'));
    }
    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      let body = {};
      try { const parsed = await response.json(); if (parsed && typeof parsed === 'object') body = parsed; message = body.error || body.message || message; } catch (_) { /* non-JSON response */ }
      const error = new Error(message);
      error.status = response.status;
      if (typeof body.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)) error.code = body.code;
      if (typeof body.errorId === 'string' && /^[a-f0-9-]{16,64}$/i.test(body.errorId)) error.errorId = body.errorId;
      if (Array.isArray(body.missingVariables)) error.missingVariables = body.missingVariables.filter((name) => ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].includes(name));
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  clearToken() {
    localStorage.removeItem(MAHYAR_TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem('mahyar_gap_token_issued_at');
  }

  #refreshInFlight = null;
  /** Rotates the access token once and reconnects the realtime socket with the fresh credential. */
  async refreshSession() {
    if (!this.token()) return false;
    if (!this.#refreshInFlight) {
      this.#refreshInFlight = (async () => {
        try {
          const response = await fetch('/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${this.token()}` } });
          if (!response.ok) return false;
          const body = await response.json();
          if (!body?.accessToken) return false;
          this.clearToken();
          localStorage.setItem(MAHYAR_TOKEN_KEY, body.accessToken);
          localStorage.setItem('mahyar_gap_token_issued_at', String(Date.now()));
          if (this.socket?.connected) {
            this.socket.disconnect();
            this.socket = null;
            this.connectRealtime();
          }
          return true;
        } catch (_) { return false; }
        finally { setTimeout(() => { this.#refreshInFlight = null; }, 500); }
      })();
    }
    return this.#refreshInFlight;
  }

  async login(email, password) {
    const result = await this.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    this.clearToken();
    localStorage.setItem(MAHYAR_TOKEN_KEY, result.accessToken);
    localStorage.setItem('mahyar_gap_token_issued_at', String(Date.now()));
    return result.user;
  }

  async register(data) {
    const result = await this.request('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    this.clearToken();
    localStorage.setItem(MAHYAR_TOKEN_KEY, result.accessToken);
    localStorage.setItem('mahyar_gap_token_issued_at', String(Date.now()));
    return result.user;
  }

  async me() { return (await this.request('/auth/me')).user; }

  logout() {
    this.clearToken();
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
    this.joinedChannelId = null;
  }

  connectRealtime() {
    if (this.socket || typeof window.io !== 'function' || !this.token()) return this.socket;
    this.socket = window.io({ auth: { token: this.token() }, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelayMax: 10000 });
    this.socket.on('connect', () => {
      if (this.joinedChannelId) this.socket.emit('channel:join', this.joinedChannelId);
      this.emitEvent('socket_connected', {});
    });
    this.socket.on('connect_error', (err) => {
      console.warn('Realtime connection error:', err.message);
      if (/expired|invalid token|authentication/i.test(err.message)) window.dispatchEvent(new CustomEvent('mahyar_gap:auth-expired'));
    });
    this.socket.on('message:new', (message) => this.emitEvent('message_new', message));
    this.socket.on('message:updated', (message) => this.emitEvent('message_updated', message));
    this.socket.on('message:deleted', (message) => this.emitEvent('message_deleted', message));
    this.socket.on('voice:updated', (session) => this.emitEvent('voice_updated', session));
    this.socket.on('direct_message:new', (message) => this.emitEvent('direct_message_new', message));
    this.socket.on('direct_message:updated', (message) => this.emitEvent('direct_message_updated', message));
    this.socket.on('direct_message:deleted', (message) => this.emitEvent('direct_message_deleted', message));
    this.socket.on('server:membership_revoked', (membership) => this.emitEvent('server_membership_revoked', membership));
    this.socket.on('server:permissions_changed', (membership) => this.emitEvent('server_permissions_changed', membership));
    this.socket.on('presence:update', (payload) => this.emitEvent('presence_update', payload));
    this.socket.on('typing:update', (payload) => this.emitEvent('typing_update', payload));
    this.socket.on('dm:typing', (payload) => this.emitEvent('dm_typing', payload));
    this.socket.on('dm:call_started', (payload) => this.emitEvent('dm_call_started', payload));
    this.socket.on('dm:call_ended', (payload) => this.emitEvent('dm_call_ended', payload));
    this.socket.on('notification:new', (payload) => this.emitEvent('notification_new', payload));
    this.socket.on('direct_message:conversation_updated', (payload) => this.emitEvent('dm_conversation_updated', payload));
    this.socket.on('music:state', (state) => this.emitEvent('music_state', state));
    this.socket.on('music_library_updated', (payload) => this.emitEvent('music_library_updated', payload));
    return this.socket;
  }

  /** Sends a Mahyar Music command over the realtime socket (ack-based, 10 s timeout). */
  musicCommand(channelId, action, extra = {}) {
    return new Promise((resolve) => {
      if (!this.socket?.connected) return resolve({ ok: false, error: 'Realtime connection is offline — try again in a moment.' });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'The music command timed out.' }); } }, 10_000);
      this.socket.emit('music:command', { channel_id: channelId, action, ...extra }, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result || { ok: false, error: 'The music service did not respond.' });
      });
    });
  }

  joinServer(serverId) {
    if (this.socket?.connected && serverId) this.socket.emit('server:join', serverId);
  }

  // ------------------------------ Mahyar Music shared library (REST) ------------------------------

  musicLibraryStatus(serverId) {
    return this.request(`/api/music/library/status?server_id=${encodeURIComponent(serverId || '')}`);
  }

  musicLibrary(serverId, { q = '', limit = 60, offset = 0 } = {}) {
    const params = new URLSearchParams({ server_id: serverId || '', limit: String(limit), offset: String(offset) });
    if (q) params.set('q', q);
    return this.request(`/api/music/library?${params}`);
  }

  musicRecent(serverId, limit = 10) {
    return this.request(`/api/music/recent?server_id=${encodeURIComponent(serverId || '')}&limit=${limit}`);
  }

  /** Asks the backend for a presigned upload slot (format/size/quota checks happen there). */
  musicUploadInit(serverId, file) {
    return this.request('/api/music/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: serverId, file_name: file.name, content_type: file.type || undefined, size_bytes: file.size })
    });
  }

  /** PUTs the bytes straight into the private bucket via the presigned URL (progress-capable).
   *  No Authorization header here on purpose: the signature itself authorizes the request. */
  musicUploadPut(uploadUrl, file, contentType, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      if (contentType) xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = (event) => { if (event.lengthComputable && typeof onProgress === 'function') onProgress(Math.round((event.loaded / event.total) * 100)); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve(true);
        let message = `Storage rejected the upload (HTTP ${xhr.status}).`;
        try { const parsed = JSON.parse(xhr.responseText || '{}'); if (parsed?.Code === 'EntityTooLarge') message = 'The file is larger than the configured limit.'; } catch (_) {}
        reject(new Error(message));
      };
      xhr.onerror = () => reject(new Error('Upload to storage failed: the network connection was interrupted.'));
      xhr.send(file);
    });
  }

  /** Tells the backend the bytes are in the bucket; it verifies and creates the library entry. */
  musicUploadComplete(uploadToken, meta = {}) {
    return this.request('/api/music/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_token: uploadToken, ...meta })
    });
  }

  musicTrackPatch(trackId, meta) {
    return this.request(`/api/music/tracks/${encodeURIComponent(trackId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
  }

  musicTrackDelete(trackId) {
    return this.request(`/api/music/tracks/${encodeURIComponent(trackId)}`, { method: 'DELETE' });
  }

  musicPlaylists(serverId) {
    return this.request(`/api/music/playlists?server_id=${encodeURIComponent(serverId || '')}`);
  }

  musicPlaylistDetail(playlistId) {
    return this.request(`/api/music/playlists/${encodeURIComponent(playlistId)}`);
  }

  musicPlaylistCreate(serverId, name) {
    return this.request('/api/music/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_id: serverId, name }) });
  }

  musicPlaylistRename(playlistId, name) {
    return this.request(`/api/music/playlists/${encodeURIComponent(playlistId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  }

  musicPlaylistDelete(playlistId) {
    return this.request(`/api/music/playlists/${encodeURIComponent(playlistId)}`, { method: 'DELETE' });
  }

  musicPlaylistAddTrack(playlistId, trackId) {
    return this.request(`/api/music/playlists/${encodeURIComponent(playlistId)}/tracks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track_id: trackId }) });
  }

  musicPlaylistRemoveTrack(playlistId, trackId) {
    return this.request(`/api/music/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`, { method: 'DELETE' });
  }

  musicPlaylistReorder(playlistId, orderedTrackIds) {
    return this.request(`/api/music/playlists/${encodeURIComponent(playlistId)}/tracks`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ordered_track_ids: orderedTrackIds }) });
  }

  /** Queues a whole playlist into a voice channel (ack-based socket command). */
  musicPlayPlaylist(channelId, playlistId) {
    return new Promise((resolve) => {
      if (!this.socket?.connected) return resolve({ ok: false, error: 'Realtime connection is offline — try again in a moment.' });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'The playlist request timed out.' }); } }, 10_000);
      this.socket.emit('music:play_playlist', { channel_id: channelId, playlist_id: playlistId }, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result || { ok: false, error: 'The music service did not respond.' });
      });
    });
  }

  joinChannel(channelId) {
    if (this.joinedChannelId && this.joinedChannelId !== channelId && this.socket?.connected) this.socket.emit('channel:leave', this.joinedChannelId);
    this.joinedChannelId = channelId || null;
    if (this.socket?.connected && channelId) this.socket.emit('channel:join', channelId, (result) => { if (result?.error) console.warn('Channel join rejected:', result.error); });
  }

  typing(channelId, conversationId) {
    if (!this.socket?.connected) return;
    if (channelId) this.socket.emit('typing:start', { channelId });
    if (conversationId) this.socket.emit('dm:typing', { conversationId });
  }

  onEvent(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }

  emitEvent(type, payload) {
    const packet = { type, payload, ts: Date.now() };
    if (this.bus) this.bus.postMessage(packet);
    this.listeners.forEach((cb) => { try { cb(packet); } catch (err) { console.error('Realtime listener error:', err); } });
  }

  async list(table, { page = 1, limit = 100, search = '', sort = '', channel_id = '', conversation_id = '', before = '' } = {}) {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    if (sort) params.set('sort', sort);
    if (channel_id) params.set('channel_id', channel_id);
    if (conversation_id) params.set('conversation_id', conversation_id);
    if (before) params.set('before', before);
    const json = await this.request(`/tables/${encodeURIComponent(table)}?${params}`);
    return Array.isArray(json.data) ? json.data : [];
  }

  get(table, id) { return this.request(`/tables/${encodeURIComponent(table)}/${encodeURIComponent(id)}`); }

  async create(table, record) {
    const created = await this.request(`/tables/${encodeURIComponent(table)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
    this.emitEvent('table_mutated', { table, action: 'create', record: created });
    return created;
  }

  async patch(table, id, partial) {
    const updated = await this.request(`/tables/${encodeURIComponent(table)}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial) });
    this.emitEvent('table_mutated', { table, action: 'patch', record: updated });
    return updated;
  }

  async remove(table, id) {
    await this.request(`/tables/${encodeURIComponent(table)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this.emitEvent('table_mutated', { table, action: 'delete', id });
    return true;
  }

  /**
   * Uploads raw file bytes to the server-side attachment storage (S3-compatible, e.g. R2).
   * The server streams the bytes into the bucket; a failed storage operation always throws,
   * so the UI can never show a successful upload that did not actually happen.
   */
  async uploadAttachment(file, onProgress) {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'application/pdf', 'text/plain'];
    const type = file.type || 'application/octet-stream';
    if (!allowed.includes(type)) throw new Error(`Files of type "${type || 'unknown'}" are not allowed.`);
    if (file.size > 50 * 1024 * 1024) throw new Error('Files are limited to 50 MB.');
    const url = `/api/files/upload?name=${encodeURIComponent(file.name.slice(0, 256))}&type=${encodeURIComponent(type)}`;
    if (typeof onProgress === 'function' && typeof XMLHttpRequest !== 'undefined') {
      return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Authorization', `Bearer ${this.token()}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
        xhr.onload = () => {
          let body = {};
          try { body = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
          if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
          const error = new Error(body.error || `Upload failed with status ${xhr.status}`);
          error.status = xhr.status;
          if (Array.isArray(body.missingVariables)) error.missingVariables = body.missingVariables;
          if (body.code) error.code = body.code;
          reject(error);
        };
        xhr.onerror = () => reject(new Error('Upload failed: the network connection was interrupted.'));
        xhr.send(file);
      });
    }
    return await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  }
}

window.pulseAPI = new MahyarAPI();
