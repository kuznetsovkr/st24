import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { requestAuthCode, setAuthToken, verifyAuthCode } from '../api';
import TurnstileWidget from './TurnstileWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';

const RESEND_TIMEOUT_SECONDS = 30;
const SMS_FALLBACK_TIMEOUT_SECONDS = 60;
type AuthDeliveryChannel = 'telegram_gateway' | 'sms_ru' | 'debug' | null;

const getPhoneDigits = (value: string) => value.replace(/\D/g, '');

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
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [isCodeRequested, setIsCodeRequested] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [smsFallbackSeconds, setSmsFallbackSeconds] = useState(0);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [deliveryChannel, setDeliveryChannel] = useState<AuthDeliveryChannel>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

  const handleCaptchaTokenChange = useCallback((token: string | null) => {
    setCaptchaToken(token);
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
    if (smsFallbackSeconds <= 0) {
      return;
    }

    const timerId = window.setTimeout(() => {
      setSmsFallbackSeconds((prev) => Math.max(prev - 1, 0));
    }, 1000);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [smsFallbackSeconds]);

  useEffect(() => {
    if (authModalOpen) {
      return;
    }

    setPhone('');
    setCode('');
    setPassword('');
    setAuthMode('code');
    setRequestMessage(null);
    setVerifyMessage(null);
    setIsCodeRequested(false);
    setResendSeconds(0);
    setSmsFallbackSeconds(0);
    setIsRequesting(false);
    setIsVerifying(false);
    setDeliveryChannel(null);
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
  const resendStatusText =
    isCodeRequested && authMode === 'code' && resendSeconds > 0
      ? `Получить новый код можно через ${resendSeconds} сек.`
      : null;
  const showSmsFallbackLink = authMode === 'code' && deliveryChannel === 'telegram_gateway';
  const smsFallbackHint = showSmsFallbackLink
    ? smsFallbackSeconds > 0
      ? `Нет доступа к Telegram? Получить код по SMS можно через ${smsFallbackSeconds} сек.`
      : null
    : null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setVerifyMessage(null);

    if (!phone.trim()) {
      setVerifyMessage('Введите номер телефона.');
      return;
    }

    if (authMode === 'password') {
      if (!password.trim()) {
        setVerifyMessage('Введите пароль.');
        return;
      }
    } else if (!code.trim()) {
      setVerifyMessage('Введите код.');
      return;
    }

    setIsVerifying(true);
    try {
      const result =
        authMode === 'password'
          ? await verifyAuthCode(phone.trim(), '', password.trim())
          : await verifyAuthCode(phone.trim(), code.trim());

      setAuthToken(result.token);
      setUser(result.user);
      await mergeWithServer();
      closeAuthModal();
    } catch {
      setVerifyMessage(authMode === 'password' ? 'Неверный пароль.' : 'Неверный код.');
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
    setResendSeconds(0);
    setRequestMessage(null);
    setVerifyMessage(null);
    if (captchaToken) {
      setCaptchaToken(null);
      setCaptchaResetKey((prev) => prev + 1);
    }
  };

  const handleRequestCode = async (preferredChannel?: 'sms_ru') => {
    setRequestMessage(null);
    setVerifyMessage(null);

    if (!phone.trim()) {
      setRequestMessage('Введите номер телефона.');
      return;
    }

    if (!phoneReadyForCaptcha) {
      setRequestMessage('Введите полный номер телефона.');
      return;
    }

    if (turnstileSiteKey && !captchaToken) {
      setRequestMessage('Подтвердите, что вы не робот.');
      return;
    }

    setIsRequesting(true);
    try {
      const result = await requestAuthCode(
        phone.trim(),
        preferredChannel,
        captchaToken ?? undefined
      );

      if (result.requiresPassword) {
        setAuthMode('password');
        setIsCodeRequested(true);
        setDeliveryChannel(null);
        setSmsFallbackSeconds(0);
        setVerifyMessage('Введите пароль администратора.');
        return;
      }

      setAuthMode('code');
      setCode('');
      setIsCodeRequested(true);
      setResendSeconds(RESEND_TIMEOUT_SECONDS);
      setDeliveryChannel(result.deliveryChannel ?? null);
      setSmsFallbackSeconds(result.deliveryChannel === 'telegram_gateway' ? SMS_FALLBACK_TIMEOUT_SECONDS : 0);

      if (result.code) {
        window.alert(`Тестовый SMS-код: ${result.code}`);
      }

      if (preferredChannel === 'sms_ru' || result.deliveryChannel === 'sms_ru') {
        setRequestMessage('Код отправлен по SMS.');
      } else if (result.deliveryChannel === 'telegram_gateway') {
        setRequestMessage('Код отправлен в Telegram.');
      } else {
        setRequestMessage('Код отправлен.');
      }
    } catch {
      setRequestMessage('Не удалось отправить код.');
    } finally {
      setIsRequesting(false);
      if (turnstileSiteKey) {
        setCaptchaToken(null);
        setCaptchaResetKey((prev) => prev + 1);
      }
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
            : 'Сначала отправляем код в Telegram. Если Telegram недоступен, можно запросить код по SMS.'}
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
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleRequestCode()}
                disabled={isRequesting || resendSeconds > 0}
              >
                {isRequesting ? 'Отправляем...' : 'Получить код'}
              </button>

              {requestMessage && <p className="status-text auth-code-status">{requestMessage}</p>}
              {resendStatusText && <p className="status-text auth-code-status">{resendStatusText}</p>}
              {showSmsFallbackLink && (
                <p className="status-text auth-code-status">
                  {smsFallbackHint ?? (
                    <>
                      Нет доступа к Telegram?{' '}
                      <button
                        type="button"
                        className="link-button auth-code-link"
                        onClick={() => void handleRequestCode('sms_ru')}
                        disabled={isRequesting}
                      >
                        Получить код по SMS
                      </button>
                    </>
                  )}
                </p>
              )}
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

          {verifyMessage && <p className="status-text">{verifyMessage}</p>}
        </form>
      </div>
    </div>
  );
};

export default AuthModal;
