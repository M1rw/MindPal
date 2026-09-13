import React from 'react';
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
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] text-[10px] font-medium text-gray-500 dark:text-gray-400 select-none border border-black/[0.04] dark:border-white/[0.06]"
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          isCloud ? 'bg-[#4140FD] dark:bg-[#6572F2]' : 'bg-emerald-500'
        }`}
      />
      {label}
    </span>
  );
};

