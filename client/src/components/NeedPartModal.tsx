import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { requestNeedPart } from '../api.ts';
import { useAuth } from '../context/AuthContext.tsx';
import { useUI } from '../context/UIContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';

const NeedPartModal = () => {
  const { needPartModal, closeNeedPartModal } = useUI();
  const { user } = useAuth();
  const product = needPartModal.product;
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!needPartModal.open) {
      return;
    }
    setFullName(user?.fullName ?? '');
    setPhone(formatPhone(user?.phone ?? ''));
    setAgreed(false);
    setMessage(null);
    setError(null);
  }, [needPartModal.open, user]);

  if (!needPartModal.open || !product) {
    return null;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!fullName.trim() || !phone.trim()) {
      setError('Заполните ФИО и номер телефона.');
      return;
    }
    if (!agreed) {
      setError('Нужно согласиться с условиями и политикой.');
      return;
    }

    setIsSubmitting(true);
    try {
      await requestNeedPart({
        productId: product.id,
        fullName: fullName.trim(),
        phone: phone.trim()
      });
      setMessage('Заявка отправлена. Мы свяжемся с вами.');
    } catch (submitError) {
      if (submitError instanceof Error) {
        setError(submitError.message);
      } else {
        setError('Не удалось отправить заявку.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={closeNeedPartModal}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Нужна деталь</p>
            <h3>Запрос по товару</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={closeNeedPartModal}>
            x
          </button>
        </div>
        <p className="muted">
          Товар: {product.name}
          {product.sku ? ` · SKU ${product.sku}` : ''}
        </p>
        <form className="stacked-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>ФИО</span>
            <input
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Иванов Иван Иванович"
              required
            />
          </label>
          <label className="field">
            <span>Телефон</span>
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(formatPhone(event.target.value))}
              placeholder="+7"
              required
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <span>
              Согласен с <Link to="/terms">условиями оферты</Link> и{' '}
              <Link to="/privacy">политикой обработки персональных данных</Link>.
            </span>
          </label>
          {message && <p className="status-text">{message}</p>}
          {error && <p className="status-text status-text--error">{error}</p>}
          <div className="modal-actions">
            <button className="primary-button" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Отправляем...' : 'Отправить заявку'}
            </button>
            <button type="button" className="ghost-button" onClick={closeNeedPartModal}>
              Отменить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NeedPartModal;
