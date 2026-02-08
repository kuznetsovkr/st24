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
  const [message, setMessage] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  if (!authModalOpen) {
    return null;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (!phone.trim() || !code.trim()) {
      setMessage('Введите телефон и код.');
      return;
    }

    setIsVerifying(true);
    try {
      const result = await verifyAuthCode(phone.trim(), code.trim());
      setAuthToken(result.token);
      setUser(result.user);
      await mergeWithServer();
      closeAuthModal();
    } catch {
      setMessage('Неверный код.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleRequestCode = async () => {
    setMessage(null);
    if (!phone.trim()) {
      setMessage('Введите номер телефона.');
      return;
    }

    setIsRequesting(true);
    try {
      await requestAuthCode(phone.trim());
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
        <p className="muted">Код придет в консоль бэкенда. В проде подключим SMS.</p>
        <form className="stacked-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Телефон</span>
            <input
              type="tel"
              placeholder="+7"
              value={phone}
              onChange={(event) => setPhone(formatPhone(event.target.value))}
              required
            />
          </label>
          <button
            type="button"
            className="ghost-button"
            onClick={handleRequestCode}
            disabled={isRequesting}
          >
            {isRequesting ? 'Отправляем...' : 'Получить код'}
          </button>
          <label className="field">
            <span>Код</span>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
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
