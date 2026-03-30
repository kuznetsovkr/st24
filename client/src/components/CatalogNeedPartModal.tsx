import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { requestNeedPartCatalog } from '../api.ts';
import TurnstileWidget from './TurnstileWidget.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { formatPhone } from '../utils/formatPhone.ts';

type CatalogNeedPartModalProps = {
  open: boolean;
  onClose: () => void;
  categoryName?: string;
};

const MAX_IMAGES = 3;

const isCaptchaValidationError = (value: string) => {
  const normalized = value.toLowerCase();
  return normalized.includes('капч') || normalized.includes('captcha') || normalized.includes('проверк');
};

const CatalogNeedPartModal = ({ open, onClose, categoryName }: CatalogNeedPartModalProps) => {
  const { user } = useAuth();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

  const imagePreviews = useMemo(
    () => images.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [images]
  );

  useEffect(() => {
    return () => {
      imagePreviews.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [imagePreviews]);

  const resetForm = useCallback(() => {
    setFullName(user?.fullName ?? '');
    setPhone(formatPhone(user?.phone ?? ''));
    setProductQuery('');
    setImages([]);
    setAgreed(false);
    setCaptchaToken(null);
    setCaptchaResetKey((prev) => prev + 1);
    setIsSubmitting(false);
    setIsSubmitted(false);
    setError(null);
  }, [user]);

  useEffect(() => {
    if (!open) {
      return;
    }
    resetForm();
  }, [open, resetForm]);

  const handleCaptchaTokenChange = useCallback((token: string | null) => {
    setCaptchaToken(token);
    if (token) {
      setError((prev) => (prev === 'Подтвердите, что вы не робот.' ? null : prev));
    }
  }, []);

  if (!open) {
    return null;
  }

  const handleClose = () => {
    onClose();
  };

  const handleImagesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    if (picked.length === 0) {
      return;
    }
    setImages((prev) => {
      const merged = [...prev, ...picked];
      return merged.slice(0, MAX_IMAGES);
    });
    event.currentTarget.value = '';
  };

  const handleRemoveImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitted(false);

    if (!fullName.trim() || !phone.trim()) {
      setError('Заполните ФИО и номер телефона.');
      return;
    }
    if (!productQuery.trim()) {
      setError('Укажите название товара и доп. информацию.');
      return;
    }
    if (!agreed) {
      setError('Нужно согласиться с условиями и политикой.');
      return;
    }
    if (turnstileSiteKey && !captchaToken) {
      setError('Подтвердите, что вы не робот.');
      return;
    }

    const payload = new FormData();
    payload.append('fullName', fullName.trim());
    payload.append('phone', phone.trim());
    payload.append('productQuery', productQuery.trim());
    if (categoryName?.trim()) {
      payload.append('categoryName', categoryName.trim());
    }
    if (captchaToken) {
      payload.append('captchaToken', captchaToken);
    }
    images.forEach((file) => {
      payload.append('images', file);
    });

    setIsSubmitting(true);
    try {
      await requestNeedPartCatalog(payload);
      setIsSubmitted(true);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'Не удалось отправить заявку.';
      setError(message);
      if (turnstileSiteKey && isCaptchaValidationError(message)) {
        setCaptchaToken(null);
        setCaptchaResetKey((prev) => prev + 1);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <div
        className="modal-card modal-card--catalog-need-part"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">Нужна деталь</p>
            <h3>Запрос о наличии</h3>
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={handleClose}>
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
          <form className="stacked-form" onSubmit={handleSubmit}>
            {categoryName ? <p className="muted">Раздел: {categoryName}</p> : null}

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

            <label className="field">
              <span>Название товара и доп. информация</span>
              <textarea
                value={productQuery}
                onChange={(event) => setProductQuery(event.target.value)}
                rows={4}
                placeholder="Например: клапан для K5, нужен аналог, можно б/у"
                required
              />
            </label>

            <label className="field">
              <span>Фото (до 3)</span>
              <input type="file" accept="image/*" multiple onChange={handleImagesChange} />
            </label>

            {imagePreviews.length > 0 ? (
              <div className="need-part-images-preview" aria-label="Загруженные фото">
                {imagePreviews.map((item, index) => (
                  <div className="need-part-image-item" key={`${item.file.name}-${index}`}>
                    <img src={item.url} alt={`Фото ${index + 1}`} />
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => handleRemoveImage(index)}
                    >
                      Удалить
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>
                Согласен с <Link to="/terms" target="_blank" rel="noopener noreferrer">условиями оферты</Link> и{' '}
                <Link to="/privacy" target="_blank" rel="noopener noreferrer">политикой обработки персональных данных</Link>.
              </span>
            </label>

            {turnstileSiteKey && (
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                action="request_need_part"
                resetKey={captchaResetKey}
                onTokenChange={handleCaptchaTokenChange}
              />
            )}

            {error && <p className="status-text status-text--error">{error}</p>}

            <div className="modal-actions">
              <button className="primary-button" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Отправляем...' : 'Отправить заявку'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default CatalogNeedPartModal;

