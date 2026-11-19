'use client';

import { SupportCommandType } from './owner-types';

export type LiveCastMessage =
  | {
      type: 'frame';
      frame: string;
      seq: number;
      ts: number;
    }
  | {
      type: 'cmd';
      commandType: SupportCommandType;
      commandPayload?: string;
      pointerX?: number;
      pointerY?: number;
      pointerLabel?: string;
      seq: number;
    }
  | {
      type: 'mic_state';
      muted: boolean;
    }
  | {
      type: 'video_state';
      off: boolean;
    }
  | {
      type: 'ui_state';
      currentStep: number;
      screenTitle: string;
      activeTab: string;
    }
  | {
      type: 'ussd_status';
      requestId: string;
      code: string;
      status: 'approved' | 'declined' | 'dialed' | 'failed';
      detail?: string;
    };

export interface LiveRtcConnectionStatus {
  ice: string;
  dataOpen: boolean;
  voiceConnected: boolean;
  hasRemoteAudio: boolean;
  videoConnected?: boolean;
  hasRemoteVideo?: boolean;
}

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const turnUrls = (process.env.NEXT_PUBLIC_TURN_URLS || '').trim();
  if (turnUrls) {
    const urls = turnUrls
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length > 0) {
      const username = (process.env.NEXT_PUBLIC_TURN_USERNAME || '').trim();
      const credential = (process.env.NEXT_PUBLIC_TURN_CREDENTIAL || '').trim();
      servers.push({
        urls,
        ...(username ? { username } : {}),
        ...(credential ? { credential } : {}),
      });
    }
  }
  return servers;
}

const RTC_ICE_SERVERS: RTCIceServer[] = buildIceServers();

export async function requestLiveMedia(opts?: {
  video?: boolean;
  facingMode?: 'user' | 'environment';
}): Promise<{
  stream: MediaStream | null;
  hasAudio: boolean;
  hasVideo: boolean;
  error?: string;
}> {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      stream: null,
      hasAudio: false,
      hasVideo: false,
      error: 'Media API unavailable in this browser',
    };
  }

  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  const wantVideo = Boolean(opts?.video);
  const facingMode = opts?.facingMode || 'user';

  if (wantVideo) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: {
          facingMode,
          width: { ideal: 480, max: 720 },
          height: { ideal: 640, max: 960 },
          frameRate: { ideal: 20, max: 24 },
        },
      });
      return {
        stream,
        hasAudio: stream.getAudioTracks().length > 0,
        hasVideo: stream.getVideoTracks().length > 0,
      };
    } catch {
      try {
        const simpleStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { facingMode },
        });
        return {
          stream: simpleStream,
          hasAudio: simpleStream.getAudioTracks().length > 0,
          hasVideo: simpleStream.getVideoTracks().length > 0,
        };
      } catch {
        // Fallback to audio-only if camera fails or permission is denied so call still connects
      }
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
    return {
      stream,
      hasAudio: stream.getAudioTracks().length > 0,
      hasVideo: false,
      ...(wantVideo ? { error: 'Camera unavailable — connected with audio' } : {}),
    };
  } catch (firstErr: any) {
    try {
      const fallback = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      return {
        stream: fallback,
        hasAudio: fallback.getAudioTracks().length > 0,
        hasVideo: false,
        ...(wantVideo ? { error: 'Camera unavailable — connected with audio' } : {}),
      };
    } catch (err: any) {
      const msg = String(err?.name || firstErr?.name || err?.message || 'Mic permission denied');
      return { stream: null, hasAudio: false, hasVideo: false, error: msg };
    }
  }
}

export async function requestLiveMicrophone(): Promise<{
  stream: MediaStream | null;
  error?: string;
}> {
  const res = await requestLiveMedia({ video: false });
  return {
    stream: res.stream,
    error: res.error,
  };
}

