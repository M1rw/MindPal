/**
 * MindPal Core TypeScript Type Definitions
 * Derived from contracts/openapi.yaml
 */

export type ChatRole = 'user' | 'assistant' | 'system';

/** A saved chat session for history */
export interface ChatSession {
  id: string;
  title: string;
  titleLocked?: boolean;
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
  /** Quiet recap written after a live call. Not a clinical note. */
  kind?: 'voice_receipt';
  /** Wall-clock seconds of the finished live call. Used by the Call ended divider. */
  voice_used_s?: number;
  /** Live-turn save notice. Not stored in session history. */
  memoryReceipt?: MemoryReceipt | null;
}

/** Facts persisted from a turn — short display text only */
export interface MemoryReceiptItem {
  id: string;
  type: string;
  text: string;
}

export interface MemoryReceipt {
  saved: MemoryReceiptItem[];
  count: number;
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
  ws_url: string;
  model: string;
  voice_id: string;
  session_id: string;
  quota_remaining_s: number;
  setup_timeout_ms: number;
  hold_ms: number;
  session_limit_s?: number;
  /** Only present when a measured provider limit requires a socket restart. Default is no rotate. */
  provider_rotate_s?: number;
  setup: { setup: Record<string, unknown> };
}

export interface VoiceSummaryRequest {
  session_id: string;
  chat_session_id?: string;
  user_transcript?: string;
  ai_transcript?: string;
}

export interface VoiceSummaryResponse {
  skipped: boolean;
  reason?: string;
  summary?: string;
  message?: ChatMessage;
  memory?: MemoryReceipt;
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
  leaving?: boolean;
}

/** Streak data */
export type StreakSource = 'device' | 'account';

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
  week_active?: boolean[];
  last_active_date?: string | null;
}

export type WellnessValence = 'heavy' | 'mixed' | 'lighter';
export type WellnessSource = 'saved_memory_and_synced_chats' | 'this_device';

export interface WellnessActivityPoint {
  date: string;
  turn_count: number;
}

export interface WellnessMoodPoint {
  date: string;
  valence: WellnessValence;
  label: string;
  turn_count: number;
  snippet?: string | null;
}

export interface WellnessHighlight {
  date: string;
  label: string;
  valence?: WellnessValence | null;
  snippet?: string | null;
}

export interface WellnessTheme {
  id: string;
  label: string;
  mentions: number;
  last_seen?: string | null;
  snippet?: string | null;
  from_memory?: boolean;
}

export interface WellnessEvent {
  id: string;
  label: string;
  date?: string | null;
  snippet?: string | null;
  from_memory?: boolean;
}

export interface WellnessTimeline {
  source: WellnessSource | string;
  source_label: string;
  disclaimer: string;
  range: { start: string; end: string; days: number } | null;
  activity: WellnessActivityPoint[];
  mood_timeline: WellnessMoodPoint[];
  highlights: {
    heavier_day: WellnessHighlight | null;
    lighter_day: WellnessHighlight | null;
  };
  themes: WellnessTheme[];
  events: WellnessEvent[];
  crisis_note?: string | null;
  empty: boolean;
  empty_reason?: string | null;
}

/** Usage quota */
export interface UsageQuota {
  used: number;
  limit: number;
  resets_at: string;
  credits_5h?: number;
  limit_5h?: number;
  reset_5h_seconds?: number;
  credits_week?: number;
  limit_week?: number;
  reset_week_seconds?: number;
  scope?: 'account' | 'network';
}

/** Health / status */
export interface HealthStatus {
  status: 'ok' | 'degraded';
  version: string;
  environment: string;
}
