import React from 'react';
import {
  SettingsHeader,
  SettingsRow,
  settingsDangerButtonClass,
  settingsGhostButtonClass,
} from '../SettingsPrimitives';
import type { DataControlsTabProps } from './types';

export const DataControlsSettingsTab: React.FC<DataControlsTabProps> = ({
  signedIn,
  exporting,
  deleting,
  onExportData,
  onDeleteData,
}) => (
  <div className="space-y-8">
    <SettingsHeader
      title="Data controls"
      description="Download or delete what MindPal stores for your signed-in account. Chat on this device is separate."
    />

    <div>
      <SettingsRow
        label="Download my data"
        description={
          signedIn
            ? 'Saves a JSON file with your account profile, saved memory, and chats synced to the server. History and guest facts that only exist in this browser are not included.'
            : 'Sign in to download the profile, memory, and synced chats stored with your account. Guest facts on this device are not a server export.'
        }
      >
        <button
          type="button"
          disabled={!signedIn || exporting}
          onClick={onExportData}
          className={settingsGhostButtonClass}
        >
          {exporting ? 'Downloading…' : 'Download'}
        </button>
      </SettingsRow>
      <SettingsRow
        label="Delete server data"
        description={
          signedIn
            ? 'Permanently deletes your server profile, saved memory, and synced chats. Chat history and guest facts stored in this browser are not removed.'
            : 'Sign in to permanently delete the server profile, memory, and synced chats for this account. Local chat history stays on this device.'
        }
        danger
        last
      >
        <button
          type="button"
          disabled={!signedIn || deleting}
          onClick={onDeleteData}
          className={settingsDangerButtonClass}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </SettingsRow>
    </div>
  </div>
);
