import { useState, type FormEvent } from 'react';
import { requestB2BInquiry } from '../api';
import { formatPhone } from '../utils/formatPhone.ts';

const B2BPage = () => {
  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [comment, setComment] = useState('');
  const [enterpriseCard, setEnterpriseCard] = useState<File | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = () => {
    setCompanyName('');
    setContactPerson('');
    setPhone('');
    setEmail('');
    setComment('');
    setEnterpriseCard(null);
    setError('');
    setIsSubmitted(false);
    setIsSubmitting(false);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setIsSubmitted(false);

    if (!companyName.trim()) {
      setError('Укажите ФИО или название компании.');
      return;
    }

    if (!phone.trim()) {
      setError('Укажите телефон для связи.');
      return;
    }

    const payload = new FormData();
    payload.append('companyName', companyName.trim());
    payload.append('contactPerson', contactPerson.trim());
    payload.append('phone', phone.trim());
    payload.append('email', email.trim());
    payload.append('comment', comment.trim());
    if (enterpriseCard) {
      payload.append('enterpriseCard', enterpriseCard);
    }

    setIsSubmitting(true);
    try {
      await requestB2BInquiry(payload);
      setIsSubmitted(true);
      setCompanyName('');
      setContactPerson('');
      setPhone('');
      setEmail('');
      setComment('');
      setEnterpriseCard(null);
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
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Для юридических лиц</p>
          <h1>B2B-заявка</h1>
          <p className="muted">Оставьте данные компании, и мы подготовим предложение.</p>
        </div>
      </header>

      <div className="card">
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
            <button type="button" className="ghost-button" onClick={resetForm}>
              Заполнить новую заявку
            </button>
          </div>
        ) : (
          <form className="stacked-form" onSubmit={handleSubmit}>
            <div className="form-grid">
              <label className="field">
                <span>ФИО или название компании</span>
                <input
                  type="text"
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder="ООО Пример / Иванов Иван Иванович"
                  required
                />
              </label>
              <label className="field">
                <span>Контактное лицо</span>
                <input
                  type="text"
                  value={contactPerson}
                  onChange={(event) => setContactPerson(event.target.value)}
                  placeholder="Имя менеджера"
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
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="mail@example.com"
                />
              </label>
            </div>

            <label className="field">
              <span>Карточка предприятия (файл)</span>
              <input
                type="file"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setEnterpriseCard(file);
                }}
              />
              <span className="form-help">
                PDF, DOC, DOCX, XLS, XLSX, JPG, PNG. Максимальный размер: 10 МБ.
              </span>
            </label>

            <label className="field">
              <span>Комментарий</span>
              <textarea
                rows={4}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Уточнения по заявке"
              />
            </label>

            {error ? <p className="status-text status-text--error">{error}</p> : null}

            <div className="button-row">
              <button className="primary-button" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Отправляем...' : 'Отправить запрос'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default B2BPage;
