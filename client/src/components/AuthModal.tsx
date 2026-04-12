import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { requestAuthCode, verifyAuthCode } from '../api';
import TurnstileWidget from './TurnstileWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';

const RESEND_TIMEOUT_SECONDS = 30;

const getPhoneDigits = (value: string) => value.replace(/\D/g, '');

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

const isExpiredCodeError = (value: string) => {
  const normalized = value.toLowerCase();
  return normalized.includes('истек') || normalized.includes('expired');
};

const isCaptchaValidationError = (value: string) => {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('капч') ||
    normalized.includes('captcha') ||
    normalized.includes('проверк')
  );
};

const isPhoneReadyForCaptcha = (value: string) => {
  const digits = getPhoneDigits(value);
  return digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'));
};

const AuthModal = () => {
  const { authModalOpen, closeAuthModal } = useUI();
  const { mergeWithServer } = useCart();
  const { setUser } = useAuth();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'code' | 'password'>('code');
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [isVerifyError, setIsVerifyError] = useState(false);
  const [isCodeRequested, setIsCodeRequested] = useState(false);
  const [isRequestButtonHidden, setIsRequestButtonHidden] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

  const handleCaptchaTokenChange = useCallback((token: string | null) => {
    setCaptchaToken(token);
    if (token) {
      setRequestError((prev) =>
        prev === 'Подтвердите, что вы не робот.' ? null : prev
      );
    }
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) {
      return;
    }

    const timerId = window.setTimeout(() => {
      setResendSeconds((prev) => Math.max(prev - 1, 0));
    }, 1000);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [resendSeconds]);

  useEffect(() => {
    if (authModalOpen) {
      return;
    }

    setPhone('');
    setCode('');
    setPassword('');
    setAuthMode('code');
    setRequestStatus(null);
    setRequestError(null);
    setVerifyMessage(null);
    setIsVerifyError(false);
    setIsCodeRequested(false);
    setIsRequestButtonHidden(false);
    setResendSeconds(0);
    setIsRequesting(false);
    setIsVerifying(false);
    if (captchaToken) {
      setCaptchaToken(null);
      setCaptchaResetKey((prev) => prev + 1);
    }
  }, [authModalOpen]);

  if (!authModalOpen) {
    return null;
  }

  const phoneReadyForCaptcha = isPhoneReadyForCaptcha(phone);
  const shouldShowCaptcha =
    authMode === 'code' && Boolean(turnstileSiteKey) && phoneReadyForCaptcha && !captchaToken;
  const showAuthFields = authMode === 'password' || isCodeRequested;
  const showRequestCodeButton = authMode === 'code' && !isRequestButtonHidden;
  const resendStatusText =
    showRequestCodeButton && isCodeRequested && authMode === 'code' && resendSeconds > 0
      ? `Получить новый код можно через ${resendSeconds} сек.`
      : null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setVerifyMessage(null);
    setIsVerifyError(false);

    if (!phone.trim()) {
      setVerifyMessage('Введите номер телефона.');
      setIsVerifyError(true);
      return;
    }

    if (authMode === 'password') {
      if (!password.trim()) {
        setVerifyMessage('Введите пароль.');
        setIsVerifyError(true);
        return;
      }
    } else if (!code.trim()) {
      setVerifyMessage('Введите код.');
      setIsVerifyError(true);
      return;
    }

    setIsVerifying(true);
    try {
      const result =
        authMode === 'password'
          ? await verifyAuthCode(phone.trim(), '', password.trim())
          : await verifyAuthCode(phone.trim(), code.trim());

      setUser(result.user);
      await mergeWithServer();
      closeAuthModal();
    } catch (error) {
      const apiErrorMessage = extractApiErrorMessage(error);

      if (authMode === 'password') {
        setVerifyMessage(apiErrorMessage || 'Неверный пароль.');
        setIsVerifyError(true);
        return;
      }

      if (isExpiredCodeError(apiErrorMessage)) {
        setVerifyMessage('Код истёк, запросите новый.');
        setIsVerifyError(true);
        setIsCodeRequested(false);
        setIsRequestButtonHidden(false);
        setRequestStatus(null);
        setRequestError(null);
        setResendSeconds(0);
        setCode('');
        return;
      }

      setVerifyMessage(apiErrorMessage || 'Неверный код.');
      setIsVerifyError(true);
    } finally {
      setIsVerifying(false);
    }
  };

  const handlePhoneChange = (value: string) => {
    setPhone(formatPhone(value));
    setAuthMode('code');
    setCode('');
    setPassword('');
    setIsCodeRequested(false);
    setIsRequestButtonHidden(false);
    setResendSeconds(0);
    setRequestStatus(null);
    setRequestError(null);
    setVerifyMessage(null);
    setIsVerifyError(false);
    if (captchaToken) {
      setCaptchaToken(null);
      setCaptchaResetKey((prev) => prev + 1);
    }
  };

  const handleRequestCode = async () => {
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
        setIsCodeRequested(true);
        setIsRequestButtonHidden(true);
        setVerifyMessage('Введите пароль администратора.');
        setIsVerifyError(false);
        return;
      }

      setAuthMode('code');
      setCode('');
      setIsCodeRequested(true);
      setIsRequestButtonHidden(true);
      setResendSeconds(RESEND_TIMEOUT_SECONDS);
      if (result.deliveryChannel === 'sms_ru') {
        setRequestStatus('Код отправлен по SMS.');
      } else if (result.deliveryChannel === 'debug') {
        setRequestStatus('Код отправлен (тестовый режим).');
      } else {
        setRequestStatus('Код отправлен.');
      }
    } catch (error) {
      const apiErrorMessage = extractApiErrorMessage(error);
      setRequestError(apiErrorMessage || 'Не удалось отправить код.');
      if (turnstileSiteKey && isCaptchaValidationError(apiErrorMessage)) {
        setCaptchaToken(null);
        setCaptchaResetKey((prev) => prev + 1);
      }
    } finally {
      setIsRequesting(false);
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
            : 'Код для входа отправим по SMS.'}
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

          {authMode === 'code' && (
            <>
              {showRequestCodeButton && (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleRequestCode()}
                  disabled={isRequesting || resendSeconds > 0}
                >
                  {isRequesting ? 'Отправляем...' : 'Получить код'}
                </button>
              )}

              {requestStatus && <p className="status-text auth-code-status">{requestStatus}</p>}
              {requestError && (
                <p className="status-text status-text--error auth-code-status">{requestError}</p>
              )}
              {resendStatusText && <p className="status-text auth-code-status">{resendStatusText}</p>}
            </>
          )}

          {showAuthFields && (
            <>
              <label className="field">
                <span>{authMode === 'password' ? 'Пароль' : 'Код'}</span>
                <input
                  type={authMode === 'password' ? 'password' : 'text'}
                  inputMode={authMode === 'password' ? undefined : 'numeric'}
                  value={authMode === 'password' ? password : code}
                  onChange={(event) =>
                    authMode === 'password'
                      ? setPassword(event.target.value)
                      : setCode(event.target.value)
                  }
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

