import React from 'react';

export const EnvTag: React.FC = () => {
  const getEnvLabel = (): string => {
    if (typeof window === 'undefined') return 'Local';
    const configEnv = (window as any).MINDPAL_CONFIG?.APP_ENV;
    if (configEnv) {
      if (configEnv === 'production') return 'Production';
      if (configEnv === 'preview') return 'Preview';
      return configEnv;
    }
    const host = window.location.hostname;
    if (host.includes('vercel.app')) {
      return host.includes('-git-') || host.includes('preview') ? 'Preview' : 'Production';
    }
    if (host === 'localhost' || host === '127.0.0.1') return 'Local';
    return 'Local';
  };

  const label = getEnvLabel();

  return (
    <span
      id="env-tag"
      className="px-2 py-0.5 rounded-md bg-gemini-surface dark:bg-gemini-darkSurface text-[10px] font-medium text-gray-500 dark:text-gray-400 transition-colors select-none"
    >
      {label}
    </span>
  );
};
