/**
 * Mahyar Gap — LiveKit media engine.
 * Real media only: microphone, camera, screen share, per-participant audio gain.
 * No synthetic participants, no canvas placeholders.
 */

const VOLUME_STORAGE_KEY = 'mahyar_gap_voice_volumes';

function readStoredVolumes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VOLUME_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [identity, value] of Object.entries(parsed)) {
      const volume = Number(value);
      if (identity && Number.isFinite(volume) && volume >= 0 && volume <= 200) clean[identity] = volume;
    }
    return clean;
  } catch (_) {
    return {};
  }
}

class MahyarMediaEngine {
  constructor(onStateChange) {
    this.onStateChange = onStateChange || (() => {});
    this.activeChannelId = null;
    this.activeServerId = null;
    this.activeDmConversationId = null;
    this.mode = 'idle'; // 'idle' | 'voice' | 'dm'
    this.connectionStatus = 'disconnected';
    this.pingMs = null;
    this.isMuted = false;
    this.isDeafened = false;
    this.isVideoEnabled = false;
    this.isScreenSharing = false;
    this.isSpeaking = false;
    this.speakingIdentities = new Set();
    this.audioInputs = [];
    this.audioOutputs = [];
    this.videoInputs = [];
    this.selectedAudioInput = 'default';
    this.selectedAudioOutput = 'default';
    this.selectedVideoInput = 'default';
    this.room = null;
    this.canSpeak = false;
    this.canStream = false;
    this.remoteVideoTracks = new Map();
    this.audioElements = new Map();
    this.gainNodes = new Map();
    this.audioSources = new Map();
    this.audioContext = null;
    this.userVolumes = readStoredVolumes();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.reconnectInProgress = false;
  }

  notify(eventType) { this.onStateChange(this, eventType); }

