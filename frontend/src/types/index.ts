/**
 * MindPal Core TypeScript Type Definitions
 * Derived from contracts/openapi.yaml
 */

export type ChatRole = 'user' | 'assistant' | 'system';

/** A saved chat session for history */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: string; // ISO string
  updatedAt: string;
  messages: ChatMessage[];
}

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

export interface ChangelogEntry {
  version: string;
  released_at?: string;
  major?: boolean;
  title: string;
  summary: string;
  highlights: string[];
}

export interface ChangelogResponse {
  product: string;
  current_version: string;
  entries: ChangelogEntry[];
  dismissed_versions?: string[];
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
  voiceModel: string;
  voiceLanguage: string;
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

/** Firebase Auth User shape (subset) */
export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
}

/** Toast notification */
export type ToastKind = 'info' | 'success' | 'error' | 'warning';
export interface ToastItem {
  id: string;
  message: string;
  kind: ToastKind;
}

/** Streak data */
export interface StreakData {
  count: number;
  lastActiveDate: string | null;
  weeklyDays: boolean[]; // 7 booleans, Mon–Sun
}

/** Model option */
export interface ModelOption {
  id: string;
  name: string;
  label: string;
  desc: string;
  badge?: string;
  badgeColor?: string;
  quota?: string;
}

/** Listening mode option */
export interface ModeOption {
  id: string;
  label: string;
}

/** Feature flags snapshot */
export interface FeatureSnapshot {
  voice_enabled: boolean;
  presence_enabled?: boolean;
  pro_model_enabled: boolean;
  memory_enabled: boolean;
  changelog_enabled: boolean;
  clinical_guidance?: boolean;
  analytics_insights?: boolean;
}

/** User identity / profile */
export interface UserProfile {
  user_id: string;
  display_name: string | null;
  email: string | null;
  photo_url: string | null;
  created_at: string;
}

export interface UserInsightsResponse {
  user_id_hash?: string;
  reflection_streak_days: number;
  total_reflections: number;
  clinical_scores?: {
    phq9?: number;
    gad7?: number;
    [key: string]: number | string | undefined;
  };
}

/** Usage quota */
export interface UsageQuota {
  used: number;
  limit: number;
  resets_at: string;
}

/** Health / status */
export interface HealthStatus {
  status: 'ok' | 'degraded';
  version: string;
  environment: string;
}
