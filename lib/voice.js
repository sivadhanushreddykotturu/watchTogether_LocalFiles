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

    await this.room.connect(url, token);

    // echoCancellation matters most: the movie is playing out loud nearby
    this.micTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
    });
    await this.room.localParticipant.publishTrack(this.micTrack);
    this.micOn = true;
  }

  async toggleMic() {
    if (!this.micTrack) return this.micOn;
    this.micOn = !this.micOn;
    if (this.micOn) await this.micTrack.unmute();
    else await this.micTrack.mute();
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
