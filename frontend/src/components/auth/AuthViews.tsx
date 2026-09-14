import React from 'react';
import { ArrowLeft, Eye, EyeOff, Loader2 } from 'lucide-react';

interface AuthChoiceViewProps {
  loading: boolean;
  lastUsed: string | null;
  onGoogle: () => void;
  onApple: () => void;
  onPhone: () => void;
  onEmail: () => void;
}

interface AuthProviderButtonProps {
  label: string;
  onClick: () => void;
  loading: boolean;
  lastUsed?: boolean;
  icon: React.ReactNode;
  accentClassName?: string;
}

const AuthProviderButton: React.FC<AuthProviderButtonProps> = ({
  label,
  onClick,
  loading,
  lastUsed,
  icon,
  accentClassName,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={loading}
    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-all text-sm font-medium text-gray-800 dark:text-gray-200 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none ${accentClassName ?? ''}`}
  >
    <div className="flex items-center gap-3">
      {icon}
      <span>{label}</span>
    </div>
    {lastUsed && (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9]">
        Last used
      </span>
    )}
  </button>
);

export const AuthChoiceView: React.FC<AuthChoiceViewProps> = ({
  loading,
  lastUsed,
  onGoogle,
  onApple,
  onPhone,
  onEmail,
}) => (
  <div className="mt-5 space-y-2.5">
    <AuthProviderButton
      label="Continue with Google"
      onClick={onGoogle}
      loading={loading}
      lastUsed={lastUsed === 'google'}
      icon={
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M21.35 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.24a4.48 4.48 0 0 1-1.94 2.94v2.52h3.15c1.84-1.69 2.9-4.18 2.9-7.29Z" />
          <path fill="#34A853" d="M12 21.75c2.62 0 4.82-.87 6.43-2.36l-3.15-2.52c-.87.58-1.99.92-3.28.92-2.53 0-4.67-1.71-5.44-4.01H3.31v2.6 A9.72 9.72 0 0 0 12 21.75Z" />
          <path fill="#FBBC05" d="M6.56 13.78A5.85 5.85 0 0 1 6.26 12c0-.62.11-1.22.3-1.78v-2.6H3.31A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.05 1.06 4.38l3.25-2.6Z" />
          <path fill="#EA4335" d="M12 6.21c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.81 3.28 14.61 2.25 12 2.25a9.72 9.72 0 0 0-8.69 5.37l3.25 2.6c.77-2.3 2.91-4.01 5.44-4.01Z" />
        </svg>
      }
    />

    <AuthProviderButton
      label="Continue with Apple"
      onClick={onApple}
      loading={loading}
      lastUsed={lastUsed === 'apple'}
      icon={
        <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
          <path d="M17.05 12.54c-.03-2.37 1.94-3.53 2.03-3.59-1.11-1.62-2.83-1.84-3.44-1.86-1.45-.15-2.86.87-3.6.87-.75 0-1.88-.85-3.11-.82-1.59.02-3.08.95-3.9 2.39-1.7 2.94-.43 7.26 1.2 9.64.81 1.16 1.75 2.45 2.98 2.4 1.2-.05 1.65-.76 3.1-.76 1.44 0 1.85.76 3.11.73 1.29-.02 2.1-1.16 2.88-2.33.94-1.33 1.32-2.65 1.34-2.71-.03-.01-2.65-1.01-2.69-4.03ZM14.68 5.54c.65-.81 1.1-1.91.98-3.03-.94.04-2.12.65-2.8 1.44-.6.69-1.14 1.84-1.01 2.92 1.06.08 2.15-.53 2.83-1.33Z" />
        </svg>
      }
    />

    <AuthProviderButton
      label="Continue with Phone"
      onClick={onPhone}
      loading={loading}
      lastUsed={lastUsed === 'phone'}
      icon={
        <svg className="w-5 h-5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="6.5" y="2.75" width="11" height="18.5" rx="2.1" />
          <path d="M10 18.1h4" />
        </svg>
      }
    />

    <div className="relative py-2 flex items-center justify-center">
      <div className="w-full border-t border-zinc-200 dark:border-zinc-800" />
      <span className="absolute bg-white dark:bg-[#18181B] px-3 text-[11px] text-zinc-400 uppercase">
        or
      </span>
    </div>

    <AuthProviderButton
      label="Continue with Email"
      onClick={onEmail}
      loading={loading}
      lastUsed={lastUsed === 'email'}
      icon={
        <svg className="w-5 h-5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3.25" y="5.25" width="17.5" height="13.5" rx="2" />
          <path d="m4.75 7 7.25 5.6L19.25 7" />
        </svg>
      }
    />

    <p className="text-[11px] text-center text-gray-400 dark:text-gray-500 pt-2">
      By continuing, you agree to MindPal’s{' '}
      <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600 dark:hover:text-gray-300">
        Privacy Policy
      </a>{' '}
      and{' '}
      <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600 dark:hover:text-gray-300">
        Terms
      </a>.
    </p>
  </div>
);

interface AuthEmailViewProps {
  loading: boolean;
  email: string;
  password: string;
  showPassword: boolean;
  isRegisterMode: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onTogglePasswordVisibility: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
  onToggleMode: () => void;
  onForgotPassword: () => void;
}

export const AuthEmailView: React.FC<AuthEmailViewProps> = ({
  loading,
  email,
  password,
  showPassword,
  isRegisterMode,
  onEmailChange,
  onPasswordChange,
  onTogglePasswordVisibility,
  onSubmit,
  onBack,
  onToggleMode,
  onForgotPassword,
}) => (
  <form onSubmit={onSubmit} className="mt-5 space-y-4">
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1.5 text-xs text-[#4140FD] dark:text-[#A39CF9] hover:underline"
    >
      <ArrowLeft className="w-3.5 h-3.5" /> All sign-in methods
    </button>

    <div>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {isRegisterMode ? 'Create an account' : 'Continue with email'}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        {isRegisterMode
          ? 'Set up a password to back up your reflections.'
          : 'Use your MindPal email and password to sign in.'}
      </p>
    </div>

    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          Email
        </label>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="you@example.com"
          className="w-full px-3.5 py-2.5 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          Password
        </label>
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            required
            minLength={6}
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="At least 6 characters"
            className="w-full px-3.5 py-2.5 pr-10 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={onTogglePasswordVisibility}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Toggle password visibility"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>

    <button
      type="submit"
      disabled={loading}
      className="w-full py-3 rounded-xl bg-[#4140FD] hover:bg-[#5251fd] text-white font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99]"
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      <span>{isRegisterMode ? 'Create account' : 'Sign in'}</span>
    </button>

    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 pt-1">
      <button
        type="button"
        onClick={onToggleMode}
        className="hover:underline text-[#4140FD] dark:text-[#A39CF9] font-medium"
      >
        {isRegisterMode ? 'Already have an account? Sign in' : 'Create an account'}
      </button>
      {!isRegisterMode && (
        <button type="button" onClick={onForgotPassword} className="hover:underline">
          Forgot password?
        </button>
      )}
    </div>
  </form>
);

interface AuthPhoneViewProps {
  loading: boolean;
  phoneNumber: string;
  onPhoneNumberChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}

export const AuthPhoneView: React.FC<AuthPhoneViewProps> = ({
  loading,
  phoneNumber,
  onPhoneNumberChange,
  onSubmit,
  onBack,
}) => (
  <form onSubmit={onSubmit} className="mt-5 space-y-4">
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1.5 text-xs text-[#4140FD] dark:text-[#A39CF9] hover:underline"
    >
      <ArrowLeft className="w-3.5 h-3.5" /> All sign-in methods
    </button>

    <div>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        Continue with phone
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        We’ll send a one-time verification code by SMS.
      </p>
    </div>

    <div>
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
        Mobile number
      </label>
      <input
        type="tel"
        required
        value={phoneNumber}
        onChange={(event) => onPhoneNumberChange(event.target.value)}
        placeholder="+20 10 1234 5678"
        className="w-full px-3.5 py-2.5 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#4140FD]"
      />
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
        Include your country code, for example <strong>+1</strong> or <strong>+20</strong>.
      </p>
    </div>

    <button
      type="submit"
      disabled={loading || !phoneNumber}
      className="w-full py-3 rounded-xl bg-[#4140FD] hover:bg-[#5251fd] text-white font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99]"
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      <span>Send verification code</span>
    </button>
  </form>
);

interface AuthPhoneCodeViewProps {
  loading: boolean;
  phoneNumber: string;
  phoneCode: string;
  onPhoneCodeChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}

export const AuthPhoneCodeView: React.FC<AuthPhoneCodeViewProps> = ({
  loading,
  phoneNumber,
  phoneCode,
  onPhoneCodeChange,
  onSubmit,
  onBack,
}) => (
  <form onSubmit={onSubmit} className="mt-5 space-y-4">
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1.5 text-xs text-[#4140FD] dark:text-[#A39CF9] hover:underline"
    >
      <ArrowLeft className="w-3.5 h-3.5" /> Change number
    </button>

    <div>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        Enter your code
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        Enter the 6-digit code sent to {phoneNumber}.
      </p>
    </div>

    <div>
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
        Verification code
      </label>
      <input
        type="text"
        required
        maxLength={6}
        value={phoneCode}
        onChange={(event) => onPhoneCodeChange(event.target.value.replace(/\D/g, ''))}
        placeholder="123456"
        className="w-full px-3.5 py-2.5 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-center tracking-widest font-mono text-lg text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#4140FD]"
      />
    </div>

    <button
      type="submit"
      disabled={loading || phoneCode.length < 6}
      className="w-full py-3 rounded-xl bg-[#4140FD] hover:bg-[#5251fd] text-white font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99]"
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      <span>Verify and continue</span>
    </button>
  </form>
);
