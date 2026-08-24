import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('[swITch] React render failed', { error, componentStack: info.componentStack });
    }

    render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;

        const korean = document.documentElement.lang === 'ko';
        return (
            <main style={{
                minHeight: '100vh',
                boxSizing: 'border-box',
                display: 'grid',
                placeItems: 'center',
                padding: 32,
                background: '#17191a',
                color: '#fff',
                fontFamily: 'system-ui, sans-serif',
            }}>
                <section role="alert" style={{ width: 'min(720px, 100%)', display: 'grid', gap: 20 }}>
                    <h1 style={{ margin: 0 }}>{korean ? '화면을 표시하지 못했습니다' : 'The screen could not be displayed'}</h1>
                    <p style={{ margin: 0, color: '#c8ccce', lineHeight: 1.55 }}>
                        {korean
                            ? '예상하지 못한 오류가 발생했습니다. 아래 오류를 기록한 뒤 다시 시도해 주세요.'
                            : 'An unexpected error occurred. Keep the details below and try again.'}
                    </p>
                    <pre style={{ margin: 0, padding: 16, overflow: 'auto', borderRadius: 10, background: '#252829', color: '#ffb7b7', whiteSpace: 'pre-wrap' }}>
                        {error.stack || `${error.name}: ${error.message}`}
                    </pre>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                        <button type="button" onClick={() => window.location.reload()} style={{ padding: '12px 20px', fontWeight: 800 }}>
                            {korean ? '다시 시도' : 'Try again'}
                        </button>
                        <button type="button" onClick={() => window.location.assign('/')} style={{ padding: '12px 20px', fontWeight: 800 }}>
                            {korean ? '첫 화면으로' : 'Go home'}
                        </button>
                    </div>
                </section>
            </main>
        );
    }
}
