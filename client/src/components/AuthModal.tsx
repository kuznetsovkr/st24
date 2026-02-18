import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { requestAuthCode, setAuthToken, verifyAuthCode } from '../api';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';

const RESEND_TIMEOUT_SECONDS = 30;

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
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

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

  if (!authModalOpen) {
    return null;
  }

  const showAuthFields = authMode === 'password' || isCodeRequested;
  const requestStatusText =
    requestMessage === 'Код отправлен.' && resendSeconds > 0
      ? `Код отправлен. Получить новый код можно через ${resendSeconds} сек.`
      : requestMessage;

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
  };

  const handleRequestCode = async () => {
    setRequestMessage(null);
    setVerifyMessage(null);

    if (!phone.trim()) {
      setRequestMessage('Введите номер телефона.');
      return;
    }

    setIsRequesting(true);
    try {
      const result = await requestAuthCode(phone.trim());

      if (result.requiresPassword) {
        setAuthMode('password');
        setIsCodeRequested(true);
        setVerifyMessage('Введите пароль администратора.');
        return;
      }

      setAuthMode('code');
      setCode('');
      setIsCodeRequested(true);
      setResendSeconds(RESEND_TIMEOUT_SECONDS);

      if (result.code) {
        window.alert(`Тестовый SMS-код: ${result.code}`);
      }

      setRequestMessage('Код отправлен.');
    } catch {
      setRequestMessage('Не удалось отправить код.');
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
            <h3>Вход по телефону</h3>
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
            : 'Код показывается в alert как тестовое SMS. В проде подключим SMS.'}
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

          {authMode === 'code' && (
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={handleRequestCode}
                disabled={isRequesting || resendSeconds > 0}
              >
                {isRequesting ? 'Отправляем...' : 'Получить код'}
              </button>

              {requestStatusText && (
                <p className="status-text auth-code-status">{requestStatusText}</p>
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
