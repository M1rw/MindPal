import React from 'react';
import { SettingsBlock, SettingsHeader } from '../SettingsPrimitives';

export const SecuritySettingsTab: React.FC = () => (
  <div className="space-y-8">
    <SettingsHeader
      title="Security"
      description="What this browser stores, and what stays in memory for the current session."
    />

    <div>
      <SettingsBlock title="Sign-in on this device">
        <p>
          Sign-in tokens used for API calls are held in memory for the current tab session. MindPal
          does not write those tokens to localStorage. After you sign in, the browser may still keep
          a session so you stay signed in after a refresh.
        </p>
        <p>
          Account data lives on MindPal’s servers. This is not end-to-end encryption, and it is not a
          privacy guarantee.
        </p>
      </SettingsBlock>
      <SettingsBlock title="Stored in this browser">
        <ul className="list-disc pl-5 space-y-1">
          <li>Theme and settings, including personalization</li>
          <li>Chat history for this browser</li>
          <li>Saved memory facts while signed out (this device only)</li>
          <li>Streak and greeting cache</li>
          <li>Last sign-in method</li>
        </ul>
      </SettingsBlock>
      <SettingsBlock title="Requests and safety" last>
        <p>
          When request integrity checking is configured, a token is sent with requests. Crisis-related
          messages can trigger a safety reply. That is not end-to-end encryption and not clinical
          monitoring of every message.
        </p>
      </SettingsBlock>
    </div>
  </div>
);
