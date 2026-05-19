import { Component, type ErrorInfo, type ReactNode } from 'react';

type RouteErrorBoundaryProps = {
  children: ReactNode;
};

type RouteErrorBoundaryState = {
  hasError: boolean;
};

class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = {
    hasError: false
  };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Failed to load route component', error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="page">
        <p className="muted">Не удалось загрузить страницу. Проверьте интернет и обновите сайт.</p>
        <button type="button" className="ghost-button" onClick={this.handleReload}>
          Обновить страницу
        </button>
      </div>
    );
  }
}

export default RouteErrorBoundary;
