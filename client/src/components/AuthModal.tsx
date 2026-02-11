import { useState } from 'react';
import type { FormEvent } from 'react';
import { requestAuthCode, setAuthToken, verifyAuthCode } from '../api';
import { useAuth } from '../context/AuthContext.tsx';
import { useCart } from '../context/CartContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';

const AuthModal = () => {
  const { authModalOpen, closeAuthModal } = useUI();
  const { mergeWithServer } = useCart();
  const { setUser } = useAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'code' | 'password'>('code');
  const [message, setMessage] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  if (!authModalOpen) {
    return null;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (!phone.trim()) {
      setMessage('Введите номер телефона.');
      return;
    }

    if (authMode === 'password') {
      if (!password.trim()) {
        setMessage('Введите пароль.');
        return;
      }
    } else if (!code.trim()) {
      setMessage('Введите код.');
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
      setMessage(authMode === 'password' ? 'Неверный пароль.' : 'Неверный код.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handlePhoneChange = (value: string) => {
    setPhone(formatPhone(value));
    setAuthMode('code');
    setCode('');
    setPassword('');
  };

  const handleRequestCode = async () => {
    setMessage(null);
    if (!phone.trim()) {
      setMessage('Введите номер телефона.');
      return;
    }

    setIsRequesting(true);
    try {
      const result = await requestAuthCode(phone.trim());
      if (result.requiresPassword) {
        setAuthMode('password');
        setMessage('Введите пароль администратора.');
        return;
      }
      setAuthMode('code');
      setMessage('Код отправлен. Проверьте консоль сервера.');
    } catch {
      setMessage('Не удалось отправить код.');
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
            : 'Код придет в консоль бэкенда. В проде подключим SMS.'}
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
            <button
              type="button"
              className="ghost-button"
              onClick={handleRequestCode}
              disabled={isRequesting}
            >
              {isRequesting ? 'Отправляем...' : 'Получить код'}
            </button>
          )}
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
            <button type="submit" className="primary-button" disabled={isVerifying}>
              {isVerifying ? 'Проверяем...' : 'Войти'}
            </button>
            <button type="button" className="ghost-button" onClick={closeAuthModal}>
              Отменить
            </button>
          </div>
          {message && <p className="status-text">{message}</p>}
        </form>
      </div>
    </div>
  );
};

export default AuthModal;
