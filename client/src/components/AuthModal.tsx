import { useState } from 'react';
import type { FormEvent } from 'react';
import { useUI } from '../context/UIContext.tsx';

const AuthModal = () => {
  const { authModalOpen, closeAuthModal } = useUI();
  const [phone, setPhone] = useState('');

  if (!authModalOpen) {
    return null;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    // TODO: wire up SMS/OTP flow
    closeAuthModal();
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
            x
          </button>
        </div>
        <p className="muted">
          Заготовка для потока авторизации по СМС. Дальше подключим отправку кода и проверку.
        </p>
        <form className="stacked-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Телефон</span>
            <input
              type="tel"
              placeholder="+7"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </label>
          <div className="modal-actions">
            <button type="submit" className="primary-button">
              Получить код
            </button>
            <button type="button" className="ghost-button" onClick={closeAuthModal}>
              Отменить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AuthModal;
