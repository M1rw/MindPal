import React, { useState, useEffect } from 'react';
import { X, ArrowLeft, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuthStore, useToastStore, useSessionStore } from '../../store';
import {
  signInWithGoogle,
  signInWithApple,
  signInWithEmailPassword,
  createAccountWithEmailPassword,
  sendPasswordReset,
  startPhoneNumberSignIn,
  confirmPhoneCode,
  formatAuthError,
  getIdToken,
} from '../../services/auth';
import type { ConfirmationResult } from 'firebase/auth';

export const AuthModal: React.FC = () => {
  const { isAuthModalOpen, closeAuthModal, setUser, authModalView, setAuthModalView } = useAuthStore();
  const { setAuth } = useSessionStore();
  const { push: pushToast } = useToastStore();

  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Email state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);

  // Phone state
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);

  // Last used provider
  const [lastUsed, setLastUsed] = useState<string | null>(null);

  useEffect(() => {
    try {
      setLastUsed(localStorage.getItem('mindpal_auth_last_used'));
    } catch {
      // Ignore
    }
  }, [isAuthModalOpen]);

  // Reset errors on view change
  useEffect(() => {
    setErrorMessage(null);
    setSuccessMessage(null);
  }, [authModalView]);

  if (!isAuthModalOpen) return null;

  const handleAuthSuccess = async (user: any, provider: string) => {
    setUser(user);
    try {
      localStorage.setItem('mindpal_auth_last_used', provider);
    } catch {
      // Ignore
    }
    const token = await getIdToken();
    setAuth(user.uid, token);
    pushToast(`Signed in as ${user.displayName || user.email || 'User'}`, 'success');
    closeAuthModal();
  };

  // Google
  const handleGoogleSignIn = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const user = await signInWithGoogle();
      await handleAuthSuccess(user, 'google');
    } catch (err: any) {
      if (!err?.message?.includes('popup-closed')) {
        setErrorMessage(formatAuthError(err));
      }
    } finally {
      setLoading(false);
    }
  };

  // Apple
  const handleAppleSignIn = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const user = await signInWithApple();
      await handleAuthSuccess(user, 'apple');
    } catch (err: any) {
      if (!err?.message?.includes('popup-closed')) {
        setErrorMessage(formatAuthError(err));
      }
    } finally {
      setLoading(false);
    }
  };

  // Email Submit
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      let user;
      if (isRegisterMode) {
        user = await createAccountWithEmailPassword(email, password);
      } else {
        user = await signInWithEmailPassword(email, password);
      }
      await handleAuthSuccess(user, 'email');
    } catch (err: any) {
      setErrorMessage(formatAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  // Forgot Password
  const handleForgotPassword = async () => {
    if (!email) {
      setErrorMessage('Please enter your email first to reset your password.');
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      await sendPasswordReset(email);
      setSuccessMessage(`Password reset link sent to ${email}.`);
    } catch (err: any) {
      setErrorMessage(formatAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  // Phone Send Code
  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await startPhoneNumberSignIn(phoneNumber, 'auth-phone-recaptcha');
      setConfirmationResult(result);
      setAuthModalView('phone-code');
    } catch (err: any) {
      setErrorMessage(formatAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  // Phone Verify OTP
  const handlePhoneCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmationResult || !phoneCode) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const user = await confirmPhoneCode(confirmationResult, phoneCode);
      await handleAuthSuccess(user, 'phone');
    } catch (err: any) {
      setErrorMessage(formatAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      id="auth-modal"
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-5 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      {/* Backdrop */}
      <div
        id="auth-modal-backdrop"
        className="absolute inset-0 bg-black/40 dark:bg-black/70 backdrop-blur-sm"
        onClick={closeAuthModal}
      />

      {/* Modal Card */}
      <section
        id="auth-modal-content"
        className="relative w-full sm:max-w-[420px] bg-white dark:bg-[#1E1E2E] border border-black/5 dark:border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom,1.25rem))] sm:p-6 z-10 animate-fade-in"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#4140FD] dark:text-[#A39CF9]">
              MindPal Cloud
            </p>
            <h2 id="auth-modal-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100 tracking-tight mt-0.5">
              Back up your MindPal
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Sign in to securely sync your memory and conversations across devices.
            </p>
          </div>
          <button
            onClick={closeAuthModal}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
            type="button"
            aria-label="Close sign-in"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Feedback Alert */}
        {errorMessage && (
          <div className="mt-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-xs text-red-600 dark:text-red-400">
            {errorMessage}
          </div>
        )}
        {successMessage && (
          <div className="mt-4 p-3 rounded-xl bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900/50 text-xs text-green-600 dark:text-green-400">
            {successMessage}
          </div>
        )}

        {/* Invisible ReCAPTCHA Container */}
        <div id="auth-phone-recaptcha" className="hidden" />

        {/* ── View: Choice ── */}
        {authModalView === 'choice' && (
          <div className="mt-5 space-y-2.5">
            {/* Google */}
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-all text-sm font-medium text-gray-800 dark:text-gray-200 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            >
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M21.35 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.24a4.48 4.48 0 0 1-1.94 2.94v2.52h3.15c1.84-1.69 2.9-4.18 2.9-7.29Z" />
                  <path fill="#34A853" d="M12 21.75c2.62 0 4.82-.87 6.43-2.36l-3.15-2.52c-.87.58-1.99.92-3.28.92-2.53 0-4.67-1.71-5.44-4.01H3.31v2.6 A9.72 9.72 0 0 0 12 21.75Z" />
                  <path fill="#FBBC05" d="M6.56 13.78A5.85 5.85 0 0 1 6.26 12c0-.62.11-1.22.3-1.78v-2.6H3.31A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.05 1.06 4.38l3.25-2.6Z" />
                  <path fill="#EA4335" d="M12 6.21c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.81 3.28 14.61 2.25 12 2.25a9.72 9.72 0 0 0-8.69 5.37l3.25 2.6c.77-2.3 2.91-4.01 5.44-4.01Z" />
                </svg>
                <span>Continue with Google</span>
              </div>
              {lastUsed === 'google' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9]">
                  Last used
                </span>
              )}
            </button>

            {/* Apple */}
            <button
              type="button"
              onClick={handleAppleSignIn}
              disabled={loading}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-all text-sm font-medium text-gray-800 dark:text-gray-200 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
            >
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                  <path d="M17.05 12.54c-.03-2.37 1.94-3.53 2.03-3.59-1.11-1.62-2.83-1.84-3.44-1.86-1.45-.15-2.86.87-3.6.87-.75 0-1.88-.85-3.11-.82-1.59.02-3.08.95-3.9 2.39-1.7 2.94-.43 7.26 1.2 9.64.81 1.16 1.75 2.45 2.98 2.4 1.2-.05 1.65-.76 3.1-.76 1.44 0 1.85.76 3.11.73 1.29-.02 2.1-1.16 2.88-2.33.94-1.33 1.32-2.65 1.34-2.71-.03-.01-2.65-1.01-2.69-4.03ZM14.68 5.54c.65-.81 1.1-1.91.98-3.03-.94.04-2.12.65-2.8 1.44-.6.69-1.14 1.84-1.01 2.92 1.06.08 2.15-.53 2.83-1.33Z" />
                </svg>
                <span>Continue with Apple</span>
              </div>
              {lastUsed === 'apple' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9]">
                  Last used
                </span>
              )}
            </button>

            {/* Phone */}
            <button
              type="button"
              onClick={() => setAuthModalView('phone')}
              disabled={loading}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-all text-sm font-medium text-gray-800 dark:text-gray-200 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
            >
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="6.5" y="2.75" width="11" height="18.5" rx="2.1" />
                  <path d="M10 18.1h4" />
                </svg>
                <span>Continue with Phone</span>
              </div>
              {lastUsed === 'phone' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9]">
                  Last used
                </span>
              )}
            </button>

            {/* Divider */}
            <div className="relative py-2 flex items-center justify-center">
              <div className="w-full border-t border-gray-200 dark:border-zinc-700" />
              <span className="absolute bg-white dark:bg-[#1E1E2E] px-3 text-[11px] text-gray-400 uppercase">
                or
              </span>
            </div>

            {/* Email */}
            <button
              type="button"
              onClick={() => setAuthModalView('email')}
              disabled={loading}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-all text-sm font-medium text-gray-800 dark:text-gray-200 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
            >
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3.25" y="5.25" width="17.5" height="13.5" rx="2" />
                  <path d="m4.75 7 7.25 5.6L19.25 7" />
                </svg>
                <span>Continue with Email</span>
              </div>
              {lastUsed === 'email' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9]">
                  Last used
                </span>
              )}
            </button>

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
        )}

        {/* ── View: Email Form ── */}
        {authModalView === 'email' && (
          <form onSubmit={handleEmailSubmit} className="mt-5 space-y-4">
            <button
              type="button"
              onClick={() => setAuthModalView('choice')}
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
                  onChange={(e) => setEmail(e.target.value)}
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
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 6 characters"
                    className="w-full px-3.5 py-2.5 pr-10 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
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
              className="w-full py-3 rounded-xl bg-[#4140FD] hover:bg-[#6572F2] text-white font-medium text-sm transition-colors flex items-center justify-center gap-2 shadow-md shadow-[#4140FD]/20 disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{isRegisterMode ? 'Create account' : 'Sign in'}</span>
            </button>

            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 pt-1">
              <button
                type="button"
                onClick={() => setIsRegisterMode(!isRegisterMode)}
                className="hover:underline text-[#4140FD] dark:text-[#A39CF9] font-medium"
              >
                {isRegisterMode ? 'Already have an account? Sign in' : 'Create an account'}
              </button>
              {!isRegisterMode && (
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  className="hover:underline"
                >
                  Forgot password?
                </button>
              )}
            </div>
          </form>
        )}

        {/* ── View: Phone Form ── */}
        {authModalView === 'phone' && (
          <form onSubmit={handlePhoneSubmit} className="mt-5 space-y-4">
            <button
              type="button"
              onClick={() => setAuthModalView('choice')}
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
                onChange={(e) => setPhoneNumber(e.target.value)}
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
              className="w-full py-3 rounded-xl bg-[#4140FD] hover:bg-[#6572F2] text-white font-medium text-sm transition-colors flex items-center justify-center gap-2 shadow-md shadow-[#4140FD]/20 disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Send verification code</span>
            </button>
          </form>
        )}

        {/* ── View: Phone Code Verification ── */}
        {authModalView === 'phone-code' && (
          <form onSubmit={handlePhoneCodeSubmit} className="mt-5 space-y-4">
            <button
              type="button"
              onClick={() => setAuthModalView('phone')}
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
                onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-center tracking-widest font-mono text-lg text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#4140FD]"
              />
            </div>

            <button
              type="submit"
              disabled={loading || phoneCode.length < 6}
              className="w-full py-3 rounded-xl bg-[#4140FD] hover:bg-[#6572F2] text-white font-medium text-sm transition-colors flex items-center justify-center gap-2 shadow-md shadow-[#4140FD]/20 disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Verify and continue</span>
            </button>
          </form>
        )}
      </section>
    </div>
  );
};
