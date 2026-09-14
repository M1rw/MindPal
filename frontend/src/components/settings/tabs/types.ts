import type { ChangelogResponse, UserInsightsResponse, UserPersonalization, UserUISettings } from '../../../types';

export interface SettingsTabContentProps {
  settings: UserUISettings;
  updateSettings: (partial: Partial<UserUISettings>) => void;
  onOpenMemory?: () => void;
}

export interface FeaturesSettingsTabProps {
  changelogData: ChangelogResponse | null;
  onOpenWhatsNew: () => void;
}

export interface DataControlsTabProps {
  exporting: boolean;
  onExportData: () => void;
  onDeleteData: () => void;
}

export interface InsightsTabProps {
  insights: UserInsightsResponse | null;
  loading?: boolean;
  error?: string | null;
}

export interface AccountTabProps {
  user: {
    uid: string;
    displayName?: string | null;
    email?: string | null;
    photoURL?: string | null;
  } | null;
  onSignOut: () => void;
  onSignIn: () => void;
}

export type { ChangelogResponse, UserInsightsResponse, UserPersonalization, UserUISettings };
