import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackMessage?: string;
  variant?: 'app' | 'section' | 'modal';
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  detailsOpen: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
    detailsOpen: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error('[ErrorBoundary caught error]:', error, errorInfo);

    // Attempt to log error to telemetry silently if the module is available.
    try {
      import('../../services/telemetry/index').catch(() => {
        // ignore
      });
    } catch {
      // ignore
    }
  }

  public handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, detailsOpen: false });
    this.props.onReset?.();
  };

  public render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const {
      fallbackTitle = 'Something interrupted this view',
      fallbackMessage = 'MindPal encountered an unexpected state. Your active conversation and memories remain securely saved.',
      variant = 'section',
    } = this.props;

    const isAppLevel = variant === 'app';

    return (
      <div
        role="alert"
        aria-live="assertive"
        className={`flex flex-col items-center justify-center p-6 text-center animate-fade-in ${
          isAppLevel
            ? 'min-h-screen bg-gemini-bg dark:bg-gemini-darkBg text-gemini-text dark:text-gemini-darkText'
            : 'w-full h-full min-h-[220px] rounded-2xl bg-black/[0.02] dark:bg-white/[0.03] border border-black/[0.06] dark:border-white/[0.08]'
        }`}
      >
        <div className="w-12 h-12 rounded-2xl bg-amber-500/10 dark:bg-amber-400/15 flex items-center justify-center mb-4 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-6 h-6" />
        </div>

        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1.5">
          {fallbackTitle}
        </h2>

        <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-md mb-5 leading-relaxed">
          {fallbackMessage}
        </p>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={this.handleReset}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-[#4140FD] hover:bg-[#3433d9] text-white shadow-sm transition-transform active:scale-95 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>

          {isAppLevel && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-zinc-800 dark:text-zinc-200 transition-colors"
            >
              Reload application
            </button>
          )}
        </div>

        {/* Technical details toggle for diagnostics */}
        {this.state.error && (
          <div className="mt-6 w-full max-w-lg text-left">
            <button
              type="button"
              onClick={() => this.setState((s) => ({ detailsOpen: !s.detailsOpen }))}
              className="inline-flex items-center gap-1 text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400 transition-colors"
            >
              <span>{this.state.detailsOpen ? 'Hide' : 'Show'} diagnostic details</span>
              {this.state.detailsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {this.state.detailsOpen && (
              <pre className="mt-2 p-3 text-[11px] font-mono rounded-xl bg-black/5 dark:bg-black/40 text-zinc-700 dark:text-zinc-300 overflow-x-auto max-h-48 custom-scrollbar border border-black/5 dark:border-white/5 whitespace-pre-wrap break-all">
                {this.state.error.toString()}
                {this.state.errorInfo?.componentStack}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }
}
