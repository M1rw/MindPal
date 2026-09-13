/**
 * MindPal Core TypeScript Type Definitions
 * Derived from contracts/openapi.yaml
 */

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  created_at?: string;
  strategy_used?: string;
  model?: string;
}

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
  session_id?: string;
  stream?: boolean;
}

export interface MemoryAtom {
  id: string;
  type: string;
  value: string;
  normalized_value?: string;
  confidence: number;
  created_at: string;
  updated_at?: string;
}

export interface MemorySummaryResponse {
  summary: string;
  updated_at: string;
  language: string;
  atoms_count: number;
}

export interface MemorySummaryUpdate {
  summary: string;
}

export interface FeatureChangelogItem {
  version: string;
  title: string;
  date: string;
  changes: string[];
}

export interface UserPersonalization {
  baseStyle: 'concise' | 'detailed' | 'balanced';
  warmth: 'warm' | 'neutral' | 'direct';
  useHeadersLists: boolean;
  emojiSupport: boolean;
}

export interface UserUISettings {
  theme: 'light' | 'dark' | 'system';
  soundEnabled: boolean;
  personalization: UserPersonalization;
}

export interface VoiceTokenResponse {
  token: string;
  expires_at: string;
  ws_url?: string;
}

export interface VoiceSummaryRequest {
  user_transcript: string;
  ai_transcript: string;
}

export interface VoiceSummaryResponse {
  summary: string;
  key_takeaways: string[];
  action_items?: string[];
}
