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
}

const RTC_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export async function requestLiveMicrophone(): Promise<{
  stream: MediaStream | null;
  error?: string;
}> {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { stream: null, error: 'Microphone API unavailable in this browser' };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    return { stream };
  } catch (firstErr: any) {
    try {
      const fallback = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      return { stream: fallback };
    } catch (err: any) {
      const msg = String(err?.name || firstErr?.name || err?.message || 'Mic permission denied');
      return { stream: null, error: msg };
    }
  }
}

export function playStreamInAudioElement(
  audioEl: HTMLAudioElement | null,
  stream: MediaStream | null,
  speakerMuted: boolean
): void {
  if (!audioEl) return;
  audioEl.muted = speakerMuted;
  audioEl.volume = 1.0;
  if (stream && audioEl.srcObject !== stream) {
    audioEl.srcObject = stream;
  }
  if (stream) {
    const p = audioEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  }
}

export class LiveRtcPeer {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioSender: RTCRtpSender | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private micMuted = false;
  private destroyed = false;

  private readonly onStatus?: (status: LiveRtcConnectionStatus) => void;
  private readonly onRemoteAudio?: (stream: MediaStream) => void;
  private readonly onMessage?: (msg: LiveCastMessage) => void;

  constructor(opts: {
    onStatus?: (status: LiveRtcConnectionStatus) => void;
    onRemoteAudio?: (stream: MediaStream) => void;
    onMessage?: (msg: LiveCastMessage) => void;
  }) {
    this.onStatus = opts.onStatus;
    this.onRemoteAudio = opts.onRemoteAudio;
    this.onMessage = opts.onMessage;
  }

  public isDataOpen(): boolean {
    return Boolean(this.dc && this.dc.readyState === 'open');
  }

  public hasLocalMic(): boolean {
    return Boolean(this.localStream && this.localStream.getAudioTracks().length > 0);
  }

  public getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  public attachLocalStream(stream: MediaStream | null, initialMuted: boolean): void {
    this.localStream = stream;
    this.micMuted = initialMuted;
    const track = stream?.getAudioTracks()[0] || null;
    if (track) {
      track.enabled = !initialMuted;
    }
    if (this.audioSender) {
      this.audioSender.replaceTrack(track).catch(() => {});
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

  public sendMessage(msg: LiveCastMessage): boolean {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    // Drop non-critical video frame if SCTP send buffer backs up on slow mobile network
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
    const voiceConnected = (ice === 'connected' || ice === 'completed') && hasRemoteAudio;
    this.onStatus({
      ice,
      dataOpen,
      voiceConnected,
      hasRemoteAudio,
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
      if (this.destroyed) return;
      if (evt.track && evt.track.kind !== 'audio') return;
      const stream =
        (evt.streams && evt.streams[0]) ||
        (this.remoteStream ? this.remoteStream : new MediaStream([evt.track]));
      if (evt.track && !stream.getAudioTracks().includes(evt.track)) {
        try {
          stream.addTrack(evt.track);
        } catch {}
      }
      this.remoteStream = stream;
      evt.track.onunmute = () => this.emitStatus();
      this.onRemoteAudio?.(stream);
      this.emitStatus();
    };

    pc.ondatachannel = (evt) => {
      if (this.destroyed || !evt.channel) return;
      this.wireDataChannel(evt.channel);
    };

    return pc;
  }

  private waitForIceGathering(pc: RTCPeerConnection, maxWaitMs = 1100): Promise<void> {
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
        if (e.candidate.type === 'srflx' && !srflxGraceTimer) {
          srflxGraceTimer = setTimeout(done, 220);
        }
      };
      const hardTimeout = setTimeout(done, maxWaitMs);
      pc.addEventListener('icegatheringstatechange', onState);
      pc.addEventListener('icecandidate', onCand);
    });
  }

  public async createOfferPayload(seq: number): Promise<string> {
    if (this.destroyed) throw new Error('Peer destroyed');
    const pc = this.createPeerConnection();

    const dc = pc.createDataChannel('live-cast', { ordered: true });
    this.wireDataChannel(dc);

    const localTrack = this.localStream?.getAudioTracks()[0] || null;
    if (localTrack) {
      localTrack.enabled = !this.micMuted;
    }
    const transceiver = pc.addTransceiver('audio', {
      direction: 'sendrecv',
      ...(this.localStream ? { streams: [this.localStream] } : {}),
    });
    this.audioSender = transceiver.sender;
    if (localTrack) {
      await transceiver.sender.replaceTrack(localTrack).catch(() => {});
    }

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc, 1100);

    const sdp = pc.localDescription?.sdp || offer.sdp || '';
    this.emitStatus();
    return JSON.stringify({ type: 'offer', sdp, seq });
  }

  public async acceptOfferAndCreateAnswer(offerJson: string): Promise<string | null> {
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

    const localTrack = this.localStream?.getAudioTracks()[0] || null;
    if (localTrack) {
      localTrack.enabled = !this.micMuted;
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
    if (localTrack) {
      await audioTransceiver.sender.replaceTrack(localTrack).catch(() => {});
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
