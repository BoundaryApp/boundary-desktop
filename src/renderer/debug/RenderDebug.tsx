import React from 'react';
import { createFileLogger } from '../../shared/utils/logger';

const log = createFileLogger(undefined, 'renderer:debug');

interface RenderTrackerProps {
  name: string;
  children?: React.ReactNode;
}

/** Debug component to track renders */
export class RenderTracker extends React.Component<RenderTrackerProps> {
  renderCount: number;

  constructor(props: RenderTrackerProps) {
    super(props);
    this.renderCount = 0;
  }

  componentDidMount() {
    log(`[RENDER TRACKER] ${this.props.name} mounted`);
  }

  componentDidUpdate() {
    this.renderCount++;
    log(`[RENDER TRACKER] ${this.props.name} rendered ${this.renderCount} times`);

    if (this.renderCount > 10) {
      console.error(`[RENDER TRACKER] ${this.props.name} has rendered too many times!`);
    }
  }

  render() {
    return this.props.children;
  }
}

interface ErrorBoundaryProps {
  children?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/** Error boundary to catch infinite re-renders */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(_error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ERROR BOUNDARY] Caught error:', error);
    console.error('[ERROR BOUNDARY] Error info:', errorInfo);
    this.setState({ error, errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', border: '2px solid red', margin: '20px' }}>
          <h2>Something went wrong.</h2>
          <details style={{ whiteSpace: 'pre-wrap' }}>
            {this.state.error && this.state.error.toString()}
            <br />
            {this.state.errorInfo && this.state.errorInfo.componentStack}
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}
