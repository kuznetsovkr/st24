import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { fetchAuthCallStatus, requestAuthCode, verifyAuthCode } from '../api';
import TurnstileWidget from './TurnstileWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';

const getPhoneDigits = (value: string) => value.replace(/\D/g, '');

const isPhoneReadyForCaptcha = (value: string) => {
  const digits = getPhoneDigits(value);
  return digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'));
};

const extractApiErrorMessage = (error: unknown) => {
  if (!(error instanceof Error)) {
    return '';
  }

  const raw = error.message?.trim() ?? '';
  if (!raw) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; errors?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (Array.isArray(parsed.errors)) {
      const first = parsed.errors.find(
        (item): item is string => typeof item === 'string' && item.trim().length > 0
      );
      if (first) {
        return first.trim();
      }
    }
  } catch {
    return raw;
  }

  return raw;
};

const isCaptchaValidationError = (value: string) => {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('капч') ||
    normalized.includes('captcha') ||
    normalized.includes('робот') ||
    normalized.includes('verify') ||
    normalized.includes('проверк')
  );
};

const isExpiredCallError = (value: string) => {
  const normalized = value.toLowerCase();
  return normalized.includes('expired') || normalized.includes('истек');
};

const formatCallHref = (phone: string | null) => {
  if (!phone) {
    return '';
  }
  const normalized = phone.replace(/[^\d+]/g, '');
  return normalized ? `tel:${normalized}` : '';
};

