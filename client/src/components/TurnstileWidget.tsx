import { useEffect, useRef } from 'react';

const TURNSTILE_SCRIPT_ID = 'cf-turnstile-script';
const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileRenderOptions = {
  sitekey: string;
  action?: string;
  theme?: 'auto' | 'light' | 'dark';
  size?: 'normal' | 'compact' | 'flexible';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const loadTurnstileScript = () =>
  new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }

    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Turnstile failed to load')), {
        once: true
      });
      return;
    }

    const script = document.createElement('script');
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Turnstile failed to load')), {
      once: true
    });
    document.head.appendChild(script);
  });

type TurnstileWidgetProps = {
  siteKey: string;
  action: string;
  resetKey?: number;
  onTokenChange: (token: string | null) => void;
};

const TurnstileWidget = ({
  siteKey,
  action,
  resetKey = 0,
  onTokenChange
}: TurnstileWidgetProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!siteKey.trim()) {
      onTokenChange(null);
      return;
    }

    let active = true;

    loadTurnstileScript()
      .then(() => {
        if (!active || !containerRef.current || !window.turnstile) {
          return;
        }

        containerRef.current.innerHTML = '';
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme: 'light',
          size: 'flexible',
          callback: (token: string) => onTokenChange(token),
          'expired-callback': () => onTokenChange(null),
          'error-callback': () => onTokenChange(null)
        });
      })
      .catch(() => {
        if (active) {
          onTokenChange(null);
        }
      });

    return () => {
      active = false;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [action, onTokenChange, resetKey, siteKey]);

  if (!siteKey.trim()) {
    return null;
  }

  return (
    <div className="captcha-field">
      <div ref={containerRef} />
    </div>
  );
};

export default TurnstileWidget;
