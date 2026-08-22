import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  readonly children: ReactNode;
};

type ErrorBoundaryState = {
  readonly error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    if (import.meta.env.DEV) console.error("[Voice V3] dashboard error", error, errorInfo);
  }

  public render() {
    if (this.state.error) {
      return (
        <main style={{ padding: 24, color: "#fee2e2", background: "#1e0b0b", minHeight: "100vh" }}>
          <h1>Voice V3 dashboard failed</h1>
          <p>The realtime engine is isolated. Restart the debug session after correcting the reported error.</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error.message}</pre>
        </main>
      );
    }
    return this.props.children;
  }
}
