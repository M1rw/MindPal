import React from 'react';
import {
  SettingsHeader,
  SettingsRow,
  settingsDangerButtonClass,
  settingsGhostButtonClass,
} from '../SettingsPrimitives';
import type { DataControlsTabProps } from './types';
import { useLibraryStore } from '../../../store/library.ts';
import { useSettingsStore } from '../../../store';

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
        label="Library"
        description={
          signedIn
            ? 'Images and PDFs you shared, kept with your account (up to 100 files, 200 MB). Open it to find, rename or delete them.'
            : 'Images and PDFs you shared are kept on this device for 7 days (up to 10). Sign in to keep them with your account.'
        }
      >
        <button
          type="button"
          onClick={() => {
            useSettingsStore.getState().setIsOpen(false);
            useLibraryStore.getState().open();
          }}
          className={settingsGhostButtonClass}
        >
          Open
        </button>
      </SettingsRow>
      <SettingsRow
        label="Download my data"
        description={
          signedIn
            ? 'Saves a JSON file with your account profile, saved memory, chats synced to the server, and what MindPal read from your library files (download the files themselves from the library). History and guest facts that only exist in this browser are not included.'
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
            ? 'Permanently deletes your server profile, saved memory, synced chats, and library files. Chat history and guest facts stored in this browser are not removed.'
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
