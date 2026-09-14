import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useAuthStore, useToastStore, useSessionStore } from '../../store';
import { STORAGE_KEYS } from '../../constants/storage';
import { useFocusTrap } from '../../hooks/useFocusTrap';
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
} from '../../services/auth/index';
import type { ConfirmationResult } from 'firebase/auth';
import type { AuthUser } from '../../types';
import {
  AuthChoiceView,
  AuthEmailView,
  AuthPhoneCodeView,
  AuthPhoneView,
} from './AuthViews';

export const AuthModal: React.FC = () => {
  const { isAuthModalOpen, closeAuthModal, setUser, authModalView, setAuthModalView } = useAuthStore();
  const { setAuth } = useSessionStore();
  const { push: pushToast } = useToastStore();
  const modalCardRef = useFocusTrap<HTMLDivElement>({
    isOpen: isAuthModalOpen,
    onClose: closeAuthModal,
    autoFocus: true,
  });

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
      setLastUsed(localStorage.getItem(STORAGE_KEYS.AUTH_LAST_USED));
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

  const handleAuthSuccess = async (user: AuthUser, provider: string) => {
    setUser(user);
    try {
      localStorage.setItem(STORAGE_KEYS.AUTH_LAST_USED, provider);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err ?? '');
      if (!message.includes('popup-closed')) {
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err ?? '');
      if (!message.includes('popup-closed')) {
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
      let user: AuthUser;
      if (isRegisterMode) {
        user = await createAccountWithEmailPassword(email, password);
      } else {
        user = await signInWithEmailPassword(email, password);
      }
      await handleAuthSuccess(user, 'email');
    } catch (err: unknown) {
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
    } catch (err: unknown) {
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
    } catch (err: unknown) {
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
    } catch (err: unknown) {
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
        ref={modalCardRef}
        id="auth-modal-content"
        className="relative w-full sm:max-w-[420px] bg-white dark:bg-[#18181B] border border-black/[0.08] dark:border-white/[0.08] rounded-t-2xl sm:rounded-2xl shadow-xl px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom,1.25rem))] sm:p-6 z-10 animate-fade-in"
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

        {authModalView === 'choice' && (
          <AuthChoiceView
            loading={loading}
            lastUsed={lastUsed}
            onGoogle={handleGoogleSignIn}
            onApple={handleAppleSignIn}
            onPhone={() => setAuthModalView('phone')}
            onEmail={() => setAuthModalView('email')}
          />
        )}

        {authModalView === 'email' && (
          <AuthEmailView
            loading={loading}
            email={email}
            password={password}
            showPassword={showPassword}
            isRegisterMode={isRegisterMode}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
            onTogglePasswordVisibility={() => setShowPassword((current) => !current)}
            onSubmit={handleEmailSubmit}
            onBack={() => setAuthModalView('choice')}
            onToggleMode={() => setIsRegisterMode((current) => !current)}
            onForgotPassword={handleForgotPassword}
          />
        )}

        {authModalView === 'phone' && (
          <AuthPhoneView
            loading={loading}
            phoneNumber={phoneNumber}
            onPhoneNumberChange={setPhoneNumber}
            onSubmit={handlePhoneSubmit}
            onBack={() => setAuthModalView('choice')}
          />
        )}

        {authModalView === 'phone-code' && (
          <AuthPhoneCodeView
            loading={loading}
            phoneNumber={phoneNumber}
            phoneCode={phoneCode}
            onPhoneCodeChange={setPhoneCode}
            onSubmit={handlePhoneCodeSubmit}
            onBack={() => setAuthModalView('phone')}
          />
        )}
      </section>
    </div>
  );
};