  async enumerateHardwareDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { audioInputs: [], audioOutputs: [], videoInputs: [] };
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioInputs = devices.filter((d) => d.kind === 'audioinput');
      this.audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
      this.videoInputs = devices.filter((d) => d.kind === 'videoinput');
    } catch (error) { console.warn('Device enumeration failed:', error); }
    return { audioInputs: this.audioInputs, audioOutputs: this.audioOutputs, videoInputs: this.videoInputs };
  }

  // ---------------------------------------------------------------- volumes
  getUserVolume(identity) {
    const stored = this.userVolumes[identity];
    return typeof stored === 'number' ? stored : 100;
  }

  applyUserVolume(identity) {
    // Deafening mutes the graph rather than the element, because a MediaElementAudioSourceNode
    // diverts element audio out of the element's own muted/volume path.
    const volume = this.isDeafened ? 0 : this.getUserVolume(identity) / 100;
    const gain = this.gainNodes.get(identity);
    if (gain) {
      gain.gain.setTargetAtTime(volume, this.audioContext?.currentTime || 0, 0.01);
      return;
    }
    // Fallback when Web Audio is unavailable (or blocked): the element accepts 0..1 only.
    for (const [key, element] of this.audioElements.entries()) {
      if (key.startsWith(`${identity}:`)) element.volume = Math.min(1, volume);
    }
  }

  setUserVolume(identity, percent) {
    const value = Math.max(0, Math.min(200, Math.round(Number(percent) || 0)));
    this.userVolumes[identity] = value;
    try { localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(this.userVolumes)); } catch (_) { /* storage may be blocked */ }
    this.applyUserVolume(identity);
    this.notify('local-volume-changed');
    return value;
  }

  toggleUserMute(identity) {
    const current = this.getUserVolume(identity);
    if (current === 0) {
      const restored = Number(this.userVolumes[`${identity}:restore`]) || 100;
      this.setUserVolume(identity, restored);
      return restored;
    }
    this.userVolumes[`${identity}:restore`] = current;
    try { localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(this.userVolumes)); } catch (_) { /* ignore */ }
    this.setUserVolume(identity, 0);
    return 0;
  }

  // ------------------------------------------------------------- audio path
  ensureAudioContext() {
    if (this.audioContext) return this.audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      this.audioContext = new AudioContextClass();
    } catch (error) {
      console.warn('Web Audio is unavailable; falling back to element volume:', error);
      this.audioContext = null;
    }
    return this.audioContext;
  }

  attachRemoteAudio(track, participant) {
    const audio = track.attach();
    audio.autoplay = true;
    audio.playsInline = true;
    audio.muted = this.isDeafened;
    audio.dataset.livekitIdentity = participant.identity;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    const key = `${participant.identity}:${track.sid || participant.sid}`;
    this.audioElements.set(key, audio);

    const context = this.ensureAudioContext();
    let connectedToGraph = false;
    if (context) {
      try {
        if (context.state === 'suspended') context.resume().catch(() => {});
        const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        const gain = context.createGain();
        gain.gain.value = this.isDeafened ? 0 : this.getUserVolume(participant.identity) / 100;
        source.connect(gain).connect(context.destination);
        this.gainNodes.set(participant.identity, gain);
        this.audioSources.set(participant.identity, source);
        connectedToGraph = true;
      } catch (error) {
        console.warn('Per-participant audio gain unavailable; using element volume:', error);
      }
    }
    // When the Web Audio graph owns playback, mute the element itself to avoid double audio.
    if (connectedToGraph) {
      audio.volume = 0;
    } else {
      audio.volume = Math.min(1, this.getUserVolume(participant.identity) / 100);
    }
    return audio;
  }

  detachRemoteAudio(track, participant) {
    for (const [key, audio] of [...this.audioElements.entries()]) {
      if (key.startsWith(`${participant.identity}:`)) {
        try { track.detach(audio); } catch (_) { /* already detached */ }
        audio.pause();
        audio.srcObject = null;
        audio.remove();
        this.audioElements.delete(key);
      }
    }
    const gain = this.gainNodes.get(participant.identity);
    if (gain) {
      try { gain.disconnect(); } catch (_) { /* ignore */ }
      this.gainNodes.delete(participant.identity);
    }
    const source = this.audioSources.get(participant.identity);
    if (source) {
      try { source.disconnect(); } catch (_) { /* ignore */ }
      this.audioSources.delete(participant.identity);
    }
  }

  // ---------------------------------------------------------------- joining
  async joinVoiceChannel(serverId, channelId, options = { withVideo: false }) {
    if (this.room && this.mode === 'voice' && this.activeChannelId === channelId && this.connectionStatus === 'connected') {
      if (options.withVideo && this.canStream && !this.isVideoEnabled) await this.toggleCamera(true);
      return;
    }
    if (this.room) await this.leaveVoiceChannel();
    const result = await window.pulseAPI.request('/api/voice/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId })
    });
    await this.connectRoom(result, {
      mode: 'voice', serverId, channelId,
      canSpeak: Boolean(result.permissions?.canSpeak),
      canStream: Boolean(result.permissions?.canStream),
      withVideo: Boolean(options.withVideo)
    });
  }

  async joinDirectCall(conversationId, options = { withVideo: false }) {
    if (this.room && this.mode === 'dm' && this.activeDmConversationId === conversationId && this.connectionStatus === 'connected') {
      if (options.withVideo && !this.isVideoEnabled) await this.toggleCamera(true);
      return;
    }
    if (this.room) await this.leaveVoiceChannel();
    const result = await window.pulseAPI.request('/api/dm/call-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId })
    });
    await this.connectRoom(result, {
      mode: 'dm', conversationId,
      canSpeak: true, canStream: true, withVideo: Boolean(options.withVideo)
    });
  }

  async connectRoom(result, { mode, serverId = null, channelId = null, conversationId = null, canSpeak, canStream, withVideo = false }) {
    if (!window.PulseLiveKit?.Room) throw new Error('LiveKit client bundle is unavailable; media cannot connect.');
    this.connectionStatus = 'connecting';
    this.mode = mode;
    this.activeServerId = serverId;
    this.activeChannelId = channelId;
    this.activeDmConversationId = conversationId;
    this.canSpeak = canSpeak;
    this.canStream = canStream;
    this.notify();

    try {
      await this.enumerateHardwareDevices();
      const { Room, RoomEvent, Track } = window.PulseLiveKit;
      const room = new Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true });
      this.room = room;

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.onTrackSubscribed(track, publication, participant));
      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => this.onTrackUnsubscribed(track, publication, participant));
      room.on(RoomEvent.ParticipantConnected, () => this.notify('participant-joined'));
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        this.speakingIdentities.delete(participant.identity);
        this.notify('participant-left');
      });
      room.on(RoomEvent.TrackMuted, () => this.notify('track-muted'));
      room.on(RoomEvent.TrackUnmuted, () => this.notify('track-unmuted'));
      room.on(RoomEvent.TrackPublished, () => this.notify('track-published'));
      room.on(RoomEvent.TrackUnpublished, () => this.notify('track-unpublished'));
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        this.speakingIdentities = new Set(speakers.map((p) => p.identity));
        this.isSpeaking = this.speakingIdentities.has(room.localParticipant.identity);
        this.notify('speaking-changed');
      });
      room.on(RoomEvent.ConnectionQualityChanged, () => this.notify('quality-changed'));
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        this.connectionStatus = state === 'signalReconnecting' ? 'reconnecting' : state;
        this.notify('connection-state');
      });
      room.on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return;
        const retry = { mode, serverId, channelId, conversationId };
        this.room = null;
        this.cleanupAudio();
        this.remoteVideoTracks.clear();
        this.isVideoEnabled = false;
        this.isScreenSharing = false;
        this.isSpeaking = false;
        this.speakingIdentities.clear();
        if (retry.mode === 'voice' && serverId && channelId) {
          this.connectionStatus = 'reconnecting';
          this.scheduleReconnect(serverId, channelId);
        } else {
          this.connectionStatus = 'disconnected';
          this.mode = 'idle';
          this.activeDmConversationId = null;
        }
        this.notify('disconnected');
      });
      room.on(RoomEvent.LocalTrackUnpublished, (publication, participant) => {
        if (this.room === room && participant === room.localParticipant) {
          if (publication.source === Track.Source.Camera) this.isVideoEnabled = false;
          if (publication.source === Track.Source.ScreenShare) this.isScreenSharing = false;
          this.notify('local-track-unpublished');
        }
      });

      await room.connect(result.url, result.token, { autoSubscribe: true });
      this.reconnectAttempts = 0;
      try { await room.switchActiveDevice('audiooutput', this.selectedAudioOutput); }
      catch (error) { console.warn('Could not apply the selected audio output device:', error); }

      if (this.canSpeak) {
        const audioOptions = this.selectedAudioInput === 'default'
          ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : { deviceId: this.selectedAudioInput, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        try { await room.localParticipant.setMicrophoneEnabled(true, audioOptions); this.isMuted = false; }
        catch (error) { this.isMuted = true; console.warn('Microphone unavailable; staying connected as listener:', error); this.notify('microphone-unavailable'); }
      } else {
        this.isMuted = true;
      }
      this.connectionStatus = 'connected';
      if (withVideo && this.canStream) await this.toggleCamera(true).catch((error) => console.warn('Camera did not start:', error));
      this.notify('connected');
    } catch (error) {
      await this.leaveVoiceChannel(this.reconnectInProgress);
      throw error;
    }
  }

  onTrackSubscribed(track, publication, participant) {
    const Track = window.PulseLiveKit.Track;
    if (track.kind === Track.Kind.Audio) {
      this.attachRemoteAudio(track, participant);
    } else if (track.kind === Track.Kind.Video) {
      const source = publication.source || track.source;
      if (source === Track.Source.ScreenShare) this.remoteVideoTracks.set(`screen:${participant.identity}`, track);
      else this.remoteVideoTracks.set(`camera:${participant.identity}`, track);
    }
    this.notify('track-subscribed');
  }

  onTrackUnsubscribed(track, publication, participant) {
    if (track.kind === window.PulseLiveKit.Track.Kind.Audio) {
      this.detachRemoteAudio(track, participant);
    } else {
      track.detach();
      const prefix = publication.source === window.PulseLiveKit.Track.Source.ScreenShare ? 'screen' : 'camera';
      this.remoteVideoTracks.delete(`${prefix}:${participant.identity}`);
    }
    this.notify('track-unsubscribed');
  }

  cleanupAudio() {
    for (const audio of this.audioElements.values()) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
    this.audioElements.clear();
    for (const gain of this.gainNodes.values()) { try { gain.disconnect(); } catch (_) { /* ignore */ } }
    this.gainNodes.clear();
    for (const source of this.audioSources.values()) { try { source.disconnect(); } catch (_) { /* ignore */ } }
    this.audioSources.clear();
  }

  scheduleReconnect(serverId, channelId) {
    if (this.reconnectAttempts >= 5) {
      this.connectionStatus = 'disconnected';
      this.activeChannelId = null;
      this.activeServerId = null;
      this.mode = 'idle';
      this.notify('reconnect-exhausted');
      return;
    }
    const delay = Math.min(30000, 1000 * (2 ** this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectInProgress = true;
      try {
        await this.joinVoiceChannel(serverId, channelId);
        this.reconnectInProgress = false;
      } catch (error) {
        this.reconnectInProgress = false;
        console.warn('Reconnect attempt failed:', error.message);
        this.activeServerId = serverId;
        this.activeChannelId = channelId;
        this.connectionStatus = 'reconnecting';
        this.notify('reconnect-failed');
        this.scheduleReconnect(serverId, channelId);
      }
    }, delay);
  }

  attachRemoteVideo(identity, element, source = 'camera') {
    const track = this.remoteVideoTracks.get(`${source}:${identity}`);
    if (!track || !element) return;
    if (element.dataset.attachedIdentity === identity && element.dataset.attachedSource === source) return;
    track.attach(element);
    element.dataset.attachedIdentity = identity;
    element.dataset.attachedSource = source;
  }

  async leaveVoiceChannel(preserveRetry = false) {
    if (!preserveRetry) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;
    }
    const room = this.room;
    this.room = null;
    if (room) {
      try { await room.disconnect(); } catch (error) { console.warn('LiveKit disconnect warning:', error); }
    }
    this.cleanupAudio();
    this.remoteVideoTracks.clear();
    this.activeChannelId = null;
    this.activeServerId = null;
    this.activeDmConversationId = null;
    this.mode = 'idle';
    this.connectionStatus = 'disconnected';
    this.isMuted = false;
    this.isDeafened = false;
    this.isVideoEnabled = false;
    this.isScreenSharing = false;
    this.isSpeaking = false;
    this.speakingIdentities.clear();
    this.pingMs = null;
    this.notify('left');
  }

  async toggleMute() {
    if (!this.room) throw new Error('Join a voice channel or call first.');
    if (!this.canSpeak) throw new Error('Your role does not allow microphone publishing.');
    this.isMuted = !this.isMuted;
    await this.room.localParticipant.setMicrophoneEnabled(!this.isMuted);
    this.notify('mute-changed');
    return this.isMuted;
  }

  toggleDeafen() {
    if (!this.room) throw new Error('Join a voice channel or call first.');
    this.isDeafened = !this.isDeafened;
    for (const audio of this.audioElements.values()) audio.muted = this.isDeafened;
    for (const identity of this.gainNodes.keys()) this.applyUserVolume(identity);
    this.notify('deafen-changed');
    return this.isDeafened;
  }

  async toggleCamera(forceState) {
    if (!this.room) throw new Error('Join a voice channel or call first.');
    const target = typeof forceState === 'boolean' ? forceState : !this.isVideoEnabled;
    if (target && !this.canStream) throw new Error('Your role does not allow camera or screen sharing.');
    const { VideoPresets } = window.PulseLiveKit;
    await this.room.localParticipant.setCameraEnabled(
      target,
      target ? { resolution: VideoPresets.h720.resolution, deviceId: this.selectedVideoInput === 'default' ? undefined : this.selectedVideoInput } : undefined
    );
    this.isVideoEnabled = target;
    this.notify('camera-changed');
    return { enabled: target, mode: 'livekit' };
  }

  async toggleScreenShare() {
    if (!this.room) throw new Error('Join a voice channel or call first.');
    if (!this.canStream) throw new Error('Your role does not allow camera or screen sharing.');
    const target = !this.isScreenSharing;
    await this.room.localParticipant.setScreenShareEnabled(target, target ? { audio: true } : undefined);
    this.isScreenSharing = target;
    this.notify('screen-share-changed');
    return { sharing: target, mode: 'livekit' };
  }

  /** Metadata for a remote participant, sourced from the live LiveKit room. */
  getParticipantState(identity) {
    const participant = this.room?.remoteParticipants?.get(identity);
    if (!participant) {
      if (identity === this.room?.localParticipant?.identity) {
        return {
          muted: this.isMuted, camera: this.isVideoEnabled, screen: this.isScreenSharing,
          speaking: this.isSpeaking, quality: 'excellent', name: this.room?.localParticipant?.name || ''
        };
      }
      return null;
    }
    const camera = Array.from(participant.videoTrackPublications?.values?.() || []).some((pub) => pub.source === window.PulseLiveKit.Track.Source.Camera && !pub.isMuted);
    const screen = Array.from(participant.videoTrackPublications?.values?.() || []).some((pub) => pub.source === window.PulseLiveKit.Track.Source.ScreenShare && !pub.isMuted);
    return {
      muted: participant.isMicrophoneEnabled === false,
      camera,
      screen,
      speaking: this.speakingIdentities.has(identity) || Boolean(participant.isSpeaking),
      quality: participant.connectionQuality || 'unknown',
      name: participant.name || ''
    };
  }
}

window.PulseWebRTCEngine = MahyarMediaEngine;
