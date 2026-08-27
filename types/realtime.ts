export interface RoomUser {
  id: string;
  name: string;
  color: string;
  isHost?: boolean;
}

export interface PlaybackState {
  playing: boolean;
  time: number;
  updatedAt: number;
  subOffset?: number;
  source?: MediaSource | null;
  queue?: QueueItem[];
  speed?: number;
}

export interface MediaSource {
  type: 'youtube' | 'ph' | 'hls' | 'direct' | 'embed';
  videoId?: string;
  url?: string;
  embedUrl?: string;
  title?: string;
  platform?: string;
}

export interface QueueItem {
  id: string;
  title: string;
  type: 'youtube' | 'ph' | 'hls' | 'direct';
  videoId?: string;
  url?: string;
  duration?: number;
  addedBy?: string;
  addedAt?: number;
}

export interface ChatMessage {
  id?: string;
  clientId?: string;
  system: boolean;
  sender?: string;
  senderSessionId?: string | null;
  name?: string;
  color?: string;
  text: string;
  gif?: boolean;
  title?: string;
  replyTo?: {
    id: string;
    name: string;
    color: string;
    text: string;
  } | null;
  at: number;
  pending?: boolean;
}

export interface KnockRequest {
  knockId: string;
  name: string;
  socketId: string;
  at?: number;
}

export interface UserRoom {
  code: string;
  title: string;
  ownerName: string;
  source?: MediaSource | null;
  lastActiveAt?: string | Date;
  liveCount?: number;
  isLive?: boolean;
}