const AuthModal = () => {
  const { authModalOpen, closeAuthModal } = useUI();
  const { mergeWithServer } = useCart();
  const { setUser } = useAuth();

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'call' | 'password'>('call');
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [isVerifyError, setIsVerifyError] = useState(false);
  const [isCallRequested, setIsCallRequested] = useState(false);
  const [isRequestButtonHidden, setIsRequestButtonHidden] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isAutoCheckingCall, setIsAutoCheckingCall] = useState(false);
  const [callPhone, setCallPhone] = useState<string | null>(null);
  const [callPhonePretty, setCallPhonePretty] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);

  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

  const phoneReadyForCaptcha = isPhoneReadyForCaptcha(phone);
  const shouldShowCaptcha =
    authMode === 'call' && Boolean(turnstileSiteKey) && phoneReadyForCaptcha && !captchaToken;
  const showRequestCallButton = authMode === 'call' && !isRequestButtonHidden;
  const callHref = useMemo(() => formatCallHref(callPhone), [callPhone]);

  const resetCallFlow = useCallback(() => {
    setIsCallRequested(false);
    setIsRequestButtonHidden(false);
    setIsRequesting(false);
    setIsAutoCheckingCall(false);
    setIsVerifying(false);
    setCallPhone(null);
    setCallPhonePretty(null);
    setRequestStatus(null);
    setRequestError(null);
  }, []);

  const handleCaptchaTokenChange = useCallback((token: string | null) => {
    setCaptchaToken(token);
    if (token) {
      setRequestError((prev) => (prev === 'Подтвердите, что вы не робот.' ? null : prev));
    }
  }, []);

  useEffect(() => {
    if (authModalOpen) {
      return;
    }

    setPhone('');
    setPassword('');
    setAuthMode('call');
    setRequestStatus(null);
    setRequestError(null);
    setVerifyMessage(null);
    setIsVerifyError(false);
    setIsCallRequested(false);
    setIsRequestButtonHidden(false);
    setIsRequesting(false);
    setIsVerifying(false);
    setIsAutoCheckingCall(false);
    setCallPhone(null);
    setCallPhonePretty(null);
    if (captchaToken) {
      setCaptchaToken(null);
      setCaptchaResetKey((prev) => prev + 1);
    }
  }, [authModalOpen, captchaToken]);

  useEffect(() => {
    if (!authModalOpen || authMode !== 'call' || !isCallRequested || !phone.trim()) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const normalizedPhone = phone.trim();

    const pollCallStatus = async () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      setIsAutoCheckingCall(true);

      try {
        const status = await fetchAuthCallStatus(normalizedPhone);
        if (cancelled) {
          return;
        }

        if (status.status === 'confirmed') {
          setIsVerifying(true);
          const result = await verifyAuthCode(normalizedPhone, '');
          if (cancelled) {
            return;
          }
          setUser(result.user);
          await mergeWithServer();
          closeAuthModal();
          return;
        }

        if (status.status === 'expired' || status.status === 'not_found') {
          setVerifyMessage('Время ожидания звонка истекло. Запросите новый номер.');
          setIsVerifyError(true);
          resetCallFlow();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const apiErrorMessage = extractApiErrorMessage(error);
        if (isExpiredCallError(apiErrorMessage)) {
          setVerifyMessage('Время ожидания звонка истекло. Запросите новый номер.');
          setIsVerifyError(true);
          resetCallFlow();
          return;
        }
        if (apiErrorMessage) {
          setRequestError(apiErrorMessage);
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setIsAutoCheckingCall(false);
          setIsVerifying(false);
        }
      }
    };

    void pollCallStatus();
    const intervalId = window.setInterval(() => {
      void pollCallStatus();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [authModalOpen, authMode, closeAuthModal, isCallRequested, mergeWithServer, phone, resetCallFlow, setUser]);

  if (!authModalOpen) {
    return null;
  }

  const handlePhoneChange = (value: string) => {
    setPhone(formatPhone(value));
    setPassword('');
    setAuthMode('call');
    setRequestStatus(null);
    setRequestError(null);
    setVerifyMessage(null);
    setIsVerifyError(false);
    resetCallFlow();
    if (captchaToken) {
      setCaptchaToken(null);
      setCaptchaResetKey((prev) => prev + 1);
    }
  };

  const handleRequestCall = async () => {
    setRequestStatus(null);
    setRequestError(null);
    setVerifyMessage(null);
    setIsVerifyError(false);

    if (!phone.trim()) {
      setRequestError('Введите номер телефона.');
      return;
    }

    if (!phoneReadyForCaptcha) {
      setRequestError('Введите полный номер телефона.');
      return;
    }

    if (turnstileSiteKey && !captchaToken) {
      setRequestError('Подтвердите, что вы не робот.');
      return;
    }

    setIsRequesting(true);
    try {
      const result = await requestAuthCode(phone.trim(), undefined, captchaToken ?? undefined);

      if (result.requiresPassword) {
        setAuthMode('password');
        setIsRequestButtonHidden(true);
        setIsCallRequested(false);
        setCallPhone(null);
        setCallPhonePretty(null);
        setVerifyMessage('Введите пароль администратора.');
        setIsVerifyError(false);
        return;
      }

      setAuthMode('call');
      setIsCallRequested(true);
      setIsRequestButtonHidden(true);
      setCallPhone(result.callPhone ?? null);
      setCallPhonePretty(result.callPhonePretty ?? null);

      if (result.deliveryChannel === 'sms_ru_call' && result.callPhonePretty) {
        setRequestStatus(`Позвоните на номер ${result.callPhonePretty}. Вход выполнится автоматически.`);
      } else if (result.deliveryChannel === 'debug') {
        setRequestStatus('Проверка звонка запущена (тестовый режим).');
      } else {
        setRequestStatus('Проверка звонка запущена. Вход выполнится автоматически.');
      }
    } catch (error) {
      const apiErrorMessage = extractApiErrorMessage(error);
      setRequestError(apiErrorMessage || 'Не удалось запросить номер для звонка.');
      if (turnstileSiteKey && isCaptchaValidationError(apiErrorMessage)) {
        setCaptchaToken(null);
        setCaptchaResetKey((prev) => prev + 1);
      }
    } finally {
      setIsRequesting(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setVerifyMessage(null);
    setIsVerifyError(false);

    if (!phone.trim()) {
      setVerifyMessage('Введите номер телефона.');
      setIsVerifyError(true);
      return;
    }

    if (authMode === 'password' && !password.trim()) {
      setVerifyMessage('Введите пароль.');
      setIsVerifyError(true);
      return;
    }

    if (authMode === 'call') {
      if (!isCallRequested) {
        setVerifyMessage('Сначала запросите номер для звонка.');
        setIsVerifyError(true);
        return;
      }
      setVerifyMessage('После звонка вход выполнится автоматически.');
      setIsVerifyError(false);
      return;
    }

    setIsVerifying(true);
    try {
      const result = await verifyAuthCode(phone.trim(), '', password.trim());

      setUser(result.user);
      await mergeWithServer();
      closeAuthModal();
    } catch (error) {
      const apiErrorMessage = extractApiErrorMessage(error);
      setVerifyMessage(apiErrorMessage || 'Неверный пароль.');
      setIsVerifyError(true);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={closeAuthModal}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Авторизация</p>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={closeAuthModal}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="17"
              height="17"
              viewBox="0 0 17 17"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M16.5 0.5L0.5 16.5M16.5 16.5L0.5 0.5"
                stroke="#433F3C"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <p className="muted">
          {authMode === 'password'
            ? 'Для администратора используется пароль.'
            : 'Для входа подтвердите номер бесплатным звонком.'}
        </p>

        <form className="stacked-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Телефон</span>
            <input
              type="tel"
              placeholder="+7"
              value={phone}
              onChange={(event) => handlePhoneChange(event.target.value)}
              required
            />
          </label>

          {shouldShowCaptcha && (
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              action="request_phone_code"
              resetKey={captchaResetKey}
              onTokenChange={handleCaptchaTokenChange}
            />
          )}

          {authMode === 'call' && (
            <>
              {showRequestCallButton && (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleRequestCall()}
                  disabled={isRequesting}
                >
                  {isRequesting ? 'Отправляем...' : 'Получить номер для звонка'}
                </button>
              )}

              {requestStatus && <p className="status-text auth-code-status">{requestStatus}</p>}
              {requestError && (
                <p className="status-text status-text--error auth-code-status">{requestError}</p>
              )}

              {callPhonePretty && (
                <p className="status-text auth-code-status">
                  Номер для звонка:{' '}
                  {callHref ? (
                    <a className="auth-code-link" href={callHref}>
                      {callPhonePretty}
                    </a>
                  ) : (
                    callPhonePretty
                  )}
                </p>
              )}
              {callPhonePretty && (
                <p className="status-text auth-code-status">
                  Звонок бесплатный, номер сбрасывается автоматически.
                </p>
              )}

              {isCallRequested && (
                <p className="status-text auth-code-status">
                  {isAutoCheckingCall
                    ? 'Проверяем статус звонка...'
                    : 'Ожидаем подтверждение звонка.'}
                </p>
              )}
            </>
          )}

          {authMode === 'password' && (
            <>
              <label className="field">
                <span>Пароль</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>

              <div className="modal-actions">
                <button
                  type="submit"
                  className="primary-button auth-submit-button"
                  disabled={isVerifying}
                >
                  {isVerifying ? 'Проверяем...' : 'Войти'}
                </button>
              </div>
            </>
          )}

          {verifyMessage && (
            <p className={`status-text${isVerifyError ? ' status-text--error' : ''}`}>
              {verifyMessage}
            </p>
          )}
        </form>
      </div>
    </div>
  );
};

export default AuthModal;
