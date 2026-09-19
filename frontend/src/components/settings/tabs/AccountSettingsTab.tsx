import React from 'react';
import { SettingsHeader, SettingsRow, settingsDangerButtonClass, settingsPrimaryButtonClass } from '../SettingsPrimitives';
import type { AccountTabProps } from './types';

export const AccountSettingsTab: React.FC<AccountTabProps> = ({ user, onSignOut, onSignIn }) => (
  <div className="space-y-8">
    <SettingsHeader
      title="Account"
      description="Sign in on this device. Internal account IDs are not shown here."
    />

    {user ? (
      <div>
        <div className="flex items-center gap-4 py-3.5 border-b border-edge-subtle">
          {user.photoURL ? (
            <img
              src={user.photoURL}
              alt=""
              className="w-14 h-14 rounded-full border border-edge-default object-cover"
            />
          ) : (
            <div className="w-14 h-14 rounded-full border border-edge-subtle text-content-primary flex items-center justify-center font-semibold text-xl">
              {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-content-primary truncate">
              {user.displayName || 'Signed in'}
            </h3>
            <p className="text-sm text-content-secondary truncate mt-0.5">
              {user.email || 'No email on this account'}
            </p>
          </div>
        </div>
        <SettingsRow
          label="Sign out"
          description="Ends the signed-in session on this device. Local chat history stays here."
          danger
          last
        >
          <button type="button" onClick={onSignOut} className={settingsDangerButtonClass}>
            Sign out
          </button>
        </SettingsRow>
      </div>
    ) : (
      <SettingsRow
        label="Browsing as a guest"
        description="Conversations and saved memory facts stay on this device. Sign in to attach an account; memory then merges into that account and cloud history sync is attempted."
        last
      >
        <button type="button" onClick={onSignIn} className={settingsPrimaryButtonClass}>
          Sign in
        </button>
      </SettingsRow>
    )}
  </div>
);
