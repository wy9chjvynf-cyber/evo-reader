import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="screen">
          <h1 className="logo">EvoReader</h1>
          <p className="error">
            Algo salió mal al iniciar. Intenta recargar la página.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
