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
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('');
    setError('');

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
      setStatus('Заявка отправлена. Мы свяжемся с вами.');
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

          {status ? <p className="status-text">{status}</p> : null}
          {error ? <p className="status-text status-text--error">{error}</p> : null}

          <div className="button-row">
            <button className="primary-button" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Отправляем...' : 'Отправить запрос'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default B2BPage;