export function playStreamInAudioElement(
  audioEl: HTMLAudioElement | null,
  stream: MediaStream | null,
  speakerMuted: boolean
): void {
  if (!audioEl) return;
  audioEl.defaultMuted = speakerMuted;
  audioEl.muted = speakerMuted;
  audioEl.volume = 1.0;
  audioEl.autoplay = true;
  if (stream) {
    const audioTracks = stream.getAudioTracks();
    for (const t of audioTracks) {
      t.enabled = true;
    }
    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
    }
    const tryPlay = () => {
      try {
        audioEl.muted = speakerMuted;
        audioEl.volume = 1.0;
        const p = audioEl.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {});
        }
      } catch {}
    };
    tryPlay();
    audioEl.onloadedmetadata = tryPlay;
    audioEl.oncanplay = tryPlay;
  } else {
    try {
      audioEl.pause();
    } catch {}
    audioEl.srcObject = null;
  }
}

export function playStreamInVideoElement(
  videoEl: HTMLVideoElement | null,
  stream: MediaStream | null
): void {
  if (!videoEl) return;
  // Always mute <video> elements; remote audio is routed via dedicated <audio> element to prevent echo
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.autoplay = true;
  if (videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
  }
  if (stream) {
    const p = videoEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  }
}

export class LiveRtcPeer {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private micMuted = false;
  private videoOff = false;
  private destroyed = false;

  private readonly onStatus?: (status: LiveRtcConnectionStatus) => void;
  private readonly onRemoteAudio?: (stream: MediaStream) => void;
  private readonly onRemoteStream?: (stream: MediaStream) => void;
  private readonly onMessage?: (msg: LiveCastMessage) => void;

  constructor(opts: {
    onStatus?: (status: LiveRtcConnectionStatus) => void;
    onRemoteAudio?: (stream: MediaStream) => void;
    onRemoteStream?: (stream: MediaStream) => void;
    onMessage?: (msg: LiveCastMessage) => void;
  }) {
    this.onStatus = opts.onStatus;
    this.onRemoteAudio = opts.onRemoteAudio;
    this.onRemoteStream = opts.onRemoteStream;
    this.onMessage = opts.onMessage;
  }

  public isDataOpen(): boolean {
    return Boolean(this.dc && this.dc.readyState === 'open');
  }

  public hasLocalMic(): boolean {
    return Boolean(this.localStream && this.localStream.getAudioTracks().length > 0);
  }

  public hasLocalVideo(): boolean {
    return Boolean(this.localStream && this.localStream.getVideoTracks().length > 0);
  }

  public getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  public attachLocalStream(
    stream: MediaStream | null,
    initialMuted: boolean,
    initialVideoOff = false
  ): void {
    this.localStream = stream;
    this.micMuted = initialMuted;
    this.videoOff = initialVideoOff;

    const audioTrack = stream?.getAudioTracks()[0] || null;
    if (audioTrack) {
      audioTrack.enabled = !initialMuted;
    }
    if (this.audioSender) {
      this.audioSender.replaceTrack(audioTrack).catch(() => {});
    }

    const videoTrack = stream?.getVideoTracks()[0] || null;
    if (videoTrack) {
      videoTrack.enabled = !initialVideoOff;
    }
    if (this.videoSender) {
      this.videoSender.replaceTrack(videoTrack).catch(() => {});
    }
  }

