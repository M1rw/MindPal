import type {
  ChangelogResponse,
  UserPersonalization,
  UserUISettings,
} from '../../../types';

export interface SettingsTabContentProps {
  settings: UserUISettings;
  updateSettings: (partial: Partial<UserUISettings>) => void;
  onOpenMemory?: () => void;
}

export interface FeaturesSettingsTabProps {
  changelogData: ChangelogResponse | null;
  changelogLoading?: boolean;
  changelogError?: string | null;
  onOpenWhatsNew: () => void;
}

export interface DataControlsTabProps {
  signedIn: boolean;
  exporting: boolean;
  deleting: boolean;
  onExportData: () => void;
  onDeleteData: () => void;
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

export interface WellnessTabProps {
  onSignIn: () => void;
}

export type { ChangelogResponse, UserPersonalization, UserUISettings };
