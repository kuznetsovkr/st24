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
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!needPartModal.open) {
      return;
    }
    setFullName(user?.fullName ?? '');
    setPhone(formatPhone(user?.phone ?? ''));
    setAgreed(false);
    setIsSubmitted(false);
    setError(null);
    setIsSubmitting(false);
  }, [needPartModal.open, user]);

  if (!needPartModal.open || !product) {
    return null;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitted(false);
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
      setIsSubmitted(true);
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

        {isSubmitted ? (
          <div className="need-part-success" role="status" aria-live="polite">
            <div className="need-part-success-icon" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="17" height="13" viewBox="0 0 17 13" fill="none">
                <path
                  className="need-part-success-check"
                  d="M16.5 0.5L5.3 12.5L0.5 8"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <p className="status-text need-part-success-text">Заявка отправлена. Мы свяжемся с вами.</p>
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
};

export default NeedPartModal;
