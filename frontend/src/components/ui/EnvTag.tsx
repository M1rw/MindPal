import React from 'react';
import { Cloud, Laptop } from 'lucide-react';
import { useIsSignedIn } from '../../hooks/session/useAccountStatus.ts';

export const EnvTag: React.FC = () => {
  const isAuthenticated = useIsSignedIn();

  if (isAuthenticated) {
    return (
      <span
        id="env-tag"
        title="Signed in. Memory and chat history can follow your account."
        aria-label="Account"
        className="inline-flex items-center text-content-muted"
      >
        <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      id="env-tag"
      title="This device. Conversations and saved facts stay here until you sign in."
      aria-label="This device"
      className="inline-flex items-center text-content-muted"
    >
      <Laptop className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
};