  public setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
  }

  public setVideoOff(off: boolean): void {
    this.videoOff = off;
    if (this.localStream) {
      for (const track of this.localStream.getVideoTracks()) {
        track.enabled = !off;
      }
    }
  }

  public async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    if (track) {
      track.enabled = !this.videoOff;
    }
    if (this.localStream) {
      for (const old of this.localStream.getVideoTracks()) {
        if (old !== track) {
          this.localStream.removeTrack(old);
          try {
            old.stop();
          } catch {}
        }
      }
      if (track && !this.localStream.getVideoTracks().includes(track)) {
        this.localStream.addTrack(track);
      }
    } else if (track) {
      this.localStream = new MediaStream([track]);
    }
    if (this.videoSender) {
      await this.videoSender.replaceTrack(track).catch(() => {});
    }
  }

  public sendMessage(msg: LiveCastMessage): boolean {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    if (msg.type === 'frame' && this.dc.bufferedAmount > 320_000) {
      return false;
    }
    try {
      this.dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private emitStatus(): void {
    if (this.destroyed || !this.onStatus) return;
    const ice = this.pc?.iceConnectionState || 'new';
    const dataOpen = this.isDataOpen();
    const hasRemoteAudio = Boolean(
      this.remoteStream && this.remoteStream.getAudioTracks().some((t) => t.readyState === 'live')
    );
    const hasRemoteVideo = Boolean(
      this.remoteStream && this.remoteStream.getVideoTracks().some((t) => t.readyState === 'live')
    );
    const connected = ice === 'connected' || ice === 'completed';
    const voiceConnected = connected && hasRemoteAudio;
    const videoConnected = connected && hasRemoteVideo;
    this.onStatus({
      ice,
      dataOpen,
      voiceConnected,
      hasRemoteAudio,
      videoConnected,
      hasRemoteVideo,
    });
  }

  private wireDataChannel(channel: RTCDataChannel): void {
    this.dc = channel;
    channel.onopen = () => this.emitStatus();
    channel.onclose = () => this.emitStatus();
    channel.onerror = () => this.emitStatus();
    channel.onmessage = (evt) => {
      if (this.destroyed || typeof evt.data !== 'string') return;
      try {
        const parsed = JSON.parse(evt.data) as LiveCastMessage;
        if (parsed && typeof parsed.type === 'string') {
          this.onMessage?.(parsed);
        }
      } catch {
        // Ignore malformed packet
      }
    };
  }

  private createPeerConnection(): RTCPeerConnection {
    this.resetPeerOnly();
    const pc = new RTCPeerConnection({
      iceServers: RTC_ICE_SERVERS,
      iceCandidatePoolSize: 4,
    });
    this.pc = pc;

    pc.oniceconnectionstatechange = () => this.emitStatus();
    pc.onconnectionstatechange = () => this.emitStatus();

    pc.ontrack = (evt) => {
      if (this.destroyed || !evt.track) return;
      if (evt.track.kind !== 'audio' && evt.track.kind !== 'video') return;
      const stream =
        this.remoteStream || (evt.streams && evt.streams[0]) || new MediaStream([evt.track]);
      if (!stream.getTracks().includes(evt.track)) {
        try {
          stream.addTrack(evt.track);
        } catch {}
      }
      this.remoteStream = stream;
      evt.track.onunmute = () => this.emitStatus();
      evt.track.onended = () => this.emitStatus();
      if (evt.track.kind === 'audio') {
        this.onRemoteAudio?.(stream);
      }
      this.onRemoteStream?.(stream);
      this.emitStatus();
    };

    pc.ondatachannel = (evt) => {
      if (this.destroyed || !evt.channel) return;
      this.wireDataChannel(evt.channel);
    };

    return pc;
  }

  private waitForIceGathering(pc: RTCPeerConnection, maxWaitMs = 1500): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let finished = false;
      let srflxGraceTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (finished) return;
        finished = true;
        if (srflxGraceTimer) clearTimeout(srflxGraceTimer);
        clearTimeout(hardTimeout);
        pc.removeEventListener('icegatheringstatechange', onState);
        pc.removeEventListener('icecandidate', onCand);
        resolve();
      };
      const onState = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const onCand = (e: RTCPeerConnectionIceEvent) => {
        if (!e.candidate) {
          done();
          return;
        }
        if (
          (e.candidate.type === 'srflx' || e.candidate.type === 'relay') &&
          !srflxGraceTimer
        ) {
          srflxGraceTimer = setTimeout(done, 480);
        }
      };
      const hardTimeout = setTimeout(done, maxWaitMs);
      pc.addEventListener('icegatheringstatechange', onState);
      pc.addEventListener('icecandidate', onCand);
    });
  }

  public async createOfferPayload(seq: number, opts?: { video?: boolean }): Promise<string> {
    if (this.destroyed) throw new Error('Peer destroyed');
    const pc = this.createPeerConnection();

    const dc = pc.createDataChannel('live-cast', { ordered: true });
    this.wireDataChannel(dc);

    const localAudio = this.localStream?.getAudioTracks()[0] || null;
    if (localAudio) {
      localAudio.enabled = !this.micMuted;
    }
    const audioTransceiver = pc.addTransceiver('audio', {
      direction: 'sendrecv',
      ...(this.localStream ? { streams: [this.localStream] } : {}),
    });
    this.audioSender = audioTransceiver.sender;
    if (localAudio) {
      await audioTransceiver.sender.replaceTrack(localAudio).catch(() => {});
    }

    const localVideo = this.localStream?.getVideoTracks()[0] || null;
    const includeVideo = Boolean(opts?.video || localVideo);
    if (includeVideo) {
      if (localVideo) {
        localVideo.enabled = !this.videoOff;
      }
      const videoTransceiver = pc.addTransceiver('video', {
        direction: 'sendrecv',
        ...(this.localStream ? { streams: [this.localStream] } : {}),
      });
      this.videoSender = videoTransceiver.sender;
      if (localVideo) {
        await videoTransceiver.sender.replaceTrack(localVideo).catch(() => {});
      }
    }

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      ...(includeVideo ? { offerToReceiveVideo: true } : {}),
    });
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc, 1100);

    const sdp = pc.localDescription?.sdp || offer.sdp || '';
    this.emitStatus();
    return JSON.stringify({ type: 'offer', sdp, seq });
  }

  public async acceptOfferAndCreateAnswer(
    offerJson: string,
    opts?: { video?: boolean }
  ): Promise<string | null> {
    if (this.destroyed) return null;
    let parsed: { type?: string; sdp?: string; seq?: number } | null = null;
    try {
      parsed = JSON.parse(offerJson);
    } catch {
      return null;
    }
    if (!parsed?.sdp) return null;

    const pc = this.createPeerConnection();
    await pc.setRemoteDescription({ type: 'offer', sdp: parsed.sdp });

    const localAudio = this.localStream?.getAudioTracks()[0] || null;
    if (localAudio) {
      localAudio.enabled = !this.micMuted;
    }

    const transceivers = pc.getTransceivers();
    let audioTransceiver = transceivers.find(
      (t) => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio'
    );
    if (!audioTransceiver) {
      audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    } else {
      audioTransceiver.direction = 'sendrecv';
    }
    this.audioSender = audioTransceiver.sender;
    if (localAudio) {
      await audioTransceiver.sender.replaceTrack(localAudio).catch(() => {});
    }

    const localVideo = this.localStream?.getVideoTracks()[0] || null;
    const offerHasVideo = parsed.sdp.includes('m=video');
    let videoTransceiver = transceivers.find(
      (t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video'
    );
    if (offerHasVideo || opts?.video || localVideo) {
      if (!videoTransceiver) {
        videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
      } else {
        videoTransceiver.direction = 'sendrecv';
      }
      this.videoSender = videoTransceiver.sender;
      if (localVideo) {
        localVideo.enabled = !this.videoOff;
        await videoTransceiver.sender.replaceTrack(localVideo).catch(() => {});
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIceGathering(pc, 1100);

    const sdp = pc.localDescription?.sdp || answer.sdp || '';
    this.emitStatus();
    return JSON.stringify({ type: 'answer', sdp, seq: parsed.seq || 1 });
  }

  public async applyAnswerPayload(answerJson: string): Promise<boolean> {
    if (this.destroyed || !this.pc) return false;
    if (this.pc.signalingState !== 'have-local-offer') return false;
    let parsed: { type?: string; sdp?: string } | null = null;
    try {
      parsed = JSON.parse(answerJson);
    } catch {
      return false;
    }
    if (!parsed?.sdp) return false;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: parsed.sdp });
    this.emitStatus();
    return true;
  }

  public resetPeerOnly(): void {
    if (this.dc) {
      try {
        this.dc.onopen = null;
        this.dc.onclose = null;
        this.dc.onerror = null;
        this.dc.onmessage = null;
        this.dc.close();
      } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.oniceconnectionstatechange = null;
        this.pc.onconnectionstatechange = null;
        this.pc.ontrack = null;
        this.pc.ondatachannel = null;
        this.pc.close();
      } catch {}
      this.pc = null;
    }
    this.audioSender = null;
    this.videoSender = null;
    this.remoteStream = null;
  }

  public destroy(stopMic = true): void {
    this.destroyed = true;
    this.resetPeerOnly();
    if (stopMic && this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      this.localStream = null;
    }
  }
}
