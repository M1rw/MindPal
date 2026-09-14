import React from 'react';
import { Cloud, Laptop } from 'lucide-react';
import { getAppConfig } from '../../services/config';

export const EnvTag: React.FC = () => {
  const getEnvLabel = (): 'Cloud' | 'Local' => {
    if (typeof window === 'undefined') return 'Local';
    const configEnv = getAppConfig().ENVIRONMENT;
    if (configEnv) {
      if (configEnv === 'production' || configEnv === 'preview') return 'Cloud';
      if (configEnv === 'local') return 'Local';
    }
    const host = window.location.hostname;
    if (host.includes('vercel.app') || (host && host !== 'localhost' && host !== '127.0.0.1')) {
      return 'Cloud';
    }
    return 'Local';
  };

  const label = getEnvLabel();
  const isCloud = label === 'Cloud';

  return (
    <span
      id="env-tag"
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-surface-subtle text-2xs font-medium text-content-secondary transition-colors select-none border border-edge-subtle"
    >
      {isCloud ? (
        <Cloud className="w-3 h-3 text-brand-primary" />
      ) : (
        <Laptop className="w-3 h-3 text-emerald-500" />
      )}
      <span>{label}</span>
    </span>
  );
};


