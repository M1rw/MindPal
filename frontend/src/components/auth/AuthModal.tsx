import React, { useState, useEffect } from 'react';
import { useAuthStore, useToastStore, useSessionStore } from '../../store';
import { STORAGE_KEYS } from '../../constants/storage';
import { Modal, ModalBody, ModalHeader } from '../ui/Modal';
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
    <Modal
      id="auth-modal"
      panelId="auth-modal-content"
      open={isAuthModalOpen}
      onClose={closeAuthModal}
      labelledBy="auth-modal-title"
      size="md"
      layer={80}
    >
      <ModalHeader
        kicker="Account"
        title="Sign in to MindPal"
        titleId="auth-modal-title"
        description="Use a Firebase account on this device. Chat history stays in this browser; cloud session sync is attempted when you are signed in."
        onClose={closeAuthModal}
        closeLabel="Close sign-in"
      />
      <ModalBody>
        {errorMessage && (
          <div className="mb-4 p-3 rounded-xl bg-feedback-dangerSubtle border border-feedback-danger/30 text-sm text-feedback-danger">
            {errorMessage}
          </div>
        )}
        {successMessage && (
          <div className="mb-4 p-3 rounded-xl bg-feedback-successSubtle border border-feedback-success/30 text-sm text-feedback-success">
            {successMessage}
          </div>
        )}

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
      </ModalBody>
    </Modal>
  );
};
