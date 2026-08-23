'use client';

import { Room, RoomEvent, createLocalAudioTrack } from 'livekit-client';

// One voice session per room visit. Wraps the LiveKit room:
// connect, publish mic, hear everyone else, toggle mute, leave.
export class VoiceSession {
  constructor() {
    this.room = null;
    this.micTrack = null;
    this.micOn = false;
  }

  get joined() {
    return !!this.room;
  }

  async join({ url, token, onSpeakers, onRemoteAudio }) {
    this.room = new Room();

    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      onSpeakers(speakers.map((s) => s.identity));
    });
    this.room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'audio') onRemoteAudio(track);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === 'audio') track.detach().forEach((el) => el.remove());
    });

    // listen-first: connect and hear everyone immediately, no mic permission yet
    await this.room.connect(url, token);
    this.micOn = false;
  }

  // mic track is created lazily on the first unmute — that's also when the
  // browser asks for mic permission, never before
  async enableMic(on) {
    if (on) {
      if (!this.micTrack) {
        // echoCancellation matters most: the movie is playing out loud nearby
        this.micTrack = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
        });
        await this.room.localParticipant.publishTrack(this.micTrack);
      } else {
        await this.micTrack.unmute();
      }
      this.micOn = true;
    } else if (this.micTrack) {
      await this.micTrack.mute();
      this.micOn = false;
    }
    return this.micOn;
  }

  async leave() {
    try {
      if (this.room) await this.room.disconnect();
    } catch { /* already gone */ }
    this.room = null;
    this.micTrack = null;
    this.micOn = false;
  }
}
